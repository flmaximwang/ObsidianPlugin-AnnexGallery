#!/usr/bin/env node
/**
 * test-remotes —— the git-config remotes model (parse / classify / plan / apply).
 *
 *   node tests/test-remotes.cjs
 *
 * Covers annex-gallery-10m:
 *   · reading `git config --get-regexp '^remote\.'` (pushurl, multi-URL, special remotes,
 *     external special remotes, dotted names, valueless keys, no repo)
 *   · rowsFromSnapshot + exact command ordering for a full save
 *     (remove -> rename -> set-url fetch -> set-url push -> add)
 *   · validation (empty/whitespace/leading dash/colon names, empty URLs, duplicates,
 *     collisions incl. special and multi-URL remotes, vanished originals)
 *   · real-git integration: rename keeps annex-uuid / annex-ignore / pushurl,
 *     delete + re-add in one save, apply stops at the first failure
 *   · sameRemoteConfig staleness and specialRemoteDocUrl links
 *
 * Everything runs in throwaway repos under os.tmpdir(), cleaned up at the end.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

function makeRepo(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-q", "-b", "main");
  gitOk(dir, "config", "user.email", "test@example.com");
  gitOk(dir, "config", "user.name", "test");
  return dir;
}

function stepArgs(steps) {
  return steps.map((step) => step.args.join(" "));
}

(async () => {
  const remotes = await loadModule();

  // ────────────────────────────────────────────────────────────────────────────
  section("parsing: pushurl / multi-url / special / external / dotted / valueless");
  {
    const repo = makeRepo("parse");
    gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/push");

    gitOk(repo, "remote", "add", "multi", "ssh://example/multi-1");
    gitOk(repo, "remote", "set-url", "--add", "multi", "ssh://example/multi-2");

    gitOk(repo, "remote", "add", "multipush", "ssh://example/mp");
    gitOk(repo, "remote", "set-url", "--add", "--push", "multipush", "ssh://example/mp-push-1");
    gitOk(repo, "remote", "set-url", "--add", "--push", "multipush", "ssh://example/mp-push-2");

    gitOk(repo, "config", "remote.archive.type", "directory");
    gitOk(repo, "config", "remote.archive.directory", "/Volumes/Archive");
    gitOk(repo, "config", "remote.archive.annex-uuid", "uuid-archive");
    gitOk(repo, "config", "remote.archive.annex-cost", "200");

    gitOk(repo, "config", "remote.cloud.type", "external");
    gitOk(repo, "config", "remote.cloud.externaltype", "rclone");
    gitOk(repo, "config", "remote.cloud.rcloneremotename", "backup-drive");
    gitOk(repo, "config", "remote.cloud.annex-uuid", "uuid-cloud");

    // Names may contain dots; a bare key has no value. Git writes the name between the first
    // dot after "remote" and the last dot of the key.
    gitOk(repo, "config", "remote.dotted.name.url", "ssh://example/dotted");
    fs.appendFileSync(
      path.join(repo, ".git", "config"),
      '\n[remote "valueless"]\n\turl = ssh://example/valueless\n\tbarekey\n',
    );
    // A key with a single dot is not a per-remote setting and must be ignored.
    gitOk(repo, "config", "remote.pushdefault", "origin");

    const snapshot = remotes.readRemotes(repo);
    check(snapshot.hasRepo === true, "hasRepo is true for a real repository");
    check(snapshot.gitRemotes.length === 5, `5 git remotes parsed (got ${snapshot.gitRemotes.length})`);
    check(snapshot.specialRemotes.length === 2, `2 special remotes parsed (got ${snapshot.specialRemotes.length})`);

    const origin = snapshot.gitRemotes.find((remote) => remote.name === "origin");
    check(origin.kind === "git", 'origin is kind "git"');
    check(origin.fetchUrls.length === 1 && origin.fetchUrls[0] === "ssh://example/origin", "origin fetch URL parsed");
    check(origin.pushUrls.length === 1 && origin.pushUrls[0] === "ssh://example/push", "origin push URL parsed");

    const multi = snapshot.gitRemotes.find((remote) => remote.name === "multi");
    check(multi.kind === "multi-url" && multi.fetchUrls.length === 2, "two fetch URLs => multi-url");
    check(
      multi.fetchUrls.join(",") === "ssh://example/multi-1,ssh://example/multi-2",
      "multi-url fetch URLs keep config order",
    );

    const multiPush = snapshot.gitRemotes.find((remote) => remote.name === "multipush");
    check(multiPush.kind === "multi-url" && multiPush.pushUrls.length === 2, "two push URLs => multi-url");

    const archive = snapshot.specialRemotes.find((remote) => remote.name === "archive");
    check(archive !== undefined, "archive parsed as a special remote");
    check(archive.type === "directory", `archive type is directory (got "${archive.type}")`);
    check(archive.hasAnnexUuid === true, "archive hasAnnexUuid");
    check(
      archive.mainSetting !== null && archive.mainSetting.key === "directory" && archive.mainSetting.value === "/Volumes/Archive",
      "archive main setting is the directory path",
    );
    check(archive.config["annex-cost"] === "200", "special-remote config keeps annex-cost");

    const cloud = snapshot.specialRemotes.find((remote) => remote.name === "cloud");
    check(cloud.type === "rclone", `external special remote uses externaltype (got "${cloud.type}")`);
    check(cloud.hasAnnexUuid === true, "external special remote hasAnnexUuid");
    check(
      cloud.mainSetting !== null && cloud.mainSetting.key === "rcloneremotename",
      "external special remote mainSetting skips type/externaltype",
    );

    const dotted = snapshot.gitRemotes.find((remote) => remote.name === "dotted.name");
    check(dotted !== undefined, "remote name containing a dot round-trips");
    check(dotted.fetchUrls[0] === "ssh://example/dotted", "dotted remote fetch URL parsed");

    const valueless = snapshot.gitRemotes.find((remote) => remote.name === "valueless");
    check(valueless !== undefined, "remote with a valueless key is still a git remote");
    check(snapshot.config["remote.valueless.barekey"] === "", "valueless config key maps to the empty string");
    check(!Object.prototype.hasOwnProperty.call(snapshot.config, "remote.pushdefault"), "remote.pushdefault is skipped");
    check(!Object.keys(snapshot.config).some((key) => key.startsWith("remote.pushdefault.")), "no phantom remote from pushdefault");

    // Staleness: same config reads equal, then any remote change (push URL, special remote) differs.
    const again = remotes.readRemotes(repo);
    check(remotes.sameRemoteConfig(snapshot, again) === true, "sameRemoteConfig true for two identical reads");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/push-changed");
    const pushChanged = remotes.readRemotes(repo);
    check(remotes.sameRemoteConfig(snapshot, pushChanged) === false, "sameRemoteConfig notices a push-URL change");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/push");
    gitOk(repo, "config", "remote.archive.annex-cost", "100");
    const specialChanged = remotes.readRemotes(repo);
    check(remotes.sameRemoteConfig(snapshot, specialChanged) === false, "sameRemoteConfig notices a special-remote change");
    gitOk(repo, "config", "remote.archive.annex-cost", "200");

    // parseRemoteConfig accepts the raw NUL output directly (values with spaces stay intact).
    const parsed = remotes.parseRemoteConfig(
      "remote.w.url\nssh://host/a b\0remote.w.pushurl\nssh://host/p\0remote.w.annex-uuid\nu\0",
    );
    check(
      parsed.gitRemotes.length === 1 && parsed.gitRemotes[0].fetchUrls[0] === "ssh://host/a b",
      "parseRemoteConfig keeps spaces inside a URL",
    );
    check(parsed.config["remote.w.pushurl"] === "ssh://host/p", "parseRemoteConfig raw config map is complete");

    const empty = remotes.parseRemoteConfig("");
    check(empty.gitRemotes.length === 0 && empty.specialRemotes.length === 0, "parseRemoteConfig handles empty output");

    const noRepo = remotes.readRemotes(path.join(WORK, "does-not-exist"));
    check(noRepo.hasRepo === false, "no repo => hasRepo false");
    check(noRepo.gitRemotes.length === 0 && noRepo.specialRemotes.length === 0, "no repo => no remotes");
    check(Object.keys(noRepo.config).length === 0, "no repo => empty config");

    const emptyRepo = makeRepo("empty-repo");
    const emptySnapshot = remotes.readRemotes(emptyRepo);
    check(emptySnapshot.hasRepo === true && emptySnapshot.gitRemotes.length === 0, "repo without remotes => hasRepo true, no rows");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("rowsFromSnapshot");
  {
    const snapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["u1"], pushUrls: ["p1"], kind: "git", hasAnnexUuid: true },
        { name: "multi", fetchUrls: ["m1", "m2"], pushUrls: [], kind: "multi-url", hasAnnexUuid: false },
      ],
      specialRemotes: [],
      config: {},
    };
    const rows = remotes.rowsFromSnapshot(snapshot);
    check(rows.length === 1, `multi-url remotes are excluded (got ${rows.length} rows)`);
    check(
      rows[0].originalName === "origin" && rows[0].name === "origin" && rows[0].fetchUrl === "u1" && rows[0].pushUrl === "p1",
      "row carries original name, fetch URL and push URL",
    );
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
      specialRemotes: [{ name: "archive", type: "directory", hasAnnexUuid: true, mainSetting: null, config: { type: "directory" } }],
      config: {},
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
      "remote set-url --delete --push origin pa",
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
    check(plan.steps[1].previousName === "old" && plan.steps[1].name === "renamed", "rename carries previousName + final name");
    check(
      plan.steps.filter((step) => step.describe).length === plan.steps.length &&
        plan.steps.every((step) => /^[a-z]/.test(step.describe)),
      "every step has an English one-line describe",
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("validation: invalid rows run nothing");
  {
    const snapshot = {
      hasRepo: true,
      gitRemotes: [
        { name: "origin", fetchUrls: ["u"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "keep", fetchUrls: ["k"], pushUrls: [], kind: "git", hasAnnexUuid: false },
        { name: "multi", fetchUrls: ["m1", "m2"], pushUrls: [], kind: "multi-url", hasAnnexUuid: false },
        { name: "gone", fetchUrls: ["g"], pushUrls: [], kind: "git", hasAnnexUuid: false },
      ],
      specialRemotes: [{ name: "archive", type: "directory", hasAnnexUuid: true, mainSetting: null, config: { type: "directory" } }],
      config: {},
    };
    const validRow = (overrides) => ({ originalName: "origin", name: "origin", fetchUrl: "u", pushUrl: null, ...overrides });
    const keepRow = { originalName: "keep", name: "keep", fetchUrl: "k", pushUrl: null };

    const cases = [
      ["empty name", [validRow({ name: "" })], "name"],
      ["whitespace in name", [validRow({ name: "bad name" })], "name"],
      ["name starting with dash", [validRow({ name: "-rf" })], "name"],
      ["name containing colon", [validRow({ name: "a:b" })], "name"],
      ["empty fetch URL", [validRow({ fetchUrl: "  " })], "fetchUrl"],
      ["empty push URL", [validRow({ pushUrl: " " })], "pushUrl"],
      ["duplicate final names", [validRow(), { originalName: "", name: "origin", fetchUrl: "x", pushUrl: null }], "name"],
      ["new row collides with a special remote", [{ originalName: "", name: "archive", fetchUrl: "x", pushUrl: null }], "name"],
      ["new row collides with a multi-URL remote", [{ originalName: "", name: "multi", fetchUrl: "x", pushUrl: null }], "name"],
      ["rename collides with an existing git remote", [validRow({ name: "keep" }), keepRow], "name"],
      ["row whose originalName vanished", [validRow({ originalName: "vanished", name: "vanished" })], "name"],
    ];

    for (const [label, rows, field] of cases) {
      const plan = remotes.planRemoteChanges(rows, snapshot);
      check(plan.issues.length > 0, `${label}: reported as an issue`);
      check(plan.issues.some((issue) => issue.field === field), `${label}: issue field is "${field}"`);
      check(plan.steps.length === 0, `${label}: zero commands planned`);
    }

    // Delete + re-add of the same name is allowed: the remove step runs first.
    const readd = remotes.planRemoteChanges(
      [validRow(), keepRow, { originalName: "", name: "gone", fetchUrl: "new-url", pushUrl: null }],
      snapshot,
    );
    check(readd.issues.length === 0, "new row may reuse a name removed in the same save");
    check(
      JSON.stringify(stepArgs(readd.steps)) === JSON.stringify(["remote remove gone", "remote add gone new-url"]),
      "delete + re-add is ordered remove first",
    );

    // A plan with issues is never executed.
    const invalid = remotes.planRemoteChanges([validRow({ name: "" })], snapshot);
    const applied = remotes.applyRemotePlan(path.join(WORK, "nowhere"), invalid);
    check(applied.ok === false && applied.results.length === 0, "apply refuses a plan that has issues");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git: rename preserves annex keys, push URL, tracking refs");
  {
    const repo = makeRepo("integration");
    gitOk(repo, "remote", "add", "origin", "ssh://example/origin");
    gitOk(repo, "remote", "set-url", "--push", "origin", "ssh://example/origin-push");
    gitOk(repo, "config", "remote.origin.annex-uuid", "uuid-origin");
    gitOk(repo, "config", "remote.origin.annex-ignore", "true");
    gitOk(repo, "remote", "add", "remove-me", "ssh://example/remove");

    const before = remotes.readRemotes(repo);
    const rows = remotes.rowsFromSnapshot(before);
    const edited = rows.map((row) => ({ ...row }));
    const originRow = edited.find((row) => row.originalName === "origin");
    originRow.name = "upstream";
    originRow.fetchUrl = "ssh://example/upstream";
    const removeRowIndex = edited.findIndex((row) => row.originalName === "remove-me");
    edited.splice(removeRowIndex, 1);
    edited.push({ originalName: "", name: "nas", fetchUrl: "ssh://example/nas", pushUrl: "ssh://example/nas-push" });

    const plan = remotes.planRemoteChanges(edited, before);
    check(plan.issues.length === 0, `integration plan has no issues (got ${JSON.stringify(plan.issues)})`);
    const result = remotes.applyRemotePlan(repo, plan);
    check(result.ok === true && result.failed === null, "applyRemotePlan reports success");
    check(result.results.length === plan.steps.length, "all planned steps were attempted");

    const after = remotes.readRemotes(repo);
    const upstream = after.gitRemotes.find((remote) => remote.name === "upstream");
    check(upstream !== undefined && after.gitRemotes.every((remote) => remote.name !== "origin"), "origin was renamed to upstream");
    check(upstream.fetchUrls[0] === "ssh://example/upstream", "renamed remote fetch URL was updated");
    check(upstream.pushUrls[0] === "ssh://example/origin-push", "renamed remote keeps its push URL");
    check(after.config["remote.upstream.annex-uuid"] === "uuid-origin", "renamed remote keeps annex-uuid");
    check(after.config["remote.upstream.annex-ignore"] === "true", "renamed remote keeps annex-ignore");
    check(after.gitRemotes.every((remote) => remote.name !== "remove-me"), "removed remote is gone from git");
    check(after.gitRemotes.some((remote) => remote.name === "nas"), "new remote was added");

    const nas = after.gitRemotes.find((remote) => remote.name === "nas");
    check(nas.pushUrls[0] === "ssh://example/nas-push", "new remote got its push URL");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("real git: delete + re-add the same name in one save");
  {
    const repo = makeRepo("readd");
    gitOk(repo, "remote", "add", "nas", "ssh://example/old-url");
    const before = remotes.readRemotes(repo);
    const rows = remotes.rowsFromSnapshot(before);
    rows[0].fetchUrl = "ssh://example/new-url";
    // Delete the row and append a fresh one with the same name.
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

    // The successful first step is NOT rolled back.
    check(gitOk(repo, "remote", "get-url", "ok") === "ssh://example/ok2", "already-applied steps stay applied (no rollback)");
  }

  // ────────────────────────────────────────────────────────────────────────────
  section("specialRemoteDocUrl");
  {
    const known = { name: "archive", type: "directory", hasAnnexUuid: true, mainSetting: null, config: { type: "directory" } };
    const s3 = { name: "aws", type: "S3", hasAnnexUuid: true, mainSetting: null, config: { type: "S3" } };
    const external = {
      name: "cloud",
      type: "rclone",
      hasAnnexUuid: true,
      mainSetting: null,
      config: { type: "external", externaltype: "rclone" },
    };
    const unknown = { name: "mystery", type: "not-a-real-type", hasAnnexUuid: true, mainSetting: null, config: { type: "not-a-real-type" } };
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
