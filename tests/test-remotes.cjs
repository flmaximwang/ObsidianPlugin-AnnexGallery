#!/usr/bin/env node
/**
 * test-remotes —— the git-config remotes model (parse / classify / plan / apply).
 *
 *   node tests/test-remotes.cjs
 *
 * Covers annex-gallery-10m and the PR #2 review fixes:
 *   · reading `git config --get-regexp '^remote\.'` + `git show git-annex:remote.log`
 *     (pushurl, multi-URL, pushurl-only, special remotes, external special remotes,
 *     escaped remote.log values, dotted names, valueless keys, no repo, config errors)
 *   · duplicate config keys kept as ordered arrays, and staleness covering them and
 *     `remote.log`
 *   · rowsFromSnapshot + exact command ordering (remove -> rename -> set-url fetch ->
 *     push -> add), including rename chains, rename-freed names and cycles
 *   · validation: real git name rules, empty URLs, duplicates, collisions
 *   · real-git integration: rename keeps annex-uuid / annex-ignore / pushurl, delete +
 *     re-add, push-URL clear for regex-heavy URLs, apply stops at the first failure
 *   · real `git annex initremote … type=directory` fixture (SKIP only if git-annex is
 *     missing) asserting type, main setting and doc link
 *
 * Everything runs in throwaway repos under os.tmpdir(), cleaned up at the end.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "annex-test-remotes-"));

let pass = 0;
let fail = 0;
const failures = [];

function check(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${message}`);
  } else {
    fail += 1;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function skip(message) {
  console.log(`  SKIP: ${message}`);
}

function section(title) {
  console.log(`\n==== ${title} ====`);
}

/** src/core/remotes.ts -> temporary CJS bundle, exports the module. */
async function loadModule() {
  const esbuild = require("esbuild");
  const out = path.join(WORK, "remotes.bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(REPO, "src", "core", "remotes.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "warning",
  });
  return require(out);
}

function git(dir, ...args) {
  try {
    return {
      code: 0,
      stdout: execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: "",
      stderr: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim(),
    };
  }
}

