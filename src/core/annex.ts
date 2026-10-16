import * as path from "path";
import { git, gitStream, isAnnexRepo, repoRelativePath, repoScope } from "./git";
import { collectImages } from "./stems";
import { Progress } from "./types";

/**
 * git-annex 的「largefiles 操作」核心（不依赖 Obsidian，插件与 CLI 共用）。
 *
 * 一律用 `--json`（+ `get` 用 `--json-progress`）来判定结果，因为**annex 的退出码不可信**：
 * 实测 `git annex drop` 全失败时退出码仍是 0，`drop: 1 failed` 只在 stderr。
 * 另外 annex 对「不需要动」的文件**不输出任何行**（例如 unlock 一个已解锁的文件），
 * 所以统计口径是「annex 真的报了动作的文件」。
 */

export type AnnexOp = "add" | "unlock" | "lock" | "get" | "unannex" | "drop";

/** 菜单项标题（用户 2026-10-17 口径，英文沿用他的命名）。 */
export const ANNEX_OP_TITLE: Record<AnnexOp, string> = {
  add: "Add largefiles to Annex",
  unlock: "Unlock largefiles",
  lock: "Lock largefiles",
  get: "Get largefiles",
  unannex: "Unlock & unannex largefiles",
  drop: "Drop largefiles",
};

export interface AnnexOpOptions {
  progress?: Progress;
}

export interface AnnexEntry {
  file: string;
  action: "ok" | "skipped" | "failed";
  detail?: string;
}

export interface AnnexReport {
  op: AnnexOp;
  /** 被右键的目录（绝对路径）。 */
  dir: string;
  repoRoot: string;
  /** 该目录相对仓库根的路径（`""` = 仓库根）。 */
  relpath: string;
  /** annex 逐文件报「成功」的份数。 */
  ok: number;
  /** 被挡下/没做的份数（目前只有 drop 会报：别处没有足够副本）。 */
  skipped: number;
  failed: number;
  entries: AnnexEntry[];
  /** add：候选图片数；get：本地缺内容的份数（预估要下载多少）。 */
  candidates?: number;
  /** unannex：随后 `git annex add --force-small` 回索引的份数。 */
  staged?: number;
  /** drop：真正释放的字节数。 */
  bytesFreed?: number;
}

/** annex 的一条 `--json` 结果行（只取我们用到的字段）。 */
interface AnnexJsonLine {
  command?: string;
  file?: string;
  success?: boolean;
  note?: string;
  /** `--json-progress` 的进度行：`{"action":{…},"byte-progress":…,"percent-progress":"…"}` */
  action?: { command?: string; file?: string };
  "percent-progress"?: string;
}

/** 一次 annex 调用最多带多少个路径参数（避免 argv 长度爆掉）。 */
const PATH_CHUNK = 200;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0];
  if (line === undefined) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 把 annex 的 stdout 解析成 JSON 行（非 JSON 行——annex 偶尔的告警——直接跳过）。 */
function parseAnnexLines(stdout: string): AnnexJsonLine[] {
  const rows: AnnexJsonLine[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || !line.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(line) as AnnexJsonLine);
    } catch {
      // 半行/非 JSON：忽略，不影响逐文件判定。
    }
  }
  return rows;
}

/** 仓库根 + annex 判定；不是 annex 仓库时报一句能照做的错。 */
export function resolveAnnexRepo(dir: string): { repoRoot: string; relpath: string } {
  const { repoRoot, relpath } = repoScope(dir);
  const inside = git(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(`${dir} 不是 git 仓库（先跑「初始化 gallery」）`);
  }
  if (!isAnnexRepo(repoRoot)) {
    throw new Error(`${repoRoot} 不是 git-annex 仓库（先跑「初始化 gallery」，或确认 annex 已 init）`);
  }
  return { repoRoot, relpath };
}

