/**
 * Git remotes, read from and written to `.git/config` — the single source of truth.
 *
 * Contract (implemented by the core slice, consumed by the UI + cleanup slices):
 *   - `readRemotes(dir)` reads `git config --get-regexp '^remote\.'` plus the git-annex
 *     branch's `remote.log`; `hasRepo` is false when `git rev-parse --git-dir` fails
 *     (a repository whose config cannot be parsed is reported via `configError`).
 *   - `rowsFromSnapshot()` turns the editable (single-URL) git remotes into editor rows.
 *   - `planRemoteChanges(rows, snapshot)` validates the rows and produces an ordered
 *     command plan: remove -> rename -> set-url (fetch, push) -> add. `issues` is
 *     non-empty when anything is invalid; a plan with issues must never be executed.
 *   - `applyRemotePlan(dir, plan)` runs the steps in order and stops at the first failure
 *     (no rollback — the caller reports partial progress and reloads).
 *   - `sameRemoteConfig(a, b)` is the staleness check: the raw `remote.*` config and
 *     `remote.log` must be identical between the snapshot the editor was rendered from
 *     and a fresh read.
 *
 * Nothing in this module fetches, pushes, or touches git-annex content: only remote
 * configuration is read or written (see the `no-transfer-ops` policy).
 */
import * as fs from "fs";
import * as path from "path";
import { git } from "./git";

/** A remote that carries a URL (shown as an editable row when it has exactly one URL). */
export interface GitRemote {
  name: string;
  /** `remote.<name>.url` values, in config order. */
  fetchUrls: string[];
  /** `remote.<name>.pushurl` values, in config order (empty = push reuses the fetch URL). */
  pushUrls: string[];
  /**
   * `multi-url` = anything not editable: more than one fetch URL, more than one push URL,
   * or a remote that has only push URLs. Such remotes are read-only in the editor.
   */
  kind: "git" | "multi-url";
  /** `remote.<name>.annex-uuid` is present: git-annex tracks this remote. */
  hasAnnexUuid: boolean;
}

/** A git-annex special remote: `annex-*` keys, no `url` and no `pushurl`. */
export interface SpecialRemote {
  name: string;
  /** Display type: `externalType` for external remotes, else the git-annex type. */
  type: string;
  /** Raw git-annex type from `remote.log` (fallback: legacy config keys), e.g. `directory`. */
  baseType: string;
  /** External type (e.g. `rclone`); empty unless {@link baseType} is `external`. */
  externalType: string;
  /** `remote.<name>.annex-uuid` is present. */
  hasAnnexUuid: boolean;
  /** The main setting to display (e.g. `directory` → `/Volumes/Archive`), if any. */
  mainSetting: { key: string; value: string } | null;
  /** Every `remote.<name>.*` key (prefix stripped) → ordered values, in config order. */
  config: Record<string, string[]>;
}

