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

const EMPTY_SNAPSHOT: RemotesSnapshot = {
  hasRepo: false,
  gitRemotes: [],
  specialRemotes: [],
  config: {},
};

/** Full config key for one remote entry, e.g. `remote.origin.url`. */
function configKey(name: string, key: string): string {
  return `remote.${name}.${key}`;
}

/**
 * Split a `remote.<name>.<key>` config key.
 *
 * Remote names may contain dots (`remote.my.nas.url`); git stores the name between the
 * first dot after `remote` and the last dot of the key. Keys without a second dot
 * (`remote.pushdefault`) are not per-remote settings and are skipped.
 */
function splitRemoteKey(key: string): { name: string; subkey: string } | null {
  const rest = key.slice("remote.".length);
  const lastDot = rest.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === rest.length - 1) return null;
  return { name: rest.slice(0, lastDot), subkey: rest.slice(lastDot + 1) };
}

/** Read `git config --get-regexp '^remote\.'` and classify every remote. Never throws. */
export function readRemotes(dir: string): RemotesSnapshot {
  const repo = git(["rev-parse", "--git-dir"], dir);
  if (repo.code !== 0) return { ...EMPTY_SNAPSHOT, gitRemotes: [], specialRemotes: [], config: {} };

  // `-z` keeps values with spaces / newlines intact; exit code 1 simply means "no matches".
  const res = git(["config", "-z", "--get-regexp", "^remote\\."], dir);
  if (res.code !== 0 && res.stdout === "") {
    return { hasRepo: true, gitRemotes: [], specialRemotes: [], config: {} };
  }
  return { hasRepo: true, ...parseRemoteConfig(res.stdout) };
}

/** Parse the NUL-separated output of `git config -z --get-regexp '^remote\.'`. */
export function parseRemoteConfig(stdout: string): Pick<RemotesSnapshot, "gitRemotes" | "specialRemotes" | "config"> {
  /** name -> ordered entries; a remote can repeat a key (`url`), so keep every value. */
  const byName = new Map<string, { key: string; value: string }[]>();
  const config: Record<string, string> = {};

  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    // With -z a valueless key is still written as "<key>\n"; an empty value is indistinguishable
    // and both mean the empty string.
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    if (!key.startsWith("remote.")) continue;
    const parsed = splitRemoteKey(key);
    if (parsed === null) continue;
    config[key] = value;
    const entries = byName.get(parsed.name);
    if (entries === undefined) byName.set(parsed.name, [{ key: parsed.subkey, value }]);
    else entries.push({ key: parsed.subkey, value });
  }

  const gitRemotes: GitRemote[] = [];
  const specialRemotes: SpecialRemote[] = [];

  for (const [name, entries] of byName) {
    const urls = entries.filter((entry) => entry.key === "url").map((entry) => entry.value);
    const pushUrls = entries.filter((entry) => entry.key === "pushurl").map((entry) => entry.value);
    const hasAnnexUuid = entries.some((entry) => entry.key === "annex-uuid");
    const hasUrl = urls.length > 0;

    if (hasUrl) {
      gitRemotes.push({
        name,
        fetchUrls: urls,
        pushUrls,
        kind: urls.length === 1 && pushUrls.length <= 1 ? "git" : "multi-url",
        hasAnnexUuid,
      });
      continue;
    }

    const hasAnnexKey = entries.some((entry) => entry.key.startsWith("annex-"));
    if (!hasAnnexKey) continue;

    const remoteConfig: Record<string, string> = {};
    for (const entry of entries) remoteConfig[entry.key] = entry.value;

    const rawType = remoteConfig["type"] ?? "";
    const type =
      rawType === "external"
        ? (remoteConfig["externaltype"] ?? "external")
        : rawType;

    let mainSetting: { key: string; value: string } | null = null;
    for (const entry of entries) {
      if (entry.key.startsWith("annex-")) continue;
      if (entry.key === "type" || entry.key === "externaltype") continue;
      mainSetting = { key: entry.key, value: entry.value };
      break;
    }

    specialRemotes.push({ name, type, hasAnnexUuid, mainSetting, config: remoteConfig });
  }

  return { gitRemotes, specialRemotes, config };
}

/** True when both snapshots read exactly the same `remote.*` config (staleness check). */
export function sameRemoteConfig(a: RemotesSnapshot, b: RemotesSnapshot): boolean {
  const keysA = Object.keys(a.config);
  const keysB = Object.keys(b.config);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b.config, key)) return false;
    if (a.config[key] !== b.config[key]) return false;
  }
  return true;
}

