import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Environment for every child process.
 *
 * This machine routes through a local Clash-style proxy (127.0.0.1:7890) that
 * is often not running: with HTTP(S)_PROXY set, git/annex fail *silently*.
 * Every subprocess we start therefore gets a proxy-free environment.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "HTTP_PROXY" || upper === "HTTPS_PROXY" || upper === "ALL_PROXY" || upper === "PROXY") {
      delete env[key];
    }
  }
  delete env.no_proxy;
  delete env.NO_PROXY;
  return env;
}

export function run(cmd: string, args: string[], cwd?: string): RunResult {
  const res = spawnSync(cmd, args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const failed = res.error !== undefined && res.status === null;
  return {
    code: res.status === null ? (failed ? -1 : 1) : res.status,
    stdout: res.stdout ?? "",
    stderr: `${res.stderr ?? ""}${failed ? String(res.error?.message ?? "") : ""}`,
  };
}

/** `git -C <dir> …` — always anchored, never depends on the caller's cwd. */
export function git(args: string[], dir: string): RunResult {
  return run("git", ["-C", dir, ...args]);
}

/**
 * 流式跑一条命令：每读到一个完整行回调一次（stdout）。
 *
 * 长命令必须走这条：`git annex get` 从远端取 GB 级内容要几分钟，而 `run()` 是
 * `spawnSync` —— 在插件里会把 Obsidian 的整个 UI 冻住。stderr 只累积到结果里
 * （annex 的进度/结果都在 stdout 的 JSON 行里）。
 */
export function runStream(
  cmd: string,
  args: string[],
  dir: string | undefined,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, env: cleanEnv(), encoding: "utf8" } as never);
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (onLine !== undefined && line.trim() !== "") onLine(line);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code: number | null) => {
      for (const line of pending.split("\n")) {
        if (onLine !== undefined && line.trim() !== "") onLine(line);
      }
      resolve({ code: code === null ? 1 : code, stdout, stderr });
    });
  });
}

/** 流式的 `git -C <dir> …`。 */
export function gitStream(
  args: string[],
  dir: string,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return runStream("git", ["-C", dir, ...args], undefined, onLine);
}

/**
 * 目录所属仓库的根 + 该目录相对根的路径（`""` = 仓库根）。
 *
 * 子路径**交给 git 自己算**（`rev-parse --show-prefix`），绝不用 `path.relative(repoRoot, dir)`：
 * macOS 上 `/var` 与 `/private/var` 是同一目录的两种写法，`path.relative` 会把二者当成毫不相干，
 * 算出 `../../../../var/…` —— 传给 git/annex 就是 `fatal: … is outside repository`（实测踩过）。
 */
export function repoScope(dir: string): { repoRoot: string; relpath: string } {
  const top = git(["rev-parse", "--show-toplevel"], dir);
  const repoRoot = top.code === 0 ? top.stdout.trim() : dir;
  const prefix = git(["rev-parse", "--show-prefix"], dir);
  const relpath = prefix.code === 0 ? prefix.stdout.trim().replace(/\/+$/, "") : "";
  return { repoRoot, relpath };
}

/** 目录里某文件相对仓库根的 posix 路径（用于把本地绝对路径翻译给 annex）。 */
export function repoRelativePath(repoRelpath: string, dir: string, file: string): string {
  const rel = path.relative(dir, file).split(path.sep).join("/");
  return repoRelpath === "" ? rel : `${repoRelpath}/${rel}`;
}

export function isInsideWorkTree(dir: string): boolean {
  const r = git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** macOS /tmp is a symlink to /private/tmp, so a plain path.resolve() on both
 *  sides makes the comparison fail; compare realpaths instead. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `dir` is the *root* of a git work tree (not a subdirectory of one). */
export function isRepoRoot(dir: string): boolean {
  const r = git(["rev-parse", "--show-toplevel"], dir);
  return r.code === 0 && realPath(r.stdout.trim()) === realPath(dir);
}

export function gitDirOf(dir: string): string | null {
  const r = git(["rev-parse", "--git-dir"], dir);
  if (r.code !== 0) return null;
  const raw = r.stdout.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
}

export function isAnnexRepo(dir: string): boolean {
  const gitDir = gitDirOf(dir);
  if (gitDir === null) return false;
  return fs.existsSync(path.join(gitDir, "annex"));
}

export function statusPorcelain(dir: string, paths: string[] = []): string {
  const r = git(["status", "--porcelain", ...(paths.length > 0 ? ["--", ...paths] : [])], dir);
  return r.code === 0 ? r.stdout : "";
}

/** ImageMagick 7 (`magick`). Homebrew on this machine; overridable for tests. */
export function magickBinary(): string {
  const override = process.env.ANNEX_GALLERY_MAGICK;
  if (override !== undefined && override !== "") return override;
  for (const candidate of ["/opt/homebrew/bin/magick", "/usr/local/bin/magick"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "magick";
}
