import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { cleanEnv } from "./git";

/**
 * 状态栏那一行的**核心**（没有 Obsidian import，所以 CLI / 工具也能用）。
 *
 * 口径（用户 2026-10-17 追问确认，见 docs/status-bar.md）：
 *
 *   1. 范围 = **整个 vault**，即「当前窗口打开的那个 vault」所在的那个 git 仓库
 *      （`git rev-parse --show-toplevel`；vault 通常就是仓库根）。一个总数，不按文件夹拆。
 *   2. 「未提交」= 已跟踪文件的改动，`git status --porcelain -uall` 里非 `??` 的**行数**
 *      （staged + unstaged 都算一行；`MM` 也只算一行）。
 *   3. 「未跟踪」= 同一份输出里 `??` 的**行数**。用 `-uall` 才是「一个文件一行」
 *      —— 默认的 `-unormal` 会把整个未跟踪目录压成 `dir/` 一行。
 *   4. 「未入库 largefiles」= `git annex add --dry-run --json` 里**会进 annex** 的文件数：
 *      note 里带 `git repository` 的（`non-large file` / `dotfile`）进的是 git，
 *      不算；其余（含 `.tif` / `.png` / `metadata.json` 这类按 `* annex.largefiles=anything`
 *      入 annex 的）才算。**注意它列的是「还没 add 进 index 的文件」**，所以已跟踪但改过
 *      还没重新 add 的大文件也会被列进来 —— 这正是「未入库」的本意。
 */

/** 刷新间隔（毫秒）。用户口径：30 秒轮询 + 状态栏上点一下立即刷新。 */
export const STATUS_REFRESH_MS = 30_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 命令本身不存在（ENOENT）—— 与「命令跑了但退出码非 0」区分开。 */
  missing: boolean;
}

/**
 * 异步版 `git.ts` 的 `run()`。
 *
 * 这里**故意**不用 `spawnSync`：状态栏是 30 秒一次的常驻刷新，而真实 vault 上
 * `git status` 要 ~2 秒、`git annex add --dry-run` 再 ~2 秒（实测见 docs/status-bar.md）。
 * 同步版会把 Obsidian 的渲染进程钉住 4 秒 —— 一个状态栏数字不值得让界面卡住。
 */
export function execAsync(cmd: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: cleanEnv(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          code,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: `${typeof stderr === "string" ? stderr : ""}${
            error !== null && error.code === "ENOENT" ? `找不到命令：${cmd}` : ""
          }`,
          missing: error !== null && error.code === "ENOENT",
        });
      },
    );
  });
}

export type StatusLevel = "zero" | "dirty" | "uninitialized" | "unavailable";

export interface RepoStatus {
  /** 统计起点：vault 根的绝对路径。 */
  dir: string;
  /** vault 所在 git 仓库的根（绝对路径）；不是 git 仓库时为 null。 */
  repoRoot: string | null;
  /** zero = 三项全 0、dirty = 有数、uninitialized = 还没 init、unavailable = 命令不可用/报错。 */
  level: StatusLevel;
  /** 「未提交」：已跟踪文件的改动行数。 */
  commitsPending: number;
  /** 「未跟踪」：`??` 的文件数。 */
  untracked: number;
  /** 「未入库 largefiles」：会进 annex 的待入库文件数；null = 这次没算出来。 */
  largefiles: number | null;
  /** 给用户看的一句话原因（unavailable / uninitialized 时非空）。 */
  detail: string;
}

/** 一行 note 压成一句人话（git / annex 的 note 常带换行）。 */
export function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** `git status --porcelain -uall` → 已跟踪改动行数 / 未跟踪文件数。 */
export function classifyPorcelain(stdout: string): { tracked: number; untracked: number } {
  let tracked = 0;
  let untracked = 0;
  for (const line of stdout.split(/\r?\n/)) {
    // 空行与 `#` 开头的头（`--branch` 才会出现）都跳过；`!!` 只在 `--ignored` 下出现。
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (line.startsWith("??")) untracked += 1;
    else tracked += 1;
  }
  return { tracked, untracked };
}

/**
 * `git annex add --dry-run --json` → 会进 annex 的文件数。
 *
 * 判据只有 `note` 里有没有 `git repository`：git-annex 对「进 git」的两种情形给
 * `non-large file; adding content to git repository` 与 `dotfile; adding content to
 * git repository`（实测见 docs/status-bar.md），对「进 annex」的文件**不给 note**。
 * 所以反过来判（没有这句就计数）比列举 annex 侧的文案更耐版本变化。
 */
export function countPendingLargefiles(stdout: string): number {
  let count = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: { file?: unknown; note?: unknown };
    try {
      row = JSON.parse(trimmed) as { file?: unknown; note?: unknown };
    } catch {
      continue; // annex 偶尔混进来的非 JSON 行（进度 / 警告）
    }
    if (typeof row.file !== "string" || row.file === "") continue;
    const note = typeof row.note === "string" ? row.note : "";
    if (note.includes("git repository")) continue;
    count += 1;
  }
  return count;
}