/** Editable rows = every git remote whose `kind` is `git` (single fetch URL). */
export function rowsFromSnapshot(snapshot: RemotesSnapshot): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const remote of snapshot.gitRemotes) {
    if (remote.kind !== "git") continue;
    rows.push({
      originalName: remote.name,
      name: remote.name,
      fetchUrl: remote.fetchUrls[0],
      pushUrl: remote.pushUrls.length > 0 ? remote.pushUrls[0] : null,
    });
  }
  return rows;
}

/** Validate one name; returns an English message for the first problem, or null. */
function validateName(name: string): string | null {
  if (name === "") return "remote name must not be empty";
  if (/\s/.test(name)) return "remote name must not contain whitespace";
  if (name.startsWith("-")) return "remote name must not start with \"-\"";
  if (name.includes(":")) return "remote name must not contain \":\"";
  return null;
}

/** One virtual description of an existing remote, for collision messages. */
function existingRemoteKind(snapshot: RemotesSnapshot, name: string): string | null {
  const gitRemote = snapshot.gitRemotes.find((remote) => remote.name === name);
  if (gitRemote !== undefined) {
    return gitRemote.kind === "multi-url" ? "multiple-URL remote" : "git remote";
  }
  if (snapshot.specialRemotes.some((remote) => remote.name === name)) return "special remote";
  return null;
}

/**
 * Validate the editor rows and build the ordered command plan:
 * remove -> rename -> set-url (fetch, then push) -> add.
 *
 * A plan with issues is never executable; `steps` is empty in that case.
 */
export function planRemoteChanges(rows: RemoteRow[], snapshot: RemotesSnapshot): RemotePlan {
  const issues: RemoteIssue[] = [];
  const gitByName = new Map(snapshot.gitRemotes.map((remote) => [remote.name, remote]));

  // Snapshot git remotes that disappear because their row was deleted. They are freed by the
  // leading `git remote remove` steps, so a new row may reuse those names.
  const rowOriginalNames = new Set(rows.map((row) => row.originalName).filter((name) => name !== ""));
  const removedNames = new Set(
    snapshot.gitRemotes
      .filter((remote) => remote.kind === "git" && !rowOriginalNames.has(remote.name))
      .map((remote) => remote.name),
  );

  const seenNames = new Map<string, number>();

  rows.forEach((row, index) => {
    const nameProblem = validateName(row.name);
    if (nameProblem !== null) issues.push({ row: index, field: "name", message: nameProblem });

    if (row.fetchUrl.trim() === "") {
      issues.push({ row: index, field: "fetchUrl", message: "fetch URL must not be empty" });
    }
    if (row.pushUrl !== null && row.pushUrl.trim() === "") {
      issues.push({ row: index, field: "pushUrl", message: "push URL must not be empty" });
    }

    if (row.name !== "") {
      const previous = seenNames.get(row.name);
      if (previous !== undefined) {
        issues.push({ row: index, field: "name", message: `duplicate remote name "${row.name}"` });
      } else {
        seenNames.set(row.name, index);
      }
    }

    let collides = false;
    if (row.originalName === "") {
      // New row: allowed only when the name is free after this save's removals.
      collides = row.name !== "" && !removedNames.has(row.name) && existingRemoteKind(snapshot, row.name) !== null;
    } else {
      const original = gitByName.get(row.originalName);
      if (original === undefined) {
        issues.push({ row: index, field: "name", message: `remote "${row.originalName}" no longer exists in git` });
      } else if (original.kind !== "git") {
        issues.push({
          row: index,
          field: "name",
          message: `remote "${row.originalName}" has multiple URLs; edit it with git`,
        });
      }
      if (row.name !== row.originalName && row.name !== "") {
        collides = !removedNames.has(row.name) && existingRemoteKind(snapshot, row.name) !== null;
      }
    }
    if (collides) {
      const kind = existingRemoteKind(snapshot, row.name) ?? "remote";
      issues.push({ row: index, field: "name", message: `remote "${row.name}" already exists (${kind})` });
    }
  });

  if (issues.length > 0) return { steps: [], issues };

  const steps: RemoteStep[] = [];

  // 1. Removals, in snapshot order.
  for (const remote of snapshot.gitRemotes) {
    if (remote.kind !== "git" || rowOriginalNames.has(remote.name)) continue;
    steps.push({
      kind: "remove",
      name: remote.name,
      args: ["remote", "remove", remote.name],
      describe: `remove ${remote.name}`,
    });
  }

  // 2. Renames. `git remote rename` moves remote.<name>.* (annex-uuid / annex-ignore included)
  //    and the remote-tracking refs.
  for (const row of rows) {
    if (row.originalName === "" || row.name === row.originalName) continue;
    steps.push({
      kind: "rename",
      name: row.name,
      previousName: row.originalName,
      args: ["remote", "rename", row.originalName, row.name],
      describe: `rename ${row.originalName} to ${row.name}`,
    });
  }

  // 3. Fetch URL changes (against the row's final name, so renames work first).
  for (const row of rows) {
    if (row.originalName === "") continue;
    const original = gitByName.get(row.originalName);
    if (original === undefined || original.kind !== "git") continue;
    if (row.fetchUrl === original.fetchUrls[0]) continue;
    steps.push({
      kind: "set-fetch-url",
      name: row.name,
      args: ["remote", "set-url", row.name, row.fetchUrl],
      describe: `set fetch URL for ${row.name}`,
    });
  }

  // 4. Push URL changes: clear (delete), add, or change. kind "git" has at most one pushurl.
  for (const row of rows) {
    if (row.originalName === "") continue;
    const original = gitByName.get(row.originalName);
    if (original === undefined || original.kind !== "git") continue;
    const previous = original.pushUrls.length > 0 ? original.pushUrls[0] : null;
    if (previous === row.pushUrl) continue;
    if (row.pushUrl === null) {
      steps.push({
        kind: "delete-push-url",
        name: row.name,
        args: ["remote", "set-url", "--delete", "--push", row.name, previous ?? ""],
        describe: `remove push URL for ${row.name}`,
      });
    } else {
      steps.push({
        kind: "set-push-url",
        name: row.name,
        args: ["remote", "set-url", "--push", row.name, row.pushUrl],
        describe: `set push URL for ${row.name}`,
      });
    }
  }

  // 5. New rows.
  for (const row of rows) {
    if (row.originalName !== "") continue;
    steps.push({
      kind: "add",
      name: row.name,
      args: ["remote", "add", row.name, row.fetchUrl],
      describe: `add remote ${row.name}`,
    });
    if (row.pushUrl !== null) {
      steps.push({
        kind: "set-push-url",
        name: row.name,
        args: ["remote", "set-url", "--push", row.name, row.pushUrl],
        describe: `set push URL for ${row.name}`,
      });
    }
  }

  return { steps, issues: [] };
}