/** Everything the settings page needs to know about the repository's remotes. */
export interface RemotesSnapshot {
  /** False when `dir` is not inside a git repository (or git is unavailable). */
  hasRepo: boolean;
  /** Every remote that has a fetch or push URL, editable and read-only alike. */
  gitRemotes: GitRemote[];
  /** Every git-annex special remote (no URL). */
  specialRemotes: SpecialRemote[];
  /** Raw `remote.<name>.<key>` → ordered values as read from git, for the staleness check. */
  config: Record<string, string[]>;
  /** Raw content of `git show git-annex:remote.log` (`""` when the branch/page is absent). */
  remoteLog: string;
  /** Set when git config could not be read (e.g. a broken `.git/config`); lists are empty. */
  configError?: string;
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

function emptySnapshot(hasRepo: boolean): RemotesSnapshot {
  return { hasRepo, gitRemotes: [], specialRemotes: [], config: {}, remoteLog: "" };
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

/** Trim a URL value and treat a whitespace-only string as absent. */
function trimOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Find the repository root without asking git (git cannot even read a broken config). */
function hasGitDirectory(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function errorText(code: number, stderr: string, stdout: string): string {
  const text = stderr.trim() !== "" ? stderr.trim() : stdout.trim();
  return text !== "" ? text : `git exited with code ${code}`;
}

/** `git show git-annex:remote.log` — read-only; an absent git-annex branch means no log. */
function readRemoteLog(dir: string): string {
  const res = git(["show", "git-annex:remote.log"], dir);
  return res.code === 0 ? res.stdout : "";
}

/** Read `git config --get-regexp '^remote\.'` + `remote.log` and classify every remote. Never throws. */
export function readRemotes(dir: string): RemotesSnapshot {
  const repo = git(["rev-parse", "--git-dir"], dir);
  if (repo.code !== 0) {
    // `-1` = git could not even be started; keep the contract's "no repo / no git" result.
    if (repo.code === -1) return emptySnapshot(false);
    // A broken `.git/config` makes even `rev-parse` fail; do not parse localized git
    // messages — look for `.git` ourselves so the error is surfaced instead of hidden
    // behind "not a git repo".
    if (hasGitDirectory(dir)) {
      return { ...emptySnapshot(true), configError: errorText(repo.code, repo.stderr, repo.stdout) };
    }
    return emptySnapshot(false);
  }

  // `-z` keeps values with spaces / newlines intact; exit code 1 simply means "no matches".
  const res = git(["config", "-z", "--get-regexp", "^remote\\."], dir);
  if (res.code !== 0 && res.code !== 1) {
    return { ...emptySnapshot(true), configError: errorText(res.code, res.stderr, res.stdout) };
  }

  const remoteLog = readRemoteLog(dir);
  const parsed = parseRemoteConfig(res.code === 0 ? res.stdout : "", remoteLog);
  return { hasRepo: true, ...parsed, remoteLog };
}

/** Decode git-annex's `&NN;` decimal character escapes (space is `&32;`). */
function decodeAnnexValue(value: string): string {
  return value.replace(/&(\d+);/g, (_match, digits: string) => String.fromCharCode(Number(digits)));
}

interface RemoteLogEntry {
  uuid: string;
  name: string;
  type: string;
  externalType: string;
  /** Decoded `k=v` fields in log order (including name/type/externaltype). */
  fields: Record<string, string>;
}

/**
 * Parse `remote.log`: one line per special remote, `<uuid> name=<name> type=<type> …`,
 * with reserved characters escaped as `&NN;`. Later lines win for the same uuid/name.
 */
function parseRemoteLog(text: string): {
  byUuid: Map<string, RemoteLogEntry>;
  byName: Map<string, RemoteLogEntry>;
} {
  const byUuid = new Map<string, RemoteLogEntry>();
  const byName = new Map<string, RemoteLogEntry>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const tokens = line.split(" ").filter((token) => token !== "");
    if (tokens.length === 0) continue;
    const uuid = tokens[0];
    const fields: Record<string, string> = {};
    for (let index = 1; index < tokens.length; index += 1) {
      const equals = tokens[index].indexOf("=");
      if (equals <= 0) continue;
      fields[tokens[index].slice(0, equals)] = decodeAnnexValue(tokens[index].slice(equals + 1));
    }
    const entry: RemoteLogEntry = {
      uuid,
      name: fields["name"] ?? "",
      type: fields["type"] ?? "",
      externalType: fields["externaltype"] ?? "",
      fields,
    };
    const previous = byUuid.get(uuid);
    if (previous !== undefined && previous.name !== "" && byName.get(previous.name) === previous) {
      byName.delete(previous.name);
    }
    byUuid.set(uuid, entry);
    if (entry.name !== "") byName.set(entry.name, entry);
  }
  return { byUuid, byName };
}

/** Per-type parameter key (without the `annex-` prefix) to show as the main setting. */
const TYPE_MAIN_SETTING: Record<string, string> = {
  directory: "directory",
  rsync: "rsyncurl",
  web: "url",
  webdav: "url",
  bup: "buprepo",
  ddar: "ddarrepo",
  gcrypt: "gitrepo",
  s3: "bucket",
  "git-lfs": "url",
};

/** `annex-*` keys that describe the remote rather than its location/storage. */
const BOOKKEEPING_ANNEX_KEYS = new Set([
  "annex-uuid",
  "annex-verified",
  "annex-cost",
  "annex-cost-command",
  "annex-ignore",
  "annex-availability",
  "annex-description",
  "annex-wanted",
  "annex-rsync-options",
  "annex-ssh-options",
  "annex-externaltype",
]);

/** True for bookkeeping keys; `annex-webdav-*` holds credentials, so never show it. */
function isBookkeepingAnnexKey(key: string): boolean {
  return BOOKKEEPING_ANNEX_KEYS.has(key) || key.startsWith("annex-webdav-");
}

/** `remote.log` fields that describe the entry rather than a user setting. */
const LOG_NON_SETTING_FIELDS = new Set(["name", "type", "externaltype", "uuid", "encryption", "timestamp"]);

/** Pick the main setting: per-type config key, first usable config key, then remote.log. */
function mainSettingFor(
  entries: { key: string; value: string }[],
  baseType: string,
  logEntry: RemoteLogEntry | undefined,
): { key: string; value: string } | null {
  const annexValues = entries
    .filter((entry) => entry.key.startsWith("annex-"))
    .map((entry) => ({ key: entry.key.slice("annex-".length), value: entry.value }));
  const preferred = TYPE_MAIN_SETTING[baseType.toLowerCase()];
  if (preferred !== undefined) {
    const hit = annexValues.find((entry) => entry.key === preferred);
    if (hit !== undefined) return hit;
  }
  const usable = annexValues.find((entry) => !isBookkeepingAnnexKey(`annex-${entry.key}`));
  if (usable !== undefined) return usable;

  if (logEntry !== undefined) {
    if (preferred !== undefined) {
      const value = logEntry.fields[preferred];
      if (value !== undefined) return { key: preferred, value };
    }
    for (const [key, value] of Object.entries(logEntry.fields)) {
      if (LOG_NON_SETTING_FIELDS.has(key)) continue;
      if (isBookkeepingAnnexKey(`annex-${key}`)) continue;
      return { key, value };
    }
  }
  return null;
}

/**
 * Parse the NUL-separated output of `git config -z --get-regexp '^remote\.'`.
 *
 * `remoteLog` is the raw `git show git-annex:remote.log` content; special-remote types
 * come from there because git-annex never writes `remote.<name>.type` to `.git/config`.
 */
export function parseRemoteConfig(
  stdout: string,
  remoteLog = "",
): Pick<RemotesSnapshot, "gitRemotes" | "specialRemotes" | "config"> {
  /** name -> ordered entries; a remote can repeat a key (`url`), so keep every value. */
  const byName = new Map<string, { key: string; value: string }[]>();
  const config: Record<string, string[]> = {};

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
    if (config[key] === undefined) config[key] = [];
    config[key].push(value);
    const entries = byName.get(parsed.name);
    if (entries === undefined) byName.set(parsed.name, [{ key: parsed.subkey, value }]);
    else entries.push({ key: parsed.subkey, value });
  }

  const { byUuid, byName: logByName } = parseRemoteLog(remoteLog);
  const gitRemotes: GitRemote[] = [];
  const specialRemotes: SpecialRemote[] = [];

  for (const [name, entries] of byName) {
    const urls = entries.filter((entry) => entry.key === "url").map((entry) => entry.value);
    const pushUrls = entries.filter((entry) => entry.key === "pushurl").map((entry) => entry.value);
    const hasAnnexUuid = entries.some((entry) => entry.key === "annex-uuid");

    if (urls.length > 0 || pushUrls.length > 0) {
      gitRemotes.push({
        name,
        fetchUrls: urls,
        pushUrls,
        kind: urls.length === 1 && pushUrls.length <= 1 ? "git" : "multi-url",
        hasAnnexUuid,
      });
      continue;
    }

    const annexEntries = entries.filter((entry) => entry.key.startsWith("annex-"));
    if (annexEntries.length === 0) continue;

    const remoteConfig: Record<string, string[]> = {};
    for (const entry of entries) {
      if (remoteConfig[entry.key] === undefined) remoteConfig[entry.key] = [];
      remoteConfig[entry.key].push(entry.value);
    }

    const uuid = remoteConfig["annex-uuid"]?.[0];
    const logEntry = (uuid !== undefined ? byUuid.get(uuid) : undefined) ?? logByName.get(name);

    let baseType = logEntry?.type ?? "";
    let externalType = logEntry?.externalType ?? "";
    if (logEntry === undefined) {
      // Legacy fallback: older/partial snapshots may only have these config keys.
      baseType = remoteConfig["type"]?.[0] ?? "";
      externalType = remoteConfig["externaltype"]?.[0] ?? remoteConfig["annex-externaltype"]?.[0] ?? "";
      if (baseType === "" && externalType !== "") baseType = "external";
    }
    if (baseType !== "external") externalType = "";
    const type = baseType === "external" ? externalType : baseType;

    specialRemotes.push({
      name,
      type,
      baseType,
      externalType,
      hasAnnexUuid,
      mainSetting: mainSettingFor(entries, baseType, logEntry),
      config: remoteConfig,
    });
  }

  return { gitRemotes, specialRemotes, config };
}

/** True when both snapshots read exactly the same `remote.*` config and `remote.log`. */
export function sameRemoteConfig(a: RemotesSnapshot, b: RemotesSnapshot): boolean {
  const keysA = Object.keys(a.config);
  const keysB = Object.keys(b.config);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b.config, key)) return false;
    const valuesA = a.config[key];
    const valuesB = b.config[key];
    if (valuesA.length !== valuesB.length) return false;
    for (let index = 0; index < valuesA.length; index += 1) {
      if (valuesA[index] !== valuesB[index]) return false;
    }
  }
  return (a.remoteLog ?? "") === (b.remoteLog ?? "");
}

