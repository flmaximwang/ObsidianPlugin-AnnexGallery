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

export interface InitOptions {
  progress?: Progress;
  /** Defaults to `<root>/.gitattributes`. */
  gitattributesPath?: string;
  /** Defaults to `<root>/.gitignore`. */
  gitignorePath?: string;
  dryRun?: boolean;
}

export interface InitResult {
  root: string;
  createdRepo: boolean;
  initedAnnex: boolean;
  gitattributes: MergeResult;
  gitignore: MergeResult;
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
 *   4. merge the four `.gitattributes` rules (append the missing ones);
 *   5. merge `.gitignore` (only `.obsidian`);
 *   6. never `git add` / `git commit` / `git annex add` — the work tree is left
 *      to the user.
 *
 * Idempotent: a second run changes no byte on disk. With `dryRun` nothing is
 * written and `createdRepo` / `initedAnnex` / `added` describe what *would*
 * happen.
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

  // 4. `.gitattributes` — merge, never overwrite.
  const gitattributesPath = opts.gitattributesPath ?? path.join(absRoot, ".gitattributes");
  const gitattributes = applyRulesFile(
    gitattributesPath,
    templateLines(GITATTRIBUTES_TEMPLATE),
    dryRun,
    progress,
    ".gitattributes",
  );

  // 5. `.gitignore` — merge, never overwrite.
  const gitignorePath = opts.gitignorePath ?? path.join(absRoot, ".gitignore");
  const gitignore = applyRulesFile(
    gitignorePath,
    templateLines(GITIGNORE_TEMPLATE),
    dryRun,
    progress,
    ".gitignore",
  );

  if (dryRun) {
    notes.push("dry-run：只计算不写盘，createdRepo / initedAnnex / added 表示「将会怎样」");
  }

  return { root: absRoot, createdRepo, initedAnnex, gitattributes, gitignore, notes };
}