function describe(line: AnnexJsonLine, fallback: string): string {
  const note = firstLine(line.note ?? "");
  return note === "" ? fallback : note;
}

/** 逐文件结果行 → report 计数（`command` + `file` 的那一类行）。 */
function collectResultLines(rows: AnnexJsonLine[], entries: AnnexEntry[]): void {
  for (const row of rows) {
    if (row.file === undefined || row.success === undefined) continue;
    if (row.success) {
      entries.push({ file: row.file, action: "ok", detail: firstLine(row.note ?? "") || undefined });
    } else {
      entries.push({ file: row.file, action: "failed", detail: describe(row, "annex 报失败（无说明）") });
    }
  }
}

function reportFrom(op: AnnexOp, dir: string, repoRoot: string, relpath: string, entries: AnnexEntry[]): AnnexReport {
  return {
    op,
    dir,
    repoRoot,
    relpath,
    ok: entries.filter((entry) => entry.action === "ok").length,
    skipped: entries.filter((entry) => entry.action === "skipped").length,
    failed: entries.filter((entry) => entry.action === "failed").length,
    entries,
  };
}

/** `git annex find --not --in=here`：这些 annex 文件本地没有内容（get 的目标）。 */
function countContentMissing(repoRoot: string, relpath: string): number {
  const scope = relpath === "" ? [] : ["--", relpath];
  const result = git(["annex", "find", "--not", "--in=here", "--format=${file}\\n", ...scope], repoRoot);
  if (result.code !== 0) return 0;
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

/** 一条 annex 命令的公共形状：`git annex <op> --json [extra] --json-error-messages -- <scope>`。 */
function annexArgs(op: string, extra: string[], scope: string[]): string[] {
  return ["annex", op, ...extra, "--json", "--json-error-messages", ...scope];
}

/**
 * 跑一个 largefiles 操作。除 `drop`（见 `dropLargefiles`，它有预览/字节数语义）外都在这里。
 *
 * - `add`：只对**这个目录里的图片**（`collectImages`，已排除 `.thumbnail.png`）跑 `git annex add`。
 *   这样不会顺手把 `.DS_Store` 之类的东西也 `git add` 进去；annex 仍按 `.gitattributes` 的
 *   `annex.largefiles` 决定每个文件进 annex 还是进 git。
 * - `unlock` / `lock` / `get`：对整个子树跑，annex 自己会跳过不需要动的文件（它们不产生输出行）。
 * - `unannex`：先 `unlock` 再 `unannex`，最后把这些文件 `git add` 回索引 —— annex 的 `unannex`
 *   会把文件从 index 里移除、内容留在工作树（此时它们是**未跟踪**文件，`git clean` 一下就没），
 *   所以必须补一步 `git add` 才算「退回普通 git 文件」。
 */
export async function runAnnexOp(op: AnnexOp, dir: string, opts: AnnexOpOptions = {}): Promise<AnnexReport> {
  if (op === "drop") {
    const drop = await dropLargefiles(dir, { progress: opts.progress });
    const entries: AnnexEntry[] = drop.entries.map((entry) => ({
      file: entry.file,
      action: entry.action === "failed" ? "failed" : entry.action === "skipped" ? "skipped" : "ok",
      detail: entry.detail,
    }));
    return { ...reportFrom("drop", dir, drop.repoRoot, drop.relpath, entries), bytesFreed: drop.bytesFreed, candidates: drop.present };
  }

  const { repoRoot, relpath } = resolveAnnexRepo(dir);
  const progress: Progress = opts.progress ?? ((): void => {});
  const scope = relpath === "" ? [] : ["--", relpath];
  const entries: AnnexEntry[] = [];

  if (op === "add") {
    const images = collectImages(dir).map((file) => repoRelativePath(relpath, dir, file));
    const chunks = chunked(images, PATH_CHUNK);
    progress(`${ANNEX_OP_TITLE.add}：${images.length} 张图待处理（${chunks.length} 批）`);
    const rows: AnnexJsonLine[] = [];
    for (const batch of chunks) {
      const result = await gitStream(
        ["annex", "add", "--json", "--json-error-messages", "--", ...batch],
        repoRoot,
        (line) => {
          for (const row of parseAnnexLines(line)) {
            if (row.file !== undefined) progress(`${ANNEX_OP_TITLE.add}：${path.basename(row.file)}`);
          }
        },
      );
      rows.push(...parseAnnexLines(result.stdout));
    }
    collectResultLines(rows, entries);
    const report = reportFrom("add", dir, repoRoot, relpath, entries);
    return { ...report, candidates: images.length };
  }

  if (op === "get") {
    const candidates = countContentMissing(repoRoot, relpath);
    progress(`${ANNEX_OP_TITLE.get}：本地缺内容 ${candidates} 个`);
    const rows: AnnexJsonLine[] = [];
    const result = await gitStream(annexArgs("get", ["--json-progress"], scope), repoRoot, (line) => {
      for (const row of parseAnnexLines(line)) {
        if (row.action?.file !== undefined) {
          const percent = row["percent-progress"];
          progress(`${ANNEX_OP_TITLE.get}：取 ${path.basename(row.action.file)}${percent === undefined ? "" : ` ${percent}`}`);
        }
      }
    });
    rows.push(...parseAnnexLines(result.stdout));
    collectResultLines(rows, entries);
    const report = reportFrom("get", dir, repoRoot, relpath, entries);
    return { ...report, candidates };
  }

  if (op === "unlock" || op === "lock") {
    const result = await gitStream(annexArgs(op, [], scope), repoRoot, (line) => {
      for (const row of parseAnnexLines(line)) {
        if (row.file !== undefined && row.success === true) progress(`${ANNEX_OP_TITLE[op]}：${path.basename(row.file)}`);
      }
    });
    collectResultLines(parseAnnexLines(result.stdout), entries);
    return reportFrom(op, dir, repoRoot, relpath, entries);
  }

  // unannex = unlock → unannex → 用 `git annex add --force-small` 把它们交回 git
  //
  // 最后一步**不能**用普通 `git add`：`git annex init` 会写 `.git/info/attributes` 的 `* filter=annex`
  // 并注册 `filter.annex.clean = git-annex smudge --clean`，于是普通 `git add` 会被 annex 的 clean
  // filter 截住、**把文件重新 annex 回去**（实测：提交后 HEAD 里落的是 100 字节指针，unannex 成了假动作）。
  // `git annex add --force-small` 才是「按普通 git 文件暂存」的正解（实测提交后 HEAD blob = 原文件大小）。
  const unlocked = await gitStream(annexArgs("unlock", [], scope), repoRoot);
  void unlocked;
  const result = await gitStream(annexArgs("unannex", [], scope), repoRoot, (line) => {
    for (const row of parseAnnexLines(line)) {
      if (row.file !== undefined && row.success === true) progress(`${ANNEX_OP_TITLE.unannex}：${path.basename(row.file)}`);
    }
  });
  const rows = parseAnnexLines(result.stdout);
  collectResultLines(rows, entries);
  const released = rows.filter((row) => row.success === true && row.file !== undefined).map((row) => row.file as string);
  let staged = 0;
  for (const batch of chunked(released, PATH_CHUNK)) {
    const added = git(["annex", "add", "--force-small", "--json", "--json-error-messages", "--", ...batch], repoRoot);
    const addedRows = parseAnnexLines(added.stdout);
    staged += addedRows.filter((row) => row.success === true).length;
    if (addedRows.length === 0 && added.code !== 0) {
      progress(`${ANNEX_OP_TITLE.unannex}：git annex add --force-small 失败（${firstLine(added.stderr)}）`);
    }
  }
  if (released.length > 0) {
    progress(`${ANNEX_OP_TITLE.unannex}：${released.length} 个已退出 annex，其中 ${staged} 个已按普通 git 文件暂存（还需一次 commit）`);
  }
  const report = reportFrom(op, dir, repoRoot, relpath, entries);
  return { ...report, staged };
}

// ── Drop largefiles（带预览与字节数，语义与其它操作不同，所以另起一份）──────────

export interface DropOptions {
  /**
   * 只统计、不真丢。
   *
   * `git annex drop` **没有** `--dry-run`（实测：`Invalid option '--dry-run'`），
   * 所以预览由 `git annex find --in=here` 得出：列出本地有内容的 annex 文件与字节数，一个字节不动。
   */
  dryRun?: boolean;
  /**
   * 传给 `git annex drop --force`：本地是唯一副本时也丢（危险，默认关）。
   *
   * 默认（不传）时 git-annex 自己会把不安全的文件挡下 —— 实测输出
   * `{"success":false,"note":"unsafe\nCould not verify the existence of the 1 necessary copy."}`，
   * 这些文件原样保留。
   */
  force?: boolean;
  progress?: Progress;
}

export interface DropEntry {
  /** 相对仓库根的 posix 路径（git / git-annex 的路径口径）。 */
  file: string;
  /** annex key 的字节数（丢之前本地内容占的大小）。 */
  bytes: number;
  action: "dropped" | "planned" | "skipped" | "failed";
  detail?: string;
}

export interface DropReport {
  /** 被右键的目录（绝对路径）。 */
  dir: string;
  /** git work tree 根（绝对路径）。 */
  repoRoot: string;
  /** 被右键目录相对仓库根的路径（`""` = 整个仓库）。 */
  relpath: string;
  entries: DropEntry[];
  /** 本地有内容的文件数 / 总字节数（本次要处理的全部）。 */
  present: number;
  bytesPresent: number;
  dropped: number;
  planned: number;
  skipped: number;
  failed: number;
  /** 真正释放的字节数（= 成功丢掉的那些文件之和）。 */
  bytesFreed: number;
}

/** `git annex find --in=here --format='${file}\t${bytesize}\n'` 的一行。 */
interface PresentFile {
  file: string;
  bytes: number;
}

function parseFindListing(stdout: string): PresentFile[] {
  const rows: PresentFile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(0, tab).trim();
    const bytes = Number.parseInt(line.slice(tab + 1).trim(), 10);
    if (file === "") continue;
    rows.push({ file, bytes: Number.isFinite(bytes) ? bytes : 0 });
  }
  return rows;
}

