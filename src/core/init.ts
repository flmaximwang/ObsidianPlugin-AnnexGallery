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

/** `annex.addunlocked`：git-annex 的**仓库级**配置，写在 git-annex 分支的 `config.log` 里。 */
export const ADD_UNLOCKED_KEY = "annex.addunlocked";
/** 插件要求的值：新增的 annex 文件一律 unlocked（真实文件，index mode `100644`）。 */
export const ADD_UNLOCKED_VALUE = "true";
/** `annex.thin`：**存不进** git-annex 分支（见 `docs/commands.md` 的坑 4），只能在本机配置里。 */
export const THIN_KEY = "annex.thin";

export type SettingAction = "set" | "unset" | "unchanged" | "planned";

export interface SettingRepair {
  key: string;
  /** `annex-branch` = git-annex 分支上的共享配置；`local` = 本机 `<root>/.git/config`。 */
  scope: "annex-branch" | "local";
  /** 期望状态：`"true"` = 必须等于它；`null` = 这个键不该（以别的值）存在。 */
  standard: string | null;
  /** 跑之前的取值；`null` = 键不存在（或只在更高优先级那层存在）。 */
  previous: string | null;
  /** 这次真的写了盘（`dryRun` 下恒 false —— 那时看 `action`）。 */
  changed: boolean;
  action: SettingAction;
  /** 为什么要动它（偏离成什么样）。 */
  detail?: string;
}

/**
 * 形态口径收敛的结果：`annex.addunlocked` + `annex.thin` 的「标准状态」是被**核对并修复**过的，
 * 不是「看起来设过就跳过」。
 *
 * 标准状态三条（口径见 `docs/commands.md`）：
 *   1. git-annex **分支**上的 `annex.addunlocked=true`（共享口径，跟着分支传到所有 clone）；
 *   2. 本机 `.git/config` 的 `annex.addunlocked` **不得**把它压成非真值（本机覆盖优先于分支，
 *      实测：分支 true + 本机 false ⇒ 新文件照样 locked）；
 *   3. 本机**不 thin**（`annex.thin` 开着 = hardlink 模式，原地写会毁掉 `.git/annex` 里那份内容）。
 */
export interface AnnexShape {
  /** 第 1 条：git-annex 分支上的 `annex.addunlocked`。 */
  addUnlocked: SettingRepair;
  /** 第 2 / 3 条：本机上被清掉或压住的偏离项，按执行顺序。 */
  localRepairs: SettingRepair[];
  /** 收敛后**真正生效**的 `annex.addunlocked`（git 配置层压过分支；`null` = 两层都没值）。 */
  effectiveAddUnlocked: string | null;
  /** 收敛后生效的 `annex.thin`（`null` / `false` = 符合口径）。 */
  effectiveThin: string | null;
  /** 这一次有没有动过任何设置。 */
  changed: boolean;
}