/** Editable rows = every git remote whose `kind` is `git` (single fetch URL). */
export function rowsFromSnapshot(snapshot: RemotesSnapshot): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const remote of snapshot.gitRemotes) {
    if (remote.kind !== "git") continue;
    rows.push({
      originalName: remote.name,
      name: remote.name,
      fetchUrl: remote.fetchUrls[0].trim(),
      pushUrl: remote.pushUrls.length > 0 ? trimOrNull(remote.pushUrls[0]) : null,
    });
  }
  return rows;
}

/**
 * Validate one remote name against the rules git applies to `refs/remotes/<name>`.
 * Returns an English message for the first problem, or null when the name is usable.
 */
function validateName(name: string): string | null {
  if (name === "") return "remote name must not be empty";
  if (/[\s\x00-\x1f\x7f]/.test(name)) return "remote name must not contain whitespace or control characters";
  if (name.startsWith("-")) return "remote name must not start with \"-\"";
  if (name.includes("..")) return "remote name must not contain \"..\"";
  if (name.includes("@{")) return "remote name must not contain \"@{\"";
  for (const char of "~^:?*[\\") {
    if (name.includes(char)) return `remote name must not contain "${char}"`;
  }
  if (name.startsWith("/") || name.endsWith("/")) return "remote name must not start or end with \"/\"";
  const components = name.split("/");
  for (const component of components) {
    if (component === "") return "remote name must not contain an empty path component";
    if (component.startsWith(".")) return "remote name must not have a path component starting with \".\"";
    if (component.endsWith(".lock")) return "remote name must not have a path component ending with \".lock\"";
  }
  return null;
}

