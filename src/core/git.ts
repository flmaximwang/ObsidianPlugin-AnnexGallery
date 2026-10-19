import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 子进程 PATH 末尾补上的可执行目录（只补真正存在的）。
 *
 * 从 Finder / Dock 启动的 Obsidian 继承的是 launchd 的环境：本机实测主进程
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`（`ps -Eww -p <pid>`），Homebrew 的
 * `/opt/homebrew/bin` 不在里面。`git` 本身还能找到（`/usr/bin/git`），但 `git annex`
 * 是 **git 去 PATH 里找 `git-annex`**：找不到就退化成
 * `git: 'annex' is not a git command. See 'git --help'.`（exit 1），状态栏于是只剩一句
 * 「无法统计」。见 `issues/git-annex-not-on-gui-path_2026.10.19.md`。
 *
 * **追加，不前置**：`/usr/bin/git`（Apple Git）继续胜出，补进去的只是「PATH 里原本
 * 根本没有的目录」；从终端启动时（这些目录已在 PATH 里）结果逐字节不变。
 */
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  "~/.local/bin",
  "~/bin",
];

/** 连 PATH 都没有时的起点（与 launchd 的默认值一致）。 */
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

/**
 * 把 {@link EXTRA_BIN_DIRS}（以及 `ANNEX_GALLERY_EXTRA_PATH`，`path.delimiter` 分隔）
 * 追加到 PATH 后面，已有的目录不重复加。
 *
 * `ANNEX_GALLERY_NO_PATH_FIX=1` 时原样返回 —— 验证脚本用它复现「GUI 里找不到
 * git-annex」那一档，确认修复确实起作用，而不是碰巧。
 */
export function withBinaryDirs(pathValue: string | undefined): string {
  const base = pathValue === undefined || pathValue.trim() === "" ? FALLBACK_PATH : pathValue;
  const parts = base.split(path.delimiter).filter((entry) => entry !== "");
  if (process.env.ANNEX_GALLERY_NO_PATH_FIX === "1") return parts.join(path.delimiter);
  const seen = new Set(parts);
  const configured = `${process.env.ANNEX_GALLERY_EXTRA_PATH ?? ""}`.split(path.delimiter);
  for (const raw of [...EXTRA_BIN_DIRS, ...configured]) {
    if (raw === "") continue;
    const dir = expandHome(raw);
    if (seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(path.delimiter);
}

/**
 * Environment for every child process.
 *
 * This machine routes through a local Clash-style proxy (127.0.0.1:7890) that
 * is often not running: with HTTP(S)_PROXY set, git/annex fail *silently*.
 * Every subprocess we start therefore gets a proxy-free environment.
 *
 * PATH 也在这里补（见 {@link withBinaryDirs}）：GUI 启动的 Obsidian 只有 launchd 的
 * 极小 PATH，`git annex` 会找不到 `git-annex`。
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
  env.PATH = withBinaryDirs(env.PATH);
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