const gitOk = (dir, ...args) => {
  const res = git(dir, ...args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${res.stderr}`);
  return res.stdout;
};

/** Run a command in a directory without leaking its stderr. */
function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function makeRepo(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-q", "-b", "main");
  gitOk(dir, "config", "user.email", "test@example.com");
  gitOk(dir, "config", "user.name", "test");
  return dir;
}

/** Build the NUL-separated stdout `git config -z --get-regexp` would print. */
function configStdout(pairs) {
  return pairs.map(([key, value]) => `${key}\n${value}\0`).join("");
}

function stepArgs(steps) {
  return steps.map((step) => step.args.join(" "));
}

const ANNEX_AVAILABLE = sh("git", ["annex", "version"]).status === 0;
if (ANNEX_AVAILABLE) console.log("git-annex available: real special-remote fixture will run.");

/**
 * remote.log samples captured on this machine with git-annex 10.20261026.
 * (The external one was produced by a real `git annex initremote type=external
 * externaltype=rclone` run; `remote.log` escapes spaces as `&32;` and `&` as `&38;`.)
 */
const REMOTE_LOG_DIRECTORY =
  "7b808095-d557-4450-b45e-2225bc9cf1df encryption=none name=archive type=directory timestamp=1794043890s";
const REMOTE_LOG_EXTERNAL =
  "4f6a3f01-8c36-43b2-b121-e9f978bc5b08 encryption=none externaltype=rclone name=cloud rcloneremotename=remote:backup type=external timestamp=1794044022s";
const REMOTE_LOG_EXTERNAL_ESCAPED =
  "006cd0fd-6ce3-4384-af36-9f940c204008 encryption=none externaltype=rclone name=cloud rcloneremotename=remote:my&32;backup&32;&38;&32;more type=external timestamp=1794044048s";

(async () => {
  const remotes = await loadModule();

  // ────────────────────────────────────────────────────────────────────────────
  section("parsing: git config (pushurl / multi-url / pushurl-only / dotted / valueless)");
  {
    const repo = makeRepo("parse");
    gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/push");

    gitOk(repo, "remote", "add", "multi", "ssh://example/multi-1");
    gitOk(repo, "remote", "set-url", "--add", "multi", "ssh://example/multi-2");

    gitOk(repo, "remote", "add", "multipush", "ssh://example/mp");
    gitOk(repo, "remote", "set-url", "--add", "--push", "multipush", "ssh://example/mp-push-1");
    gitOk(repo, "remote", "set-url", "--add", "--push", "multipush", "ssh://example/mp-push-2");

    // A remote with push URLs but no fetch URL must still be visible (read-only).
    gitOk(repo, "config", "remote.pushonly.pushurl", "ssh://example/push-only");

    // Names may contain dots; a bare key has no value.
    gitOk(repo, "config", "remote.dotted.name.url", "ssh://example/dotted");
    fs.appendFileSync(
      path.join(repo, ".git", "config"),
      '\n[remote "valueless"]\n\turl = ssh://example/valueless\n\tbarekey\n',
    );
    // A key with a single dot is not a per-remote setting and must be ignored.
    gitOk(repo, "config", "remote.pushdefault", "origin");

    const snapshot = remotes.readRemotes(repo);
    check(snapshot.hasRepo === true, "hasRepo is true for a real repository");
    check(snapshot.configError === undefined, "no configError for a healthy repository");
    check(snapshot.remoteLog === "", "no git-annex branch => empty remoteLog");
    check(snapshot.gitRemotes.length === 6, `6 git remotes parsed (got ${snapshot.gitRemotes.length})`);
    check(snapshot.specialRemotes.length === 0, "no special remotes without a remote.log entry");

    const origin = snapshot.gitRemotes.find((remote) => remote.name === "origin");
    check(origin.kind === "git", 'origin is kind "git"');
    check(origin.fetchUrls.join(",") === "ssh://example/origin", "origin fetch URL parsed");
    check(origin.pushUrls.join(",") === "ssh://example/push", "origin push URL parsed");

    const multi = snapshot.gitRemotes.find((remote) => remote.name === "multi");
    check(multi.kind === "multi-url" && multi.fetchUrls.length === 2, "two fetch URLs => multi-url");
    check(
      multi.fetchUrls.join(",") === "ssh://example/multi-1,ssh://example/multi-2",
      "multi-url fetch URLs keep config order",
    );
    check(
      snapshot.config["remote.multi.url"].join(",") === "ssh://example/multi-1,ssh://example/multi-2",
      "duplicate config keys are kept as an ordered array",
    );

    const multiPush = snapshot.gitRemotes.find((remote) => remote.name === "multipush");
    check(multiPush.kind === "multi-url" && multiPush.pushUrls.length === 2, "two push URLs => multi-url");

    const pushOnly = snapshot.gitRemotes.find((remote) => remote.name === "pushonly");
    check(pushOnly !== undefined, "pushurl-only remote is visible (not skipped)");
    check(pushOnly.kind === "multi-url" && pushOnly.fetchUrls.length === 0, "pushurl-only remote is read-only");

    const dotted = snapshot.gitRemotes.find((remote) => remote.name === "dotted.name");
    check(dotted !== undefined && dotted.fetchUrls[0] === "ssh://example/dotted", "dotted remote name round-trips");

    const valueless = snapshot.gitRemotes.find((remote) => remote.name === "valueless");
    check(valueless !== undefined, "remote with a valueless key is still a git remote");
    check(
      snapshot.config["remote.valueless.barekey"].length === 1 && snapshot.config["remote.valueless.barekey"][0] === "",
      "valueless config key maps to [\"\"]",
    );
    check(!Object.prototype.hasOwnProperty.call(snapshot.config, "remote.pushdefault"), "remote.pushdefault is skipped");

    const again = remotes.readRemotes(repo);
    check(remotes.sameRemoteConfig(snapshot, again) === true, "sameRemoteConfig true for two identical reads");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/push-changed");
    check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === false, "push-URL change is detected");

    const noRepo = remotes.readRemotes(path.join(WORK, "does-not-exist"));
    check(noRepo.hasRepo === false, "no repo => hasRepo false");
    check(noRepo.gitRemotes.length === 0 && noRepo.specialRemotes.length === 0, "no repo => no remotes");
    check(Object.keys(noRepo.config).length === 0 && noRepo.remoteLog === "", "no repo => empty config and log");

    const emptyRepo = makeRepo("empty-repo");
    const emptySnapshot = remotes.readRemotes(emptyRepo);
    check(emptySnapshot.hasRepo === true && emptySnapshot.gitRemotes.length === 0, "repo without remotes => hasRepo true, no rows");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("parsing: duplicate config keys and remote.log staleness");
  {
    const stdoutA = configStdout([
      ["remote.multi.url", "a://one"],
      ["remote.multi.url", "a://two"],
      ["remote.multi.pushurl", "p://one"],
      ["remote.multi.pushurl", "p://two"],
    ]);
    const s1 = { hasRepo: true, ...remotes.parseRemoteConfig(stdoutA, REMOTE_LOG_DIRECTORY), remoteLog: REMOTE_LOG_DIRECTORY };
    const s1Again = { hasRepo: true, ...remotes.parseRemoteConfig(stdoutA, REMOTE_LOG_DIRECTORY), remoteLog: REMOTE_LOG_DIRECTORY };
    check(remotes.sameRemoteConfig(s1, s1Again) === true, "identical reads with duplicate keys are equal");

    const firstUrlChanged = configStdout([
      ["remote.multi.url", "a://ATTACKER"],
      ["remote.multi.url", "a://two"],
      ["remote.multi.pushurl", "p://one"],
      ["remote.multi.pushurl", "p://two"],
    ]);
    const s2 = { hasRepo: true, ...remotes.parseRemoteConfig(firstUrlChanged, REMOTE_LOG_DIRECTORY), remoteLog: REMOTE_LOG_DIRECTORY };
    check(remotes.sameRemoteConfig(s1, s2) === false, "changing the FIRST fetch URL of a multi-URL remote is detected");

    const firstPushDeleted = configStdout([
      ["remote.multi.url", "a://one"],
      ["remote.multi.url", "a://two"],
      ["remote.multi.pushurl", "p://two"],
    ]);
    const s3 = { hasRepo: true, ...remotes.parseRemoteConfig(firstPushDeleted, REMOTE_LOG_DIRECTORY), remoteLog: REMOTE_LOG_DIRECTORY };
    check(remotes.sameRemoteConfig(s1, s3) === false, "deleting the FIRST push URL is detected");

    const logChanged = { hasRepo: true, ...remotes.parseRemoteConfig(stdoutA, `${REMOTE_LOG_DIRECTORY} extra=1`), remoteLog: `${REMOTE_LOG_DIRECTORY} extra=1` };
    check(remotes.sameRemoteConfig(s1, logChanged) === false, "a remote.log change is detected");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("parsing: special-remote type comes from remote.log");
  {
    // Real git-annex writes only remote.<name>.annex-directory / annex-uuid / annex-verified
    // for type=directory; there is no `type=` key. Type lives in remote.log.
    const directoryConfig = configStdout([
      ["remote.archive.annex-directory", "/Volumes/Archive"],
      ["remote.archive.annex-uuid", "7b808095-d557-4450-b45e-2225bc9cf1df"],
      ["remote.archive.annex-verified", "verified"],
      ["remote.archive.skipfetchall", "true"],
    ]);
    const directory = remotes.parseRemoteConfig(directoryConfig, REMOTE_LOG_DIRECTORY);
    check(directory.specialRemotes.length === 1, "directory fixture yields one special remote");
    const archive = directory.specialRemotes[0];
    check(archive.type === "directory" && archive.baseType === "directory", "type/baseType are directory");
    check(archive.externalType === "", "non-external remote has no externalType");
    check(archive.hasAnnexUuid === true, "hasAnnexUuid is true");
    check(
      archive.mainSetting !== null && archive.mainSetting.key === "directory" && archive.mainSetting.value === "/Volumes/Archive",
      "mainSetting is the annex-directory value (not skipfetchall)",
    );
    check(
      remotes.specialRemoteDocUrl(archive) === "https://git-annex.branchable.com/special_remotes/directory/",
      "directory remote links to the directory doc page",
    );

    // Synthetic config: a legacy `type=` key must NOT override the captured remote.log.
    const legacyMismatch = remotes.parseRemoteConfig(
      configStdout([
        ["remote.archive.annex-uuid", "7b808095-d557-4450-b45e-2225bc9cf1df"],
        ["remote.archive.annex-directory", "/Volumes/Archive"],
      ]) + configStdout([["remote.archive.type", "rsync"]]),
      REMOTE_LOG_DIRECTORY,
    );
    check(
      legacyMismatch.specialRemotes[0].baseType === "directory",
      "remote.log wins over a legacy remote.<name>.type key",
    );

    // Captured external remote (real git-annex 10.20261026 run).
    const externalConfig = configStdout([
      ["remote.cloud.annex-externaltype", "rclone"],
      ["remote.cloud.annex-uuid", "4f6a3f01-8c36-43b2-b121-e9f978bc5b08"],
      ["remote.cloud.annex-verified", "verified"],
      ["remote.cloud.skipfetchall", "true"],
    ]);
    const external = remotes.parseRemoteConfig(externalConfig, REMOTE_LOG_EXTERNAL);
    const cloud = external.specialRemotes[0];
    check(cloud.baseType === "external" && cloud.externalType === "rclone", "external base type + external type parsed");
    check(cloud.type === "rclone", "display type is the external type");
    check(
      cloud.mainSetting !== null && cloud.mainSetting.key === "rcloneremotename" && cloud.mainSetting.value === "remote:backup",
      "external main setting comes from the decoded remote.log fields",
    );
    check(
      remotes.specialRemoteDocUrl(cloud) === "https://git-annex.branchable.com/special_remotes/external/",
      "external remote links to the external doc page",
    );

    // Captured escaped line: `&32;` is a space, `&38;` an ampersand.
    const escaped = remotes.parseRemoteConfig(
      configStdout([
        ["remote.cloud.annex-uuid", "006cd0fd-6ce3-4384-af36-9f940c204008"],
        ["remote.cloud.annex-externaltype", "rclone"],
      ]),
      REMOTE_LOG_EXTERNAL_ESCAPED,
    );
    check(
      escaped.specialRemotes[0].mainSetting.value === "remote:my backup & more",
      `remote.log &NN; escapes are decoded (got ${JSON.stringify(escaped.specialRemotes[0].mainSetting.value)})`,
    );

    // Synthetic config: legacy fallback only when remote.log has no matching entry.
    const noLog = remotes.parseRemoteConfig(
      configStdout([
        ["remote.old.type", "external"],
        ["remote.old.externaltype", "rclone"],
        ["remote.old.annex-uuid", "uuid-without-log"],
      ]),
      "",
    );
    check(noLog.specialRemotes.length === 1, "legacy config keys still parse without a remote.log");
    check(noLog.specialRemotes[0].baseType === "external", "legacy type=external fallback");
    check(noLog.specialRemotes[0].type === "rclone", "legacy externaltype fallback");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("config error is surfaced (not hidden as 'no remotes')");
  {
    const repo = makeRepo("broken-config");
    gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
    fs.appendFileSync(path.join(repo, ".git", "config"), "\n[broken\n");
    const snapshot = remotes.readRemotes(repo);
    check(snapshot.hasRepo === true, "a repo with a broken .git/config still reports hasRepo true");
    check(
      typeof snapshot.configError === "string" && snapshot.configError !== "",
      `configError carries the git error (got ${JSON.stringify(snapshot.configError ?? null)})`,
    );
    check(snapshot.gitRemotes.length === 0 && snapshot.specialRemotes.length === 0, "broken config => empty lists");
    check(Object.keys(snapshot.config).length === 0 && snapshot.remoteLog === "", "broken config => empty config/log");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("rowsFromSnapshot: excludes read-only remotes, trims URLs");
  {
    const snapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["  ssh://x/origin  "], pushUrls: ["  "], kind: "git", hasAnnexUuid: false },
        { name: "multi", fetchUrls: ["m1", "m2"], pushUrls: [], kind: "multi-url", hasAnnexUuid: false },
        { name: "pushonly", fetchUrls: [], pushUrls: ["p"], kind: "multi-url", hasAnnexUuid: false },
      ],
      specialRemotes: [],
      config: {},
      remoteLog: "",
    };
    const rows = remotes.rowsFromSnapshot(snapshot);
    check(rows.length === 1, `only editable remotes become rows (got ${rows.length})`);
    check(rows[0].fetchUrl === "ssh://x/origin", "fetch URL is trimmed in the row");
    check(rows[0].pushUrl === null, "whitespace-only push URL becomes null");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("plan ordering (remove -> rename -> set-url fetch -> set-url push -> add)");
  {
    const snapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["a"], pushUrls: ["pa"], kind: "git", hasAnnexUuid: false },
        { name: "old", fetchUrls: ["b"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "gone", fetchUrls: ["c"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "keep", fetchUrls: ["d"], pushUrls: ["pd"], kind: "git", hasAnnexUuid: false },
        { name: "multi", fetchUrls: ["e1", "e2"], pushUrls: [], kind: "multi-url", hasAnnexUuid: false },
      ],
      specialRemotes: [],
      config: {},
      remoteLog: "",
    };
    const rows = [
      { originalName: "origin", name: "origin", fetchUrl: "a2", pushUrl: null },
      { originalName: "old", name: "renamed", fetchUrl: "b", pushUrl: "pb" },
      { originalName: "keep", name: "keep", fetchUrl: "d", pushUrl: "pd2" },
      { originalName: "", name: "nas", fetchUrl: "n", pushUrl: "np" },
      { originalName: "", name: "plain", fetchUrl: "pl", pushUrl: null },
    ];

    const plan = remotes.planRemoteChanges(rows, snapshot);
    check(plan.issues.length === 0, `valid save has no issues (got ${JSON.stringify(plan.issues)})`);
    const expected = [
      "remote remove gone",
      "remote rename old renamed",
      "remote set-url origin a2",
      "config --unset-all remote.origin.pushurl",
      "remote set-url --push renamed pb",
      "remote set-url --push keep pd2",
      "remote add nas n",
      "remote set-url --push nas np",
      "remote add plain pl",
    ];
    check(
      JSON.stringify(stepArgs(plan.steps)) === JSON.stringify(expected),
      `exact argv sequence matches:\n      ${stepArgs(plan.steps).join("\n      ")}`,
    );
    const kinds = plan.steps.map((step) => step.kind).join(",");
    check(
      kinds === "remove,rename,set-fetch-url,delete-push-url,set-push-url,set-push-url,add,set-push-url,add",
      `step kinds are ordered correctly (${kinds})`,
    );
    check(
      plan.steps[1].previousName === "old" && plan.steps[1].name === "renamed",
      "rename carries previousName + final name",
    );
    check(
      plan.steps.every((step) => typeof step.describe === "string" && /^[a-z]/.test(step.describe)),
      "every step has an English one-line describe",
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("rename-freed names, rename chains and cycles");
  {
    const baseSnapshot = (names) => ({
      hasRepo: true,
      gitRemotes: names.map((name) => ({
        name,
        fetchUrls: [`ssh://x/${name}`],
        pushUrls: [],
        kind: "git",
        hasAnnexUuid: false,
      })),
      specialRemotes: [],
      config: {},
      remoteLog: "",
    });

    // rename a->c frees "a" for a new row in the same save (removal + rename ordering).
    const freed = remotes.planRemoteChanges(
      [
        { originalName: "a", name: "c", fetchUrl: "ssh://x/a", pushUrl: null },
        { originalName: "", name: "a", fetchUrl: "ssh://x/new-a", pushUrl: null },
      ],
      baseSnapshot(["a"]),
    );
    check(freed.issues.length === 0, `rename-freed name is reusable (got ${JSON.stringify(freed.issues)})`);
    check(
      JSON.stringify(stepArgs(freed.steps)) === JSON.stringify(["remote rename a c", "remote add a ssh://x/new-a"]),
      "rename runs before adding the row that reuses the old name",
    );

    // rename chain: a->b and b->c must run b->c first.
    const chain = remotes.planRemoteChanges(
      [
        { originalName: "a", name: "b", fetchUrl: "ssh://x/a", pushUrl: null },
        { originalName: "b", name: "c", fetchUrl: "ssh://x/b", pushUrl: null },
      ],
      baseSnapshot(["a", "b"]),
    );
    check(chain.issues.length === 0, `rename chain is legal (got ${JSON.stringify(chain.issues)})`);
    check(
      JSON.stringify(stepArgs(chain.steps)) === JSON.stringify(["remote rename b c", "remote rename a b"]),
      "rename order follows the dependency chain",
    );

    // rename + re-add of the same name in one save.
    const renameReadd = remotes.planRemoteChanges(
      [
        { originalName: "a", name: "b", fetchUrl: "ssh://x/a", pushUrl: null },
        { originalName: "", name: "a", fetchUrl: "ssh://x/new", pushUrl: null },
      ],
      baseSnapshot(["a"]),
    );
    check(renameReadd.issues.length === 0, "rename + re-add of the same name is legal");
    check(
      JSON.stringify(stepArgs(renameReadd.steps)) === JSON.stringify(["remote rename a b", "remote add a ssh://x/new"]),
      "rename + re-add order is rename then add",
    );

    // rename cycle a->b, b->a is rejected before anything runs.
    const cycle = remotes.planRemoteChanges(
      [
        { originalName: "a", name: "b", fetchUrl: "ssh://x/a", pushUrl: null },
        { originalName: "b", name: "a", fetchUrl: "ssh://x/b", pushUrl: null },
      ],
      baseSnapshot(["a", "b"]),
    );
    check(cycle.issues.length > 0, "a rename cycle is reported as an issue");
    check(cycle.steps.length === 0, "a rename cycle plans zero commands");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("URL trimming in validation, comparison and every git argument");
  {
    const snapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["ssh://old"], pushUrls: [], kind: "git", hasAnnexUuid: false },
      ],
      specialRemotes: [],
      config: {},
      remoteLog: "",
    };
    // Whitespace around an unchanged URL must not count as dirty.
    const unchanged = remotes.planRemoteChanges(
      [{ originalName: "origin", name: "origin", fetchUrl: "  ssh://old  ", pushUrl: "   " }],
      snapshot,
    );
    check(unchanged.issues.length === 0 && unchanged.steps.length === 0, "surrounding whitespace is not a dirty change");

    // Changed/added URLs are written trimmed.
    const trimmed = remotes.planRemoteChanges(
      [
        { originalName: "origin", name: "origin", fetchUrl: "  ssh://new  ", pushUrl: null },
        { originalName: "", name: "nas", fetchUrl: "  ssh://nas  ", pushUrl: "  ssh://nas-push  " },
      ],
      snapshot,
    );
    check(trimmed.issues.length === 0, `trimmed save has no issues (got ${JSON.stringify(trimmed.issues)})`);
    check(
      JSON.stringify(stepArgs(trimmed.steps)) ===
        JSON.stringify([
          "remote set-url origin ssh://new",
          "remote add nas ssh://nas",
          "remote set-url --push nas ssh://nas-push",
        ]),
      "every generated git argument uses the trimmed URL",
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("validation: real git name rules + collisions");
  {
    const emptySnapshot = { hasRepo: true, gitRemotes: [], specialRemotes: [], config: {}, remoteLog: "" };
    const rowFor = (name) => [{ originalName: "", name, fetchUrl: "ssh://x/y", pushUrl: null }];

    const invalid = [
      ["", "empty name"],
      ["a b", "whitespace"],
      ["a\tb", "tab"],
      ["a\u0001b", "control character"],
      ["-x", "leading dash"],
      ["a..b", "double dot"],
      [".", "dot component"],
      ["..", "dot-dot component"],
      ["a~b", "tilde"],
      ["a^b", "caret"],
      ["a:b", "colon"],
      ["a?b", "question mark"],
      ["a*b", "asterisk"],
      ["a[b", "open bracket"],
      ["a\\b", "backslash"],
      ["a//b", "empty path component"],
      ["/a", "leading slash"],
      ["a/", "trailing slash"],
      [".hidden", "component starting with a dot"],
      ["x.lock", "component ending with .lock"],
      ["a@{b", "@{"],
    ];
    for (const [name, label] of invalid) {
      const plan = remotes.planRemoteChanges(rowFor(name), emptySnapshot);
      check(
        plan.issues.some((issue) => issue.field === "name" && issue.message !== ""),
        `rejects invalid name ${label} (${JSON.stringify(name)})`,
      );
      check(plan.steps.length === 0, `invalid name ${label}: zero commands planned`);
    }

    const allowed = ["a.", "a/b", "UPPER", "a_b-c.d", "@", "a@", "a{b", "a}b", "a.b.c"];
    for (const name of allowed) {
      const plan = remotes.planRemoteChanges(rowFor(name), emptySnapshot);
      check(plan.issues.length === 0, `accepts git-legal name ${JSON.stringify(name)}`);
    }

    const collisionSnapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["u"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "keep", fetchUrls: ["k"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "multi", fetchUrls: ["m1", "m2"], pushUrls: [], kind: "multi-url", hasAnnexUuid: false },
        { name: "gone", fetchUrls: ["g"], pushUrls: [], kind: "git", hasAnnexUuid: false },
      ],
      specialRemotes: [
        { name: "archive", type: "directory", baseType: "directory", externalType: "", hasAnnexUuid: true, mainSetting: null, config: {} },
      ],
      config: {},
      remoteLog: "",
    };
    const validRow = { originalName: "origin", name: "origin", fetchUrl: "u", pushUrl: null };
    const keepRow = { originalName: "keep", name: "keep", fetchUrl: "k", pushUrl: null };

    const collisionCases = [
      ["new row collides with a special remote", [{ originalName: "", name: "archive", fetchUrl: "x", pushUrl: null }]],
      ["new row collides with a multi-URL remote", [{ originalName: "", name: "multi", fetchUrl: "x", pushUrl: null }]],
      ["rename collides with an existing git remote", [validRow, { ...validRow, name: "keep" }, keepRow]],
      ["duplicate final names", [validRow, { originalName: "", name: "origin", fetchUrl: "x", pushUrl: null }]],
      ["row whose originalName vanished", [{ originalName: "vanished", name: "vanished", fetchUrl: "x", pushUrl: null }]],
    ];
    for (const [label, rows] of collisionCases) {
      const plan = remotes.planRemoteChanges(rows, collisionSnapshot);
      check(plan.issues.length > 0, `${label}: reported as an issue`);
      check(plan.steps.length === 0, `${label}: zero commands planned`);
    }

    const readd = remotes.planRemoteChanges(
      [validRow, keepRow, { originalName: "", name: "gone", fetchUrl: "new-url", pushUrl: null }],
      collisionSnapshot,
    );
    check(readd.issues.length === 0, "new row may reuse a name removed in the same save");
    check(
      JSON.stringify(stepArgs(readd.steps)) === JSON.stringify(["remote remove gone", "remote add gone new-url"]),
      "delete + re-add is ordered remove first",
    );

    const invalidPlan = remotes.planRemoteChanges([{ originalName: "origin", name: "", fetchUrl: "u", pushUrl: null }], collisionSnapshot);
    const applied = remotes.applyRemotePlan(path.join(WORK, "nowhere"), invalidPlan);
    check(applied.ok === false && applied.results.length === 0, "apply refuses a plan that has issues");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git: rename preserves annex keys, push URL, tracking refs");
  {
    const repo = makeRepo("rename-keys");
    gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/origin-push");
    gitOk(repo, "config", "remote.origin.annex-uuid", "uuid-origin");
    gitOk(repo, "config", "remote.origin.annex-ignore", "true");
    gitOk(repo, "remote", "add", "remove-me", "ssh://example/remove");

    const before = remotes.readRemotes(repo);
    const rows = remotes.rowsFromSnapshot(before).map((row) => ({ ...row }));
    const originRow = rows.find((row) => row.originalName === "origin");
    originRow.name = "upstream";
    originRow.fetchUrl = "ssh://example/upstream";
    rows.splice(
      rows.findIndex((row) => row.originalName === "remove-me"),
      1,
    );
    rows.push({ originalName: "", name: "nas", fetchUrl: "ssh://example/nas", pushUrl: "ssh://example/nas-push" });

    const plan = remotes.planRemoteChanges(rows, before);
    check(plan.issues.length === 0, `integration plan has no issues (got ${JSON.stringify(plan.issues)})`);
    const result = remotes.applyRemotePlan(repo, plan);
    check(result.ok === true && result.failed === null, "applyRemotePlan reports success");

    const after = remotes.readRemotes(repo);
    const upstream = after.gitRemotes.find((remote) => remote.name === "upstream");
    check(upstream !== undefined && after.gitRemotes.every((remote) => remote.name !== "origin"), "origin was renamed to upstream");
    check(upstream.fetchUrls[0] === "ssh://example/upstream", "renamed remote fetch URL was updated");
    check(upstream.pushUrls[0] === "ssh://example/origin-push", "renamed remote keeps its push URL");
    check(after.config["remote.upstream.annex-uuid"]?.[0] === "uuid-origin", "renamed remote keeps annex-uuid");
    check(after.config["remote.upstream.annex-ignore"]?.[0] === "true", "renamed remote keeps annex-ignore");
    check(after.gitRemotes.every((remote) => remote.name !== "remove-me"), "removed remote is gone from git");
    const nas = after.gitRemotes.find((remote) => remote.name === "nas");
    check(nas !== undefined && nas.pushUrls[0] === "ssh://example/nas-push", "new remote got its push URL");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git: clear push URLs with regex metacharacters");
  {
    const urls = ["git@h:foo/bar+baz.git", "ssh://git@[::1]:22/srv/repo.git", "https://h.com/a.b.git"];
    for (const pushUrl of urls) {
      const repo = makeRepo(`clear-${urls.indexOf(pushUrl)}`);
      gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
      gitOk(repo, "remote", "set-url", "--push", "origin", pushUrl);
      const before = remotes.readRemotes(repo);
      const rows = remotes.rowsFromSnapshot(before);
      rows[0].pushUrl = null;
      const plan = remotes.planRemoteChanges(rows, before);
      check(
        plan.steps.length === 1 && plan.steps[0].args.join(" ") === "config --unset-all remote.origin.pushurl",
        `clearing ${pushUrl} uses git config --unset-all`,
      );
      const result = remotes.applyRemotePlan(repo, plan);
      check(result.ok === true, `clearing ${pushUrl} succeeds`);
      check(remotes.readRemotes(repo).gitRemotes[0].pushUrls.length === 0, `push URL ${pushUrl} is really unset`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git: delete + re-add the same name in one save");
  {
    const repo = makeRepo("readd");
    gitOk(repo, "remote", "add", "nas", "ssh://example/old-url");
    const before = remotes.readRemotes(repo);
    const rows = remotes.rowsFromSnapshot(before);
    rows.splice(0, 1, { originalName: "", name: "nas", fetchUrl: "ssh://example/new-url", pushUrl: null });

    const plan = remotes.planRemoteChanges(rows, before);
    check(plan.issues.length === 0, `delete + re-add has no issues (got ${JSON.stringify(plan.issues)})`);
    check(
      JSON.stringify(stepArgs(plan.steps)) === JSON.stringify(["remote remove nas", "remote add nas ssh://example/new-url"]),
      "remove runs before add",
    );
    const result = remotes.applyRemotePlan(repo, plan);
    check(result.ok === true, "delete + re-add applied cleanly");
    const after = remotes.readRemotes(repo);
    check(after.gitRemotes.length === 1 && after.gitRemotes[0].fetchUrls[0] === "ssh://example/new-url", "remote holds the new URL");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("apply stops at the first failure (partial results, no rollback)");
  {
    const repo = makeRepo("partial");
    gitOk(repo, "remote", "add", "ok", "ssh://example/ok");
    const plan = {
      issues: [],
      steps: [
        { kind: "set-fetch-url", name: "ok", args: ["remote", "set-url", "ok", "ssh://example/ok2"], describe: "set fetch URL for ok" },
        { kind: "set-fetch-url", name: "missing", args: ["remote", "set-url", "missing", "ssh://example/x"], describe: "set fetch URL for missing" },
        { kind: "add", name: "after", args: ["remote", "add", "after", "ssh://example/after"], describe: "add remote after" },
      ],
    };
    const result = remotes.applyRemotePlan(repo, plan);
    check(result.ok === false, "ok is false on failure");
    check(result.failed !== null && result.failed.name === "missing", "failed step is reported");
    check(result.results.length === 2, `results include only attempted steps (got ${result.results.length})`);
    check(result.results[0].ok === true && result.results[1].ok === false, "first step ok, second step failed");
    check(typeof result.results[1].detail === "string" && result.results[1].detail.length > 0, "failed step carries git stderr");
    check(git(repo, "remote", "get-url", "after").code !== 0, "steps after the failure are not run");
    check(gitOk(repo, "remote", "get-url", "ok") === "ssh://example/ok2", "already-applied steps stay applied (no rollback)");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git-annex: initremote type=directory fixture");
  if (!ANNEX_AVAILABLE) {
    skip("git-annex not installed: real special-remote fixture not run");
  } else {
    const repo = makeRepo("annex-fixture");
    const init = sh("git", ["annex", "init"], repo);
    check(init.status === 0, "git annex init succeeds");
    const store = path.join(WORK, "annex-store");
    fs.mkdirSync(store, { recursive: true });
    const initremote = sh(
      "git",
      ["annex", "initremote", "archive", "type=directory", `directory=${store}`, "encryption=none"],
      repo,
    );
    check(initremote.status === 0, `git annex initremote type=directory succeeds (${(initremote.stderr || "").trim()})`);

    const snapshot = remotes.readRemotes(repo);
    check(snapshot.remoteLog.includes("type=directory"), "readRemotes reads remote.log from the git-annex branch");
    check(snapshot.specialRemotes.length === 1, `real repo has one special remote (got ${snapshot.specialRemotes.length})`);
    const archive = snapshot.specialRemotes[0];
    if (archive !== undefined) {
      check(archive.name === "archive", "special remote name is archive");
      check(archive.type === "directory" && archive.baseType === "directory", "parsed type is directory");
      check(archive.hasAnnexUuid === true, "real special remote hasAnnexUuid");
      check(
        archive.mainSetting !== null && archive.mainSetting.key === "directory" && archive.mainSetting.value === store,
        `mainSetting is {directory: ${store}}`,
      );
      check(
        remotes.specialRemoteDocUrl(archive) === "https://git-annex.branchable.com/special_remotes/directory/",
        "real special remote doc link points at the directory page",
      );
      check(
        snapshot.config["remote.archive.annex-directory"]?.[0] === store,
        "raw config keeps remote.archive.annex-directory",
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("specialRemoteDocUrl");
  {
    const known = { name: "a", type: "directory", baseType: "directory", externalType: "", hasAnnexUuid: true, mainSetting: null, config: {} };
    const s3 = { name: "aws", type: "S3", baseType: "S3", externalType: "", hasAnnexUuid: true, mainSetting: null, config: {} };
    const external = {
      name: "cloud",
      type: "rclone",
      baseType: "external",
      externalType: "rclone",
      hasAnnexUuid: true,
      mainSetting: null,
      config: {},
    };
    const unknown = { name: "mystery", type: "not-a-real-type", baseType: "not-a-real-type", externalType: "", hasAnnexUuid: true, mainSetting: null, config: {} };
    check(
      remotes.specialRemoteDocUrl(known) === "https://git-annex.branchable.com/special_remotes/directory/",
      "known type links to its page",
    );
    check(
      remotes.specialRemoteDocUrl(s3) === "https://git-annex.branchable.com/special_remotes/S3/",
      "case-insensitive type keeps the correct page slug (S3)",
    );
    check(
      remotes.specialRemoteDocUrl(external) === "https://git-annex.branchable.com/special_remotes/external/",
      "external type links to the external page",
    );
    check(
      remotes.specialRemoteDocUrl(unknown) === "https://git-annex.branchable.com/special_remotes/",
      "unknown type falls back to the index",
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\nREMOTES TESTS PASS=${pass} FAIL=${fail}`);
  fs.rmSync(WORK, { recursive: true, force: true });
  if (fail > 0) {
    console.error(`\nFAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("REMOTES TESTS OK");
})().catch((error) => {
  console.error("REMOTES TESTS FAILED:", error);
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
