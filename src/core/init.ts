import * as fs from "fs";
import * as path from "path";
import { git, isAnnexRepo, isInsideWorkTree } from "./git";
import {
  GITATTRIBUTES_TEMPLATE,
  GITIGNORE_TEMPLATE,
  ensureRulesFile,
  mergeRuleText,
  readIfExists,
  templateLines,
} from "./rules";
import { MergeResult, Progress } from "./types";
import { applyRemotes, type RemoteEntry, type RemoteResult } from "./remotes";

export interface InitOptions {
  progress?: Progress;
  /** Defaults to `<root>/.gitattributes`. */
  gitattributesPath?: string;
  /** Defaults to `<root>/.gitignore`. */
  gitignorePath?: string;
  /** 设置页「remote 设置」：逐个 git remote add / set-url（只写配置，不 fetch/push）。 */
  remotes?: RemoteEntry[];
  dryRun?: boolean;
}

/** `annex.addunlocked`：git-annex 的**仓库级**配置，写在 git-annex 分支的 `config.log` 里。 */
export const ADD_UNLOCKED_KEY = "annex.addunlocked";
/** 插件要求的值：新增的 annex 文件一律 unlocked（真实文件，index mode `100644`）。 */
export const ADD_UNLOCKED_VALUE = "true";

export interface AddUnlockedResult {
  key: string;
  /** 插件要求的值（恒为 `"true"`）。 */
  value: string;
  /** 本次跑之前的取值；`null` = 没设过（`git annex config --get` 输出为空行）。 */
  previous: string | null;
  /** 这次真的写了配置（`dryRun` 下恒 false —— 那时看 `action`）。 */
  changed: boolean;
  action: "set" | "unchanged" | "planned";
}

export interface InitResult {
  root: string;
  createdRepo: boolean;
  initedAnnex: boolean;
  gitattributes: MergeResult;
  gitignore: MergeResult;
  /** 形态口径：新文件以 unlocked 入库（`annex.addunlocked`）。 */
  addUnlocked: AddUnlockedResult;
  /** 每条 remote 的结果（added / updated / unchanged / skipped / failed）。 */
  remotes: RemoteResult[];
  notes: string[];
}

/**
 * Merge one rules file (`.gitattributes` / `.gitignore`) without ever
 * touching a line the user already wrote.
 *
 * In dry-run we must not write, so we compute the {@link MergeResult} with
 * `mergeRuleText` (the pure half of `ensureRulesFile`) and skip the write.
 */
function applyRulesFile(
  file: string,
  required: string[],
  dryRun: boolean,
  progress: Progress,
  label: string,
): MergeResult {
  if (dryRun) {
    const { result } = mergeRuleText(readIfExists(file), required, file);
    progress(`${label}：补 ${result.added.length} 行（dry-run：未写盘）`);
    return result;
  }
  const result = ensureRulesFile(file, required);
  progress(`${label}：补 ${result.added.length} 行`);
  return result;
}

/**
 * 读一个 git-annex 仓库级配置的当前值（`git annex config --get`）。
 *
 * 实测：键没设过时**退出码仍是 0**、stdout 只有一行空行（不是非零退出），所以
 * 「没设过」的判据是「空输出」，不是退出码。
 */
function readAnnexConfig(root: string, key: string): string | null {
  const r = git(["annex", "config", "--get", key], root);
  if (r.code !== 0) return null;
  const value = (r.stdout.split(/\r?\n/)[0] ?? "").trim();
  return value === "" ? null : value;
}

/**
 * 形态口径：`annex.addunlocked true` —— 让**以后 add 的** annex 文件以 unlocked
 * （真实文件、index mode `100644`）入库，而不是 locked 符号链接（`120000`）。
 *
 * 为什么必须先读再写：`git annex config --set` 每次都会往 git-annex 分支写一个提交
 * （`config.log`），已是 true 还再写一遍就是「幂等的初始化为分支加了噪声提交」。
 * 所以只有当前值不是 `true` 才写；`false` / 任何别的值都会被改成 `true`（这是本命令的口径）。
 */
function applyAddUnlocked(root: string, dryRun: boolean, progress: Progress): AddUnlockedResult {
  const previous = readAnnexConfig(root, ADD_UNLOCKED_KEY);
  const base = { key: ADD_UNLOCKED_KEY, value: ADD_UNLOCKED_VALUE, previous };
  if (previous === ADD_UNLOCKED_VALUE) {
    progress(`${ADD_UNLOCKED_KEY} 已是 ${ADD_UNLOCKED_VALUE}，跳过（新文件本来就会以 unlocked 形态 add）`);
    return { ...base, changed: false, action: "unchanged" };
  }
  if (dryRun) {
    progress(`git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE}（dry-run：未执行）`);
    return { ...base, changed: false, action: "planned" };
  }
  progress(`git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE}`);
  const r = git(["annex", "config", "--set", ADD_UNLOCKED_KEY, ADD_UNLOCKED_VALUE], root);
  if (r.code !== 0) {
    throw new Error(
      `git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE} 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim()}`,
    );
  }
  return { ...base, changed: true, action: "set" };
}

/**
 * True when `dir` is the root of the git work tree that contains it.
 *
 * Compares `git rev-parse --show-toplevel` against `dir` **by real path**:
 * on macOS `/tmp` is a symlink to `/private/tmp`, so git reports the resolved
 * path while the caller may hold the symlinked one — a plain `path.resolve`
 * compare (as in `git.ts`'s `isRepoRoot`) would wrongly report "not the root".
 */
