/**
 * Git remotes, read from and written to `.git/config` — the single source of truth.
 *
 * Contract (implemented by the core slice, consumed by the UI + cleanup slices):
 *   - `readRemotes(dir)` reads `git config --get-regexp '^remote\.'` and classifies
 *     every remote; `hasRepo` is false when `git rev-parse --git-dir` fails.
 *   - `rowsFromSnapshot()` turns the editable (single-URL) git remotes into editor rows.
 *   - `planRemoteChanges(rows, snapshot)` validates the rows and produces an ordered
 *     command plan: remove -> rename -> set-url (fetch, push) -> add. `issues` is
 *     non-empty when anything is invalid; a plan with issues must never be executed.
 *   - `applyRemotePlan(dir, plan)` runs the steps in order and stops at the first failure
 *     (no rollback — the caller reports partial progress and reloads).
 *   - `sameRemoteConfig(a, b)` is the staleness check: the raw `remote.*` config must be
 *     byte-identical between the snapshot the editor was rendered from and a fresh read.
 *
 * Nothing in this module fetches, pushes, or touches git-annex content: only remote
 * configuration is read or written (see the `no-transfer-ops` policy).
 */
import { git } from "./git";

/** A remote that carries a URL (shown as an editable row when it has exactly one URL). */
export interface GitRemote {
  name: string;
  /** `remote.<name>.url` values, in config order. */
  fetchUrls: string[];
  /** `remote.<name>.pushurl` values, in config order (empty = push reuses the fetch URL). */
  pushUrls: string[];
  /** `multi-url` = more than one fetch URL, more than one push URL, or no URL at all. */
  kind: "git" | "multi-url";
  /** `remote.<name>.annex-uuid` is present: git-annex tracks this remote. */
  hasAnnexUuid: boolean;
}

/** A git-annex special remote: `annex-*` keys and no `url`. */
export interface SpecialRemote {
  name: string;
  /** `type=`, or `externaltype=` when `type=external`; `""` when neither is set. */
  type: string;
  /** `remote.<name>.annex-uuid` is present. */
  hasAnnexUuid: boolean;
  /** The main setting to display (e.g. `directory` → `/Volumes/Archive`), if any. */
  mainSetting: { key: string; value: string } | null;
  /** Every `remote.<name>.*` key (prefix stripped) → value, in config order. */
  config: Record<string, string>;
}

/** Everything the settings page needs to know about the repository's remotes. */
export interface RemotesSnapshot {
  /** False when `dir` is not inside a git repository (or git is unavailable). */
  hasRepo: boolean;
  /** Every remote that has a `url`, editable and read-only alike. */
  gitRemotes: GitRemote[];
  /** Every remote that has `annex-*` keys and no `url`. */
  specialRemotes: SpecialRemote[];
  /** Raw `remote.<name>.<key>` → value as read from git, for the staleness check. */
  config: Record<string, string>;
}

/** One editable row in the remotes editor. */
export interface RemoteRow {
  /** Name as read from git; `""` for a row the user just added. */
  originalName: string;
  /** Current (possibly edited) name. */
  name: string;
  /** Current fetch URL. */
  fetchUrl: string;
  /** Current push URL; `null` = no push URL configured (push reuses the fetch URL). */
  pushUrl: string | null;
}

export type RemoteCommandKind =
  | "remove"
  | "rename"
  | "set-fetch-url"
  | "set-push-url"
  | "delete-push-url"
  | "add";

/** One `git remote …` invocation, in plan order. */
export interface RemoteStep {
  kind: RemoteCommandKind;
  /** The remote name the command targets (new name for rename / add). */
  name: string;
  /** The previous name, for renames. */
  previousName?: string;
  /** Arguments after `git -C <dir>` — never a bare shell string. */
  args: string[];
  /** English one-liner for notices, e.g. `rename origin to upstream`. */
  describe: string;
}

/** A validation problem. `row` is an index into the rows array, or null for snapshot-level issues. */
export interface RemoteIssue {
  row: number | null;
  field?: "name" | "fetchUrl" | "pushUrl";
  message: string;
}

export interface RemotePlan {
  steps: RemoteStep[];
  issues: RemoteIssue[];
}

export interface RemoteStepResult {
  step: RemoteStep;
  ok: boolean;
  /** git stderr (or stdout) for a failed step. */
  detail?: string;
}

export interface RemoteApplyResult {
  /** Steps attempted, in order. */
  results: RemoteStepResult[];
  /** The step that failed, or null. */
  failed: RemoteStep | null;
  /** True only when every planned step succeeded. */
  ok: boolean;
}

/** TODO(core): read `git config --get-regexp '^remote\.'` and classify the remotes. */
export function readRemotes(dir: string): RemotesSnapshot {
  void dir;
  throw new Error("TODO(core): readRemotes");
}

/** TODO(core): parse the stdout of `git config --get-regexp '^remote\.'`. */
export function parseRemoteConfig(stdout: string): Pick<RemotesSnapshot, "gitRemotes" | "specialRemotes" | "config"> {
  void stdout;
  throw new Error("TODO(core): parseRemoteConfig");
}

/** TODO(core): true when both snapshots read exactly the same `remote.*` config. */
export function sameRemoteConfig(a: RemotesSnapshot, b: RemotesSnapshot): boolean {
  void a;
  void b;
  throw new Error("TODO(core): sameRemoteConfig");
}

/** TODO(core): editable rows = git remotes whose kind is `git`. */
export function rowsFromSnapshot(snapshot: RemotesSnapshot): RemoteRow[] {
  void snapshot;
  throw new Error("TODO(core): rowsFromSnapshot");
}

/** TODO(core): validate rows and build the ordered remove -> rename -> set-url -> add plan. */
export function planRemoteChanges(rows: RemoteRow[], snapshot: RemotesSnapshot): RemotePlan {
  void rows;
  void snapshot;
  throw new Error("TODO(core): planRemoteChanges");
}

/** TODO(core): execute the plan, stopping at the first failed command. */
export function applyRemotePlan(dir: string, plan: RemotePlan): RemoteApplyResult {
  void dir;
  void plan;
  throw new Error("TODO(core): applyRemotePlan");
}

/** TODO(core): documentation link for a special remote type (index page as fallback). */
export function specialRemoteDocUrl(remote: SpecialRemote): string {
  void remote;
  throw new Error("TODO(core): specialRemoteDocUrl");
}