export interface InitResult {
  root: string;
  createdRepo: boolean;
  initedAnnex: boolean;
  gitattributes: MergeResult;
  gitignore: MergeResult;
  /** 形态口径（annex 设置）—— 重复运行是零写入。 */
  shape: AnnexShape;
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
  template: string,
  dryRun: boolean,
  progress: Progress,
  label: string,
): MergeResult {
  const required = templateLines(template);
  if (dryRun) {
    const { result } = mergeRuleText(readIfExists(file), required, file, template);
    progress(`${label}: added ${result.added.length} line(s) (dry-run: nothing written)`);
    return result;
  }
  const result = ensureRulesFile(file, required, template);
  progress(`${label}: added ${result.added.length} line(s)`);
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

/** `git config --local --get <key>`：本机 `<root>/.git/config` 里的值；键不存在时 git 退出码 5 → `null`。 */
function readLocalSetting(root: string, key: string): string | null {
  return readConfigValue(["config", "--local", "--get", key], root);
}

/**
 * 全局 / 系统那层的值（本机那条不算）。
 *
 * **`git config` 永远看不见 git-annex 分支**（`config.log` 不是配置文件），所以「生效值」要自己合成：
 * git 配置那层（本机 > 全局 > 系统）有值就**压过**分支上的共享值 —— 实测：分支 `true` + 本机
 * `false` ⇒ 新文件照样 locked。
 */
function readNonLocalSetting(root: string, key: string): string | null {
  const global = readConfigValue(["config", "--global", "--get", key], root);
  if (global !== null) return global;
  return readConfigValue(["config", "--system", "--get", key], root);
}

function readConfigValue(args: string[], root: string): string | null {
  const r = git(args, root);
  if (r.code !== 0) return null;
  const value = (r.stdout.split(/\r?\n/)[0] ?? "").trim();
  return value === "" ? null : value;
}

/** git-annex 自己的 bool 口径：`true` / `yes` / `on` / `1` 都算开。 */
function isTruthyValue(value: string | null): boolean {
  if (value === null) return false;
  return ["true", "yes", "on", "1"].includes(value.toLowerCase());
}

/**
 * 形态口径收敛（「初始化 gallery」第 4 步）：把 annex 的**设置**核对并修复到标准状态。
 *
 * 标准状态三条 + 各自的修法：
 *
 * | # | 位置 | 标准 | 偏离时 |
 * |---|---|---|---|
 * | 1 | git-annex 分支 `annex.addunlocked` | `true` | `git annex config --set … true` |
 * | 2 | 本机 `.git/config` `annex.addunlocked` | 不得是**非真值**（本机覆盖优先于分支，会把分支的 true 盖成 locked） | 删掉这个本机键（分支那份接着生效） |
 * | 3 | 本机 `.git/config` `annex.thin` | 不得是**真值**（thin = hardlink，原地写会毁掉 annex 里那份内容） | 删掉这个本机键 |
 * | 4 | 兜底 | 上面三条做完后**生效值**仍不合口径 | 就本机压一条（`true` / `false`），并写明原因 |
 *
 * 「生效值」= git 配置那层（本机 > 全局 > 系统）**压过** git-annex 分支上的共享值；两层都没有才看分支。
 * （`git config` 看不见分支，所以这个合成是代码里显式做的 —— 别拿 `git config --get` 当生效值。）
 *
 * 三条都**只在偏离时**才动手，所以重复运行是零写入、零报错（这也是判据里的场景 3 与 6）。
 * 已经与本机覆盖一致的真值**不删** —— 删了会在「全局配置反着来」的仓库上与兜底互相拉扯，
 * 变成每次运行都改盘（实测过的假幂等）。
 *
 * 已知坑：`git annex config --set annex.thin …` 会直接抛
 * `annex.thin is not a configuration setting that can be stored in the git-annex branch`（exit 1），
 * 所以 thin 只在本机配置里修，绝不走 `git annex config`。
 */
function applyAnnexShape(root: string, dryRun: boolean, progress: Progress): AnnexShape {
  // ── 1. 分支上的 annex.addunlocked ─────────────────────────────────────
  const branchPrevious = readAnnexConfig(root, ADD_UNLOCKED_KEY);
  let addUnlocked: SettingRepair;
  if (branchPrevious === ADD_UNLOCKED_VALUE) {
    progress(`${ADD_UNLOCKED_KEY} (branch) is already ${ADD_UNLOCKED_VALUE}, unchanged`);
    addUnlocked = {
      key: ADD_UNLOCKED_KEY,
      scope: "annex-branch",
      standard: ADD_UNLOCKED_VALUE,
      previous: branchPrevious,
      changed: false,
      action: "unchanged",
    };
  } else if (dryRun) {
    progress(`git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE} (dry-run: not executed)`);
    addUnlocked = {
      key: ADD_UNLOCKED_KEY,
      scope: "annex-branch",
      standard: ADD_UNLOCKED_VALUE,
      previous: branchPrevious,
      changed: false,
      action: "planned",
      detail: branchPrevious === null ? "not set on the branch" : `currently ${branchPrevious} on the branch`,
    };
  } else {
    progress(`git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE}`);
    const r = git(["annex", "config", "--set", ADD_UNLOCKED_KEY, ADD_UNLOCKED_VALUE], root);
    if (r.code !== 0) {
      throw new Error(
        `git annex config --set ${ADD_UNLOCKED_KEY} ${ADD_UNLOCKED_VALUE} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
      );
    }
    addUnlocked = {
      key: ADD_UNLOCKED_KEY,
      scope: "annex-branch",
      standard: ADD_UNLOCKED_VALUE,
      previous: branchPrevious,
      changed: true,
      action: "set",
      detail: branchPrevious === null ? "not set on the branch" : `was ${branchPrevious} on the branch`,
    };
  }

  // ── 2. 本机的 annex.addunlocked 覆盖（不得把分支的 true 盖掉）─────────
  const localRepairs: SettingRepair[] = [];
  const localAddUnlocked = readLocalSetting(root, ADD_UNLOCKED_KEY);
  // 本机那条是**非真值**才会压掉分支的 true，才需要清；真值留着（与标准一致）。
  const localAddUnlockedOff = localAddUnlocked !== null && !isTruthyValue(localAddUnlocked);
  if (localAddUnlockedOff) {
    localRepairs.push(
      clearLocalSetting(
        root,
        ADD_UNLOCKED_KEY,
        localAddUnlocked,
        `Local override is ${localAddUnlocked}; it takes precedence over the branch and forces newly added files to be locked`,
        dryRun,
        progress,
      ),
    );
  } else if (localAddUnlocked !== null) {
    progress(`${ADD_UNLOCKED_KEY} (local) is ${localAddUnlocked}; matches the branch, unchanged`);
  }

  // ── 3. 本机的 annex.thin（口径是「不 thin」）──────────────────────────
  const localThin = readLocalSetting(root, THIN_KEY);
  const localThinOn = localThin !== null && isTruthyValue(localThin);
  if (localThinOn) {
    localRepairs.push(
      clearLocalSetting(root, THIN_KEY, localThin, "annex.thin is enabled locally (hardlink mode); the policy is non-thin", dryRun, progress),
    );
  } else if (localThin !== null) {
    progress(`${THIN_KEY} (local) is ${localThin}; already non-thin, unchanged`);
  }

  // ── 4. 兜底：算出**生效值**，还不合口径（全局 / 系统在头上）就压一条本机值 ──
  //
  // 生效值 = git 配置那层（本机 > 全局 > 系统）**压过**分支上的共享值：本机留着就按本机算，
  // 本机被清掉（或本来就没有）就按全局 / 系统算，都没有才轮得到分支上的那条。
  const gitLayerAddUnlocked =
    localAddUnlocked !== null && !localAddUnlockedOff ? localAddUnlocked : readNonLocalSetting(root, ADD_UNLOCKED_KEY);
  let effectiveAddUnlocked = gitLayerAddUnlocked ?? ADD_UNLOCKED_VALUE; // 第 1 步保证分支上是 true
  if (!isTruthyValue(effectiveAddUnlocked)) {
    const from = `effective value ${effectiveAddUnlocked} (global / system config)`;
    localRepairs.push(
      writeLocalSetting(
        root,
        ADD_UNLOCKED_KEY,
        ADD_UNLOCKED_VALUE,
        localAddUnlocked,
        `${from} — write a local override to keep new files unlocked`,
        dryRun,
        progress,
      ),
    );
    if (!dryRun) effectiveAddUnlocked = ADD_UNLOCKED_VALUE;
  }

  // thin 存不进 git-annex 分支，所以它只可能来自 git 配置层。
  const gitLayerThin = localThin !== null && !localThinOn ? localThin : readNonLocalSetting(root, THIN_KEY);
  let effectiveThin = gitLayerThin;
  if (isTruthyValue(effectiveThin)) {
    localRepairs.push(
      writeLocalSetting(root, THIN_KEY, "false", localThin, `effective value ${String(effectiveThin)} (global / system config) — override locally to false`, dryRun, progress),
    );
    if (!dryRun) effectiveThin = "false";
  }

  return {
    addUnlocked,
    localRepairs,
    effectiveAddUnlocked,
    effectiveThin,
    changed: addUnlocked.changed || localRepairs.some((entry) => entry.changed),
  };
}

/** 删掉一个**已存在**的本机键。调用前必须确认它存在：`git config --unset` 对不存在的键退 5。 */
function clearLocalSetting(
  root: string,
  key: string,
  previous: string,
  detail: string,
  dryRun: boolean,
  progress: Progress,
): SettingRepair {
  const base = { key, scope: "local" as const, standard: null, previous, detail };
  if (dryRun) {
    progress(`git config --local --unset ${key} (dry-run: not executed)`);
    return { ...base, changed: false, action: "planned" };
  }
  progress(`git config --local --unset ${key} (previous value ${previous})`);
  const r = git(["config", "--local", "--unset", key], root);
  if (r.code !== 0) {
    throw new Error(`git config --local --unset ${key} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return { ...base, changed: true, action: "unset" };
}

/** 写一条本机值（兜底用：全局 / 系统配置把生效值压偏了）。`previous` 是本机原本的值（可能为 null）。 */
function writeLocalSetting(
  root: string,
  key: string,
  value: string,
  previous: string | null,
  detail: string,
  dryRun: boolean,
  progress: Progress,
): SettingRepair {
  const base = { key, scope: "local" as const, standard: value, previous, detail };
  if (dryRun) {
    progress(`git config --local ${key} ${value} (dry-run: not executed)`);
    return { ...base, changed: false, action: "planned" };
  }
  progress(`git config --local ${key} ${value}`);
  const r = git(["config", "--local", key, value], root);
  if (r.code !== 0) {
    throw new Error(`git config --local ${key} ${value} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
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
 *   4. 把 annex 的**设置**核对并修复到标准状态（形态口径，见 {@link applyAnnexShape}）：
 *      git-annex 分支上 `annex.addunlocked=true`；本机 `.git/config` 里不得有会把它压成
 *      非真值的覆盖、也不得开着 `annex.thin`；全局 / 系统配置压偏时再就本机压一条。
 *      此后 `git annex add` 进来的文件一律 unlocked（真实文件、index mode `100644`），
 *      而不是锁定态的符号链接（`120000`）；已有 annexed 的 locked 老文件不受影响
 *      （那要另跑 `git annex unlock`）；
 *   5. merge the four `.gitattributes` rules (append the missing ones);
 *   6. merge `.gitignore` (only `.obsidian`);
 *   7. never `git add` / `git commit` / `git annex add` — the work tree is left
 *      to the user.
 *
 * 所以一条「初始化 gallery」跑 **2 条 annex 命令**：`git annex init` +
 * `git annex config --set annex.addunlocked true`（后者已是 true 就跳过）。
 *
 * Idempotent: a second run changes no byte on disk —— **包括 git-annex 分支**：
 * `annex.addunlocked` 已是 true 时不再 `--set`（每写一次都会在 git-annex 分支上留一个提交），
 * 本机设置也只在真的偏离标准状态时才动。With `dryRun` nothing is written and
 * `createdRepo` / `initedAnnex` / `shape` describe what *would* happen.
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
    throw new Error(`Target directory does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`);
  }
  const absRoot = path.resolve(root);

  // 2. git work tree.
  let createdRepo = false;
  if (isInsideWorkTree(absRoot)) {
    if (!isRepoRoot(absRoot)) {
      throw new Error(
        `Target directory is inside a git repository but is not its root: ${absRoot} (do not initialize a subdirectory; run this on the repository root or choose another directory)`,
      );
    }
    notes.push(`Already a git repository, skipping git init: ${absRoot}`);
    progress("Already a git repository, skipping git init");
  } else {
    createdRepo = true;
    if (dryRun) {
      progress("git init -b main (dry-run: not executed)");
    } else {
      progress("git init -b main");
      const r = git(["init", "-b", "main"], absRoot);
      if (r.code !== 0) {
        throw new Error(`git init -b main failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
      }
    }
  }

  // 3. git-annex.
  const repoName = path.basename(absRoot) || absRoot;
  let initedAnnex = false;
  if (isAnnexRepo(absRoot)) {
    notes.push("Already an annex repository, skipping git annex init");
    progress("Already an annex repository, skipping git annex init");
  } else {
    initedAnnex = true;
    if (dryRun) {
      progress(`git annex init ${repoName} (dry-run: not executed)`);
    } else {
      progress(`git annex init ${repoName}`);
      const r = git(["annex", "init", repoName], absRoot);
      if (r.code !== 0) {
        throw new Error(`git annex init failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
      }
    }
  }

  // 4. 形态口径：annex 的「设置」核对并修复到标准状态（分支 `annex.addunlocked=true`、本机无
  //    会压偏它的覆盖、本机不 thin）—— 只在偏离时动手，所以重复运行零写入、零报错。
  const shape = applyAnnexShape(absRoot, dryRun, progress);

  // 5. `.gitattributes` — merge, never overwrite.
  const gitattributesPath = opts.gitattributesPath ?? path.join(absRoot, ".gitattributes");
  const gitattributes = applyRulesFile(
    gitattributesPath,
    GITATTRIBUTES_TEMPLATE,
    dryRun,
    progress,
    ".gitattributes",
  );

  // 6. `.gitignore` — merge, never overwrite.
  const gitignorePath = opts.gitignorePath ?? path.join(absRoot, ".gitignore");
  const gitignore = applyRulesFile(
    gitignorePath,
    GITIGNORE_TEMPLATE,
    dryRun,
    progress,
    ".gitignore",
  );

  if (dryRun) {
    notes.push("dry-run: computes only and writes nothing; createdRepo / initedAnnex / shape / added describe what would happen");
  } else {
    if (shape.addUnlocked.changed) {
      notes.push(`${ADD_UNLOCKED_KEY}=${ADD_UNLOCKED_VALUE} written to the git-annex branch (files added from now on are stored unlocked)`);
    }
    for (const repair of shape.localRepairs) {
      notes.push(`Local "${repair.key}" was ${repair.previous ?? "(none)"} → ${repair.action === "unset" ? "removed" : `set to ${repair.standard}`} (${repair.detail ?? ""})`);
    }
  }

  return { root: absRoot, createdRepo, initedAnnex, gitattributes, gitignore, shape, notes };
}