/** One virtual description of an existing remote, for collision messages. */
function existingRemoteKind(snapshot: RemotesSnapshot, name: string): string | null {
  const gitRemote = snapshot.gitRemotes.find((remote) => remote.name === name);
  if (gitRemote !== undefined) {
    return gitRemote.kind === "multi-url" ? "read-only remote" : "git remote";
  }
  if (snapshot.specialRemotes.some((remote) => remote.name === name)) return "special remote";
  return null;
}

/**
 * Order renames so a rename whose target is another row's original name runs after that
 * row's rename. Returns the rows in execution order plus whether a dependency cycle exists.
 */
function orderRenames(rows: RemoteRow[]): { ordered: RemoteRow[]; cycle: boolean } {
  const changing = rows.filter((row) => row.originalName !== "" && row.name !== row.originalName);
  const byOriginal = new Map(changing.map((row) => [row.originalName, row]));
  const state = new Map<RemoteRow, 0 | 1 | 2>();
  const ordered: RemoteRow[] = [];
  let cycle = false;

  const visit = (row: RemoteRow): void => {
    const status = state.get(row) ?? 0;
    if (status === 1) {
      cycle = true;
      return;
    }
    if (status === 2) return;
    state.set(row, 1);
    const dependency = byOriginal.get(row.name);
    if (dependency !== undefined && dependency !== row) visit(dependency);
    state.set(row, 2);
    ordered.push(row);
  };
  for (const row of changing) visit(row);
  return { ordered, cycle };
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

  const rowOriginalNames = new Set(rows.map((row) => row.originalName).filter((name) => name !== ""));
  // Names freed before the add/set-url steps run: deleted remotes and rename sources.
  const removedNames = new Set(
    snapshot.gitRemotes
      .filter((remote) => remote.kind === "git" && !rowOriginalNames.has(remote.name))
      .map((remote) => remote.name),
  );
  const renameSources = new Set(
    rows
      .filter((row) => row.originalName !== "" && row.name !== row.originalName)
      .map((row) => row.originalName),
  );
  const freedNames = new Set([...removedNames, ...renameSources]);

  const seenNames = new Map<string, number>();

  rows.forEach((row, index) => {
    const fetchUrl = row.fetchUrl.trim();
    const pushUrl = trimOrNull(row.pushUrl);
    const nameProblem = validateName(row.name);
    if (nameProblem !== null) issues.push({ row: index, field: "name", message: nameProblem });

    if (fetchUrl === "") {
      issues.push({ row: index, field: "fetchUrl", message: "fetch URL must not be empty" });
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
      // New row: allowed only when this save frees the name before the add steps.
      collides = row.name !== "" && !freedNames.has(row.name) && existingRemoteKind(snapshot, row.name) !== null;
    } else {
      const original = gitByName.get(row.originalName);
      if (original === undefined) {
        issues.push({ row: index, field: "name", message: `remote "${row.originalName}" no longer exists in git` });
      } else if (original.kind !== "git") {
        issues.push({
          row: index,
          field: "name",
          message: `remote "${row.originalName}" is read-only; edit it with git`,
        });
      }
      if (row.name !== row.originalName && row.name !== "") {
        collides = !freedNames.has(row.name) && existingRemoteKind(snapshot, row.name) !== null;
      }
    }
    if (collides) {
      const kind = existingRemoteKind(snapshot, row.name) ?? "remote";
      issues.push({ row: index, field: "name", message: `remote "${row.name}" already exists (${kind})` });
    }
  });

  const renames = orderRenames(rows);
  if (renames.cycle) {
    issues.push({
      row: null,
      field: "name",
      message: "remote renames form a cycle; rename the remotes one at a time",
    });
  }

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

  // 2. Renames, ordered so a rename into another row's old name runs after that rename.
  //    `git remote rename` moves remote.<name>.* (annex-uuid / annex-ignore included)
  //    and the remote-tracking refs.
  for (const row of renames.ordered) {
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
    const fetchUrl = row.fetchUrl.trim();
    if (fetchUrl === original.fetchUrls[0].trim()) continue;
    steps.push({
      kind: "set-fetch-url",
      name: row.name,
      args: ["remote", "set-url", row.name, fetchUrl],
      describe: `set fetch URL for ${row.name}`,
    });
  }

  // 4. Push URL changes: clear, add, or change. kind "git" has at most one pushurl.
  //    Clearing goes through `git config --unset-all` because `set-url --delete --push`
  //    treats the previous URL as a regex (URLs with `+`, `?`, `[` … would not match).
  for (const row of rows) {
    if (row.originalName === "") continue;
    const original = gitByName.get(row.originalName);
    if (original === undefined || original.kind !== "git") continue;
    const previous = original.pushUrls.length > 0 ? trimOrNull(original.pushUrls[0]) : null;
    const pushUrl = trimOrNull(row.pushUrl);
    if (previous === pushUrl) continue;
    if (pushUrl === null) {
      steps.push({
        kind: "delete-push-url",
        name: row.name,
        args: ["config", "--unset-all", `remote.${row.name}.pushurl`],
        describe: `remove push URL for ${row.name}`,
      });
    } else {
      steps.push({
        kind: "set-push-url",
        name: row.name,
        args: ["remote", "set-url", "--push", row.name, pushUrl],
        describe: `set push URL for ${row.name}`,
      });
    }
  }

  // 5. New rows.
  for (const row of rows) {
    if (row.originalName !== "") continue;
    const fetchUrl = row.fetchUrl.trim();
    const pushUrl = trimOrNull(row.pushUrl);
    steps.push({
      kind: "add",
      name: row.name,
      args: ["remote", "add", row.name, fetchUrl],
      describe: `add remote ${row.name}`,
    });
    if (pushUrl !== null) {
      steps.push({
        kind: "set-push-url",
        name: row.name,
        args: ["remote", "set-url", "--push", row.name, pushUrl],
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
  if (remote.baseType === "external") return `${SPECIAL_REMOTE_DOCS}external/`;
  const slug = SPECIAL_REMOTE_SLUGS[remote.type.toLowerCase()];
  return slug === undefined ? SPECIAL_REMOTE_DOCS : `${SPECIAL_REMOTE_DOCS}${slug}/`;
}