/**
 * 「Drop largefiles」— 丢掉 `dir` 子树里 annex 文件在**本地**的内容（腾硬盘）。
 *
 * 元数据与缩略图不动：它们按 `.gitattributes` 的 `annex.largefiles=nothing` 进的是 git，
 * 不在 annex 里，`git annex drop` 根本碰不到 —— 画廊（sidecar `.md` + `.thumbnail.png` + `.base`）照旧可用。
 *
 * 安全语义交给 git-annex 自己：默认只丢「别处有足够副本」的内容，别处没有副本的文件会以
 * `success:false` + `unsafe` 记在报告里（`skipped`），原样保留；要连这些也丢得显式传 `force`。
 *
 * 丢完之后：**已 lock 的文件变成指向 `.git/annex/objects/…` 的断软链**，
 * **已 unlock 的文件变成 ~101 字节的 pointer 文件**（index 模式不变）。
 */
export async function dropLargefiles(dir: string, opts: DropOptions = {}): Promise<DropReport> {
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const progress = opts.progress;

  const { repoRoot, relpath } = resolveAnnexRepo(dir);
  const scope = relpath === "" ? [] : ["--", relpath];
  const scopeLabel = relpath === "" ? "整个仓库" : relpath;

  // ── 1. 本地有内容的 annex 文件（字节数一并拿到）─────────────────────────
  const listing = git(["annex", "find", "--in=here", "--format=${file}\\t${bytesize}\\n", ...scope], repoRoot);
  if (listing.code !== 0) {
    throw new Error(`git annex find 失败：${firstLine(listing.stderr) || firstLine(listing.stdout) || `退出码 ${listing.code}`}`);
  }
  const presentFiles = parseFindListing(listing.stdout);
  const bytesPresent = presentFiles.reduce((sum, row) => sum + row.bytes, 0);
  const bytesOf = new Map(presentFiles.map((row) => [row.file, row.bytes]));

  if (progress !== undefined) {
    progress(
      `Drop largefiles：${scopeLabel} 本地有内容 ${presentFiles.length} 个（${formatBytes(bytesPresent)}）${dryRun ? "（预览，不动任何文件）" : ""}`,
    );
  }

  const base: Omit<DropReport, "entries" | "dropped" | "planned" | "skipped" | "failed" | "bytesFreed"> = {
    dir,
    repoRoot,
    relpath,
    present: presentFiles.length,
    bytesPresent,
  };

  // ── 2. 预览：只报计划，不执行 ───────────────────────────────────────────
  if (dryRun) {
    const entries: DropEntry[] = presentFiles.map((row) => ({
      file: row.file,
      bytes: row.bytes,
      action: "planned",
      detail: "dry-run：将尝试 drop（别处没有足够副本的会被 annex 挡下）",
    }));
    return { ...base, entries, dropped: 0, planned: entries.length, skipped: 0, failed: 0, bytesFreed: 0 };
  }

  if (presentFiles.length === 0) {
    return { ...base, entries: [], dropped: 0, planned: 0, skipped: 0, failed: 0, bytesFreed: 0 };
  }

  // ── 3. 真丢：一次批量调用，逐文件看 JSON 里的 success ────────────────────
  const args = ["annex", "drop", "--json", "--json-error-messages"];
  if (force) args.push("--force");
  args.push(...scope);
  const result = await gitStream(args, repoRoot, (line) => {
    for (const row of parseAnnexLines(line)) {
      if (row.file !== undefined && row.success === true) progress?.(`Drop largefiles：${path.basename(row.file)}`);
    }
  });

  const lines = parseAnnexLines(result.stdout);
  const seen = new Set<string>();
  const entries: DropEntry[] = [];
  for (const line of lines) {
    const file = line.file as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const bytes = bytesOf.get(file) ?? 0;
    if (line.success === true) {
      entries.push({ file, bytes, action: "dropped" });
    } else if ((line.note ?? "").includes("unsafe")) {
      entries.push({
        file,
        bytes,
        action: "skipped",
        detail: `别处没有足够副本，git-annex 拒绝丢弃（${firstLine(line.note ?? "")}）`,
      });
    } else {
      entries.push({
        file,
        bytes,
        action: "failed",
        detail: firstLine(line.note ?? "") || firstLine(result.stderr) || "drop 失败（无说明）",
      });
    }
  }
  // 列出却在输出里缺席 = 这段时间内容已经不在本地了。
  for (const row of presentFiles) {
    if (!seen.has(row.file)) {
      entries.push({ file: row.file, bytes: row.bytes, action: "skipped", detail: "本地已无内容（本次没有可丢的东西）" });
    }
  }

  const dropped = entries.filter((entry) => entry.action === "dropped");
  const bytesFreed = dropped.reduce((sum, entry) => sum + entry.bytes, 0);
  if (progress !== undefined) {
    progress(`Drop largefiles：丢了 ${dropped.length}/${entries.length} 个（释放 ${formatBytes(bytesFreed)}）`);
  }

  return {
    ...base,
    entries,
    dropped: dropped.length,
    planned: 0,
    skipped: entries.filter((entry) => entry.action === "skipped").length,
    failed: entries.filter((entry) => entry.action === "failed").length,
    bytesFreed,
  };
}

/** 人类可读的字节数（1073741824 → `1.00 GB`）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
}