/** Execute the plan in order; stop at the first failure. No rollback. */
export function applyRemotePlan(dir: string, plan: RemotePlan): RemoteApplyResult {
  // Defensive: a plan with validation issues must never touch the repository.
  if (plan.issues.length > 0) return { results: [], failed: null, ok: false };

  const results: RemoteStepResult[] = [];
  for (const step of plan.steps) {
    const res = git(step.args, dir);
    if (res.code !== 0) {
      const detail = res.stderr.trim() !== "" ? res.stderr.trim() : res.stdout.trim();
      results.push({ step, ok: false, detail });
      return { results, failed: step, ok: false };
    }
    results.push({ step, ok: true });
  }
  return { results, failed: null, ok: true };
}

const SPECIAL_REMOTE_DOCS = "https://git-annex.branchable.com/special_remotes/";

/** Page slug per known built-in special-remote type (only pages that exist on the wiki). */
const SPECIAL_REMOTE_SLUGS: Record<string, string> = {
  adb: "adb",
  bittorrent: "bittorrent",
  borg: "borg",
  bup: "bup",
  compute: "compute",
  ddar: "ddar",
  directory: "directory",
  gcrypt: "gcrypt",
  git: "git",
  "git-lfs": "git-lfs",
  glacier: "glacier",
  hook: "hook",
  httpalso: "httpalso",
  p2p: "p2p",
  rclone: "rclone",
  rsync: "rsync",
  s3: "S3",
  tahoe: "tahoe",
  tor: "tor",
  web: "web",
  webdav: "webdav",
};

/** Documentation link for a special remote: its type page when known, the index otherwise. */
export function specialRemoteDocUrl(remote: SpecialRemote): string {
  // External special remotes are documented on one page, whatever their external type is.
  if (remote.config["type"] === "external") return `${SPECIAL_REMOTE_DOCS}external/`;
  const slug = SPECIAL_REMOTE_SLUGS[remote.type.toLowerCase()];
  return slug === undefined ? SPECIAL_REMOTE_DOCS : `${SPECIAL_REMOTE_DOCS}${slug}/`;
}