function isRepoRoot(dir: string): boolean {
  const r = git(["rev-parse", "--show-toplevel"], dir);
  const top = r.stdout.trim();
  if (r.code !== 0 || top === "") return false;
  try {
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return path.resolve(top) === path.resolve(dir);
  }
}

/**
 * 「初始化 gallery」— the *core* of command #1 (no Obsidian imports here, so the
 * CLI can run it too).
 *
 * Steps, in order:
 *   1. verify `root` exists and is a directory;
 *   2. `git init -b main` only when it is not already a work tree (and refuse
 *      to re-init a subdirectory of an existing repo);
 *   3. `git annex init "<basename>"` only when it is not already an annex repo;
 *   4. `git annex config --set annex.addunlocked true` unless it is already true
 *      —— **形态口径**：此后 `git annex add` 进来的文件一律 unlocked（真实文件、
 *      index mode `100644`），而不是锁定态的符号链接（`120000`）；已有 annexed 的
 *      locked 老文件不受影响（那要另跑 `git annex unlock`）；
 *   5. merge the four `.gitattributes` rules (append the missing ones);
 *   6. merge `.gitignore` (only `.obsidian`);
 *   7. never `git add` / `git commit` / `git annex add` — the work tree is left
 *      to the user.
 *
 * 所以一条「初始化 gallery」跑 **2 条 annex 命令**：`git annex init` +
 * `git annex config --set annex.addunlocked true`（后者已是 true 就跳过）。
 *
 * Idempotent: a second run changes no byte on disk —— **包括 git-annex 分支**：
 * `annex.addunlocked` 已是 true 时不再 `--set`（每写一次都会在 git-annex 分支上留一个提交）。
 * With `dryRun` nothing is written and `createdRepo` / `initedAnnex` / `addUnlocked`
 * describe what *would* happen.
 */
export async function initGallery(root: string, opts: InitOptions = {}): Promise<InitResult> {
  const dryRun = opts.dryRun === true;
  const progress: Progress = opts.progress ?? ((): void => undefined);
  const notes: string[] = [];

  // 1. `root` must exist and be a directory.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`目标目录不存在：${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`目标不是目录：${root}`);
  }
  const absRoot = path.resolve(root);

  // 2. git work tree.
  let createdRepo = false;
  if (isInsideWorkTree(absRoot)) {
    if (!isRepoRoot(absRoot)) {
      throw new Error(
        `目标目录已在某个 git 仓库里，但不是该仓库的根：${absRoot}（不要在子目录上再 init；请在仓库根上运行，或换一个目录）`,
      );
    }
    notes.push(`已是 git 仓库，跳过 git init：${absRoot}`);
    progress("已是 git 仓库，跳过 git init");
  } else {
    createdRepo = true;
    if (dryRun) {
      progress("git init -b main（dry-run：未执行）");
    } else {
      progress("git init -b main");
      const r = git(["init", "-b", "main"], absRoot);
      if (r.code !== 0) {
        throw new Error(`git init -b main 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim()}`);
      }
    }
  }

  // 3. git-annex.
  const repoName = path.basename(absRoot) || absRoot;
  let initedAnnex = false;
  if (isAnnexRepo(absRoot)) {
    notes.push("已是 annex 仓库，跳过 git annex init");
    progress("已是 annex 仓库，跳过 git annex init");
  } else {
    initedAnnex = true;
    if (dryRun) {
      progress(`git annex init ${repoName}（dry-run：未执行）`);
    } else {
      progress(`git annex init ${repoName}`);
      const r = git(["annex", "init", repoName], absRoot);
      if (r.code !== 0) {
        throw new Error(`git annex init 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim()}`);
      }
    }
  }

  // 4. `annex.addunlocked` —— 形态口径：新文件以 unlocked 入库（不是 locked 符号链接）。
  const addUnlocked = applyAddUnlocked(absRoot, dryRun, progress);

  // 5. `.gitattributes` — merge, never overwrite.
  const gitattributesPath = opts.gitattributesPath ?? path.join(absRoot, ".gitattributes");
  const gitattributes = applyRulesFile(
    gitattributesPath,
    templateLines(GITATTRIBUTES_TEMPLATE),
    dryRun,
    progress,
    ".gitattributes",
  );

  // 6. `.gitignore` — merge, never overwrite.
  const gitignorePath = opts.gitignorePath ?? path.join(absRoot, ".gitignore");
  const gitignore = applyRulesFile(
    gitignorePath,
    templateLines(GITIGNORE_TEMPLATE),
    dryRun,
    progress,
    ".gitignore",
  );

  // 7. remotes（设置页「remote 设置」）—— 只写 remote 配置，不 fetch、不 push。
  const remotes = applyRemotes(absRoot, opts.remotes ?? [], { dryRun, progress });

  if (dryRun) {
    notes.push("dry-run：只计算不写盘，createdRepo / initedAnnex / addUnlocked / added 表示「将会怎样」");
  } else if (addUnlocked.changed) {
    notes.push(`${ADD_UNLOCKED_KEY}=${ADD_UNLOCKED_VALUE} 已写进 git-annex 分支（此后 add 的文件以 unlocked 入库）`);
  }

  return { root: absRoot, createdRepo, initedAnnex, gitattributes, gitignore, addUnlocked, remotes, notes };
}