/** 造一条「用不上」的状态（命令缺失 / 报错），供 UI 与测试共用。 */
export function unavailableStatus(dir: string, detail: string, repoRoot: string | null = null): RepoStatus {
  return { dir, repoRoot, level: "unavailable", commitsPending: 0, untracked: 0, largefiles: null, detail };
}

/** 造一条「还没初始化」的状态。 */
export function uninitializedStatus(dir: string, detail: string, repoRoot: string | null = null): RepoStatus {
  return { dir, repoRoot, level: "uninitialized", commitsPending: 0, untracked: 0, largefiles: null, detail };
}

/** `<git-dir>/annex` 存在 = git-annex 仓库（与 `git.ts` 的 isAnnexRepo 同一判据，异步版）。 */
async function annexGitDir(repoRoot: string): Promise<string | null> {
  const result = await execAsync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"]);
  if (result.code !== 0) return null;
  const gitDir = result.stdout.trim();
  if (gitDir === "") return null;
  return fs.existsSync(path.join(gitDir, "annex")) ? gitDir : null;
}

/**
 * 读一次状态。**不会抛异常**：拿不到的东西都写进 `detail`，让状态栏自己说明原因
 * （用户口径：不是仓库 / 没装 git-annex 时要写明原因，点击可去初始化）。
 */
export async function readRepoStatus(dir: string): Promise<RepoStatus> {
  const top = await execAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  if (top.missing) {
    return unavailableStatus(dir, "找不到 git 命令（请先安装 git）");
  }
  if (top.code !== 0) {
    return uninitializedStatus(dir, "不是 git 仓库（未初始化）");
  }
  const repoRoot = top.stdout.trim() === "" ? dir : top.stdout.trim();

  const gitDir = await annexGitDir(repoRoot);
  if (gitDir === null) {
    return uninitializedStatus(repoRoot, "不是 git-annex 仓库（未初始化 annex）", repoRoot);
  }

  const status = await execAsync("git", ["-C", repoRoot, "status", "--porcelain", "-uall"]);
  if (status.missing) {
    return unavailableStatus(repoRoot, "找不到 git 命令（请先安装 git）", repoRoot);
  }
  if (status.code !== 0) {
    return unavailableStatus(repoRoot, `git status 失败：${firstLine(status.stderr) || `退出码 ${status.code}`}`, repoRoot);
  }
  const { tracked, untracked } = classifyPorcelain(status.stdout);

  const dry = await execAsync("git", ["-C", repoRoot, "annex", "add", "--dry-run", "--json"]);
  if (dry.missing) {
    const base = unavailableStatus(repoRoot, "找不到 git-annex 命令（brew install git-annex）", repoRoot);
    return { ...base, commitsPending: tracked, untracked };
  }
  if (dry.code !== 0) {
    const base = unavailableStatus(repoRoot, `git annex add --dry-run 失败：${firstLine(dry.stderr) || `退出码 ${dry.code}`}`, repoRoot);
    return { ...base, commitsPending: tracked, untracked };
  }
  const largefiles = countPendingLargefiles(dry.stdout);

  return {
    dir: repoRoot,
    repoRoot,
    level: tracked === 0 && untracked === 0 && largefiles === 0 ? "zero" : "dirty",
    commitsPending: tracked,
    untracked,
    largefiles,
    detail: "",
  };
}

/** 状态栏那一行的文字（`未提交 … · 未跟踪 … · 未入库 largefiles …`）。 */
export function statusText(status: RepoStatus): string {
  if (status.level === "uninitialized") return "未初始化 · 点击初始化 gallery";
  if (status.level === "unavailable") return `无法统计：${status.detail}`;
  const pending = status.largefiles === null ? "?" : String(status.largefiles);
  return `未提交 ${status.commitsPending} · 未跟踪 ${status.untracked} · 未入库 largefiles ${pending}`;
}

/** 悬停提示：把口径、范围、刷新方式一次写清（状态栏本身放不下）。 */
export function statusTooltip(status: RepoStatus): string {
  const lines: string[] = [];
  if (status.repoRoot !== null) lines.push(`仓库：${status.repoRoot}`);
  if (status.level === "unavailable" || status.level === "uninitialized") {
    lines.push(status.detail);
    lines.push(
      status.level === "uninitialized"
        ? `点击这一行 → 初始化 gallery · 每 ${STATUS_REFRESH_MS / 1000} 秒自动刷新`
        : `点击这一行 → 重新统计 · 每 ${STATUS_REFRESH_MS / 1000} 秒自动刷新`,
    );
    return lines.join("\n");
  }
  lines.push("未提交：已跟踪文件的改动（staged + unstaged），= git status --porcelain -uall 的行数");
  lines.push("未跟踪：同一份输出里 ?? 开头的文件数（一个文件一行）");
  lines.push(
    "未入库 largefiles：git annex add --dry-run 里会进 annex 的文件数（.md / .thumbnail.png / .base 按 .gitattributes 进 git，不算）",
  );
  lines.push(`每 ${STATUS_REFRESH_MS / 1000} 秒自动刷新 · 点击这一行立即刷新`);
  return lines.join("\n");
}
