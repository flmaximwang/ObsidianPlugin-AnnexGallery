import { spawnSync } from "child_process";
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

export function isInsideWorkTree(dir: string): boolean {
  const r = git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** True when `dir` is the *root* of a git work tree (not a subdirectory of one). */
export function isRepoRoot(dir: string): boolean {
  const r = git(["rev-parse", "--show-toplevel"], dir);
  return r.code === 0 && path.resolve(r.stdout.trim()) === path.resolve(dir);
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
