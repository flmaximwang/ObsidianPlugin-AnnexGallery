#!/usr/bin/env node
/**
 * 「remote 设置」核心模型检查（真 git 仓库 + 真 git-annex 特殊 remote）：
 *
 *   node tools/remotes-check.cjs
 *
 * 验的是 src/core/remotes.ts —— 设置页 remotes 区块现在完全以 `.git/config` 为准：
 *   ① 不是 git 仓库 ⇒ hasRepo=false，不抛异常；坏掉的 .git/config ⇒ configError；
 *   ② 解析 `git config --get-regexp '^remote\.'`：pushurl / 多 URL / 只有 pushurl /
 *      带点的名字 / 无值 key；重复 key 保留为有序数组；
 *   ③ 特殊 remote 的类型来自 git-annex 分支的 remote.log（不是 .git/config 里
 *      根本不存在的 type= key）；主设置取 `annex-<param>`；真跑 `git annex
 *      initremote type=directory`，断言 type / directory 路径 / 文档链接；
 *   ④ 过期检查 sameRemoteConfig：多 URL 的第一个 URL、pushurl、remote.log 变化都能发现；
 *   ⑤ rowsFromSnapshot 只取可编辑的 git remote，URL 去首尾空白；
 *   ⑥ 保存 = 生成命令计划，顺序 remove -> rename -> set-url fetch -> set-url push -> add，
 *      在真仓库上执行并逐项核对；
 *   ⑦ rename 保留 annex-uuid / annex-ignore / push URL；rename 链按依赖排序，
 *      rename 腾出的名字可以复用，rename 环 ⇒ 校验错误、零命令；
 *   ⑧ 清空 push URL 走 `git config --unset-all`（旧 URL 里含 + / [ / :: 等正则元字符也成功）；
 *   ⑨ 非法名字（git 自己拒绝的那些）在跑任何命令前被拦下；
 *   ⑩ 中途失败 ⇒ 立即停止，返回已执行的部分结果，不回滚。
 *
 * 环境里没有 git-annex 时，特殊 remote 的真实夹具打印 SKIP（其余照跑）。
 * 全程只动 os.tmpdir() 下的临时仓库，跑完删掉；不 fetch / 不 push / 不碰 annex 内容。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "annex-remotes-check-"));

let pass = 0;
let fail = 0;
function check(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${message}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${message}`);
  }
}
function skip(message) {
  console.log(`  SKIP: ${message}`);
}

/** src/core/remotes.ts → 临时 CJS，返回它的导出。 */
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

function runGit(dir, args) {
  try {
    return {
      code: 0,
      stdout: execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return { code: error.status ?? 1, stdout: "", stderr: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
}
function git(dir, ...args) {
  const res = runGit(dir, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${res.stderr}`);
  return res.stdout;
}

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
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "check@example.com");
  git(dir, "config", "user.name", "check");
  return dir;
}

/** 构造 `git config -z --get-regexp` 的 stdout。 */
const configStdout = (pairs) => pairs.map(([key, value]) => `${key}\n${value}\0`).join("");
const argv = (steps) => steps.map((step) => step.args.join(" "));

/** 本机 git-annex 10.20261026 真实跑出来的 remote.log（external 由真实 initremote 产生）。 */
const REMOTE_LOG_DIRECTORY =
  "7b808095-d557-4450-b45e-2225bc9cf1df encryption=none name=archive type=directory timestamp=1794043890s";
const REMOTE_LOG_EXTERNAL =
  "4f6a3f01-8c36-43b2-b121-e9f978bc5b08 encryption=none externaltype=rclone name=cloud rcloneremotename=remote:backup type=external timestamp=1794044022s";
const ANNEX_AVAILABLE = sh("git", ["annex", "version"]).status === 0;

(async () => {
  const remotes = await loadModule();

  console.log("① 不是 git 仓库 / 坏掉的 .git/config");
  const noRepo = remotes.readRemotes(path.join(WORK, "not-a-repo"));
  check(noRepo.hasRepo === false, "不是仓库 ⇒ hasRepo=false，不抛异常");
  check(noRepo.gitRemotes.length === 0 && noRepo.specialRemotes.length === 0, "没有任何 remote");
  check(Object.keys(noRepo.config).length === 0 && noRepo.remoteLog === "", "config / remoteLog 为空");

  const brokenRepo = makeRepo("broken");
  git(brokenRepo, "remote", "add", "origin", "ssh://nas.example/x");
  fs.appendFileSync(path.join(brokenRepo, ".git", "config"), "\n[broken\n");
  const broken = remotes.readRemotes(brokenRepo);
  check(broken.hasRepo === true, "坏 config 仍被识别为仓库");
  check(typeof broken.configError === "string" && broken.configError !== "", `configError 带出 git 错误：${(broken.configError || "").split("\n")[0]}`);
  check(broken.gitRemotes.length === 0, "坏 config ⇒ 空列表（不再假装『没有 remote』）");

  console.log("② 解析 .git/config");
  const repo = makeRepo("parse");
  git(repo, "remote", "add", "origin", "ssh://nas.example/origin");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/origin-push");
  git(repo, "remote", "add", "multi", "ssh://nas.example/a");
  git(repo, "remote", "set-url", "--add", "multi", "ssh://nas.example/b");
  git(repo, "config", "remote.pushonly.pushurl", "ssh://nas.example/push-only");
  git(repo, "config", "remote.dotted.name.url", "ssh://nas.example/dotted");
  fs.appendFileSync(path.join(repo, ".git", "config"), '\n[remote "valueless"]\n\turl = ssh://nas.example/v\n\tbarekey\n');

  const snapshot = remotes.readRemotes(repo);
  check(snapshot.hasRepo === true && snapshot.configError === undefined, "healthy 仓库：hasRepo=true 且无 configError");
  check(snapshot.gitRemotes.length === 5, `解析出 5 个 git remote（得到 ${snapshot.gitRemotes.length}）`);
  const origin = snapshot.gitRemotes.find((remote) => remote.name === "origin");
  check(origin.kind === "git" && origin.fetchUrls[0] === "ssh://nas.example/origin", "origin 的 fetch URL 正确");
  check(origin.pushUrls[0] === "ssh://nas.example/origin-push", "origin 的 push URL 被读到（不是只看 git remote -v）");
  const multi = snapshot.gitRemotes.find((remote) => remote.name === "multi");
  check(multi.kind === "multi-url" && multi.fetchUrls.length === 2, "两个 fetch URL ⇒ multi-url");
  check(
    snapshot.config["remote.multi.url"].join(",") === "ssh://nas.example/a,ssh://nas.example/b",
    "重复 key 保留为有序数组",
  );
  check(snapshot.gitRemotes.some((remote) => remote.name === "dotted.name"), "名字里带点的 remote 解析正确");
  check(snapshot.config["remote.valueless.barekey"]?.[0] === "", "无值 key 解析为空字符串");
  const pushOnly = snapshot.gitRemotes.find((remote) => remote.name === "pushonly");
  check(pushOnly !== undefined && pushOnly.kind === "multi-url" && pushOnly.fetchUrls.length === 0, "只有 pushurl 的 remote 也可见（只读行）");

  console.log("③ 特殊 remote 类型来自 remote.log");
  const external = remotes.parseRemoteConfig(
    configStdout([
      ["remote.cloud.annex-externaltype", "rclone"],
      ["remote.cloud.annex-uuid", "4f6a3f01-8c36-43b2-b121-e9f978bc5b08"],
      ["remote.cloud.annex-verified", "verified"],
    ]),
    REMOTE_LOG_EXTERNAL,
  );
  const cloud = external.specialRemotes[0];
  check(cloud.baseType === "external" && cloud.externalType === "rclone" && cloud.type === "rclone", "external / 显示类型 = externaltype");
  check(
    cloud.mainSetting?.key === "rcloneremotename" && cloud.mainSetting.value === "remote:backup",
    "external 主设置来自 remote.log 字段（&NN; 转义已解码）",
  );
  check(
    remotes.specialRemoteDocUrl(cloud).endsWith("/special_remotes/external/"),
    "external 类型 → external 文档页",
  );

  if (!ANNEX_AVAILABLE) {
    skip("git-annex 未安装：不跑真实 initremote 夹具");
  } else {
    const annexRepo = makeRepo("annex");
    const init = sh("git", ["annex", "init"], annexRepo);
    check(init.status === 0, "git annex init 成功");
    const store = path.join(WORK, "annex-store");
    fs.mkdirSync(store, { recursive: true });
    const initremote = sh(
      "git",
      ["annex", "initremote", "archive", "type=directory", `directory=${store}`, "encryption=none"],
      annexRepo,
    );
    check(initremote.status === 0, `真实 git annex initremote type=directory 成功（${(initremote.stderr || "").trim()}）`);
    const real = remotes.readRemotes(annexRepo);
    check(real.remoteLog.includes("type=directory"), "readRemotes 读到 git-annex 分支的 remote.log");
    check(real.specialRemotes.length === 1, `真仓库解析出 1 个特殊 remote（得到 ${real.specialRemotes.length}）`);
    const archive = real.specialRemotes[0];
    check(archive?.type === "directory" && archive.baseType === "directory", "类型 = directory（不是空）");
    check(archive.hasAnnexUuid === true, "hasAnnexUuid = true");
    check(
      archive.mainSetting?.key === "directory" && archive.mainSetting.value === store,
      `主设置 = {directory: ${store}}（不是 skipfetchall）`,
    );
    check(
      remotes.specialRemoteDocUrl(archive).endsWith("/special_remotes/directory/"),
      "directory 类型 → directory 文档页",
    );
  }

  console.log("④ 过期检查 sameRemoteConfig");
  check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === true, "两次读取完全一致");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/changed");
  check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === false, "push URL 变化 ⇒ 判定过期");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/origin-push");

  const dupA = remotes.parseRemoteConfig(
    configStdout([
      ["remote.multi.url", "a://one"],
      ["remote.multi.url", "a://two"],
    ]),
    REMOTE_LOG_DIRECTORY,
  );
  const dupB = remotes.parseRemoteConfig(
    configStdout([
      ["remote.multi.url", "a://ATTACKER"],
      ["remote.multi.url", "a://two"],
    ]),
    REMOTE_LOG_DIRECTORY,
  );
  check(
    remotes.sameRemoteConfig(
      { hasRepo: true, ...dupA, remoteLog: REMOTE_LOG_DIRECTORY },
      { hasRepo: true, ...dupB, remoteLog: REMOTE_LOG_DIRECTORY },
    ) === false,
    "多 URL remote 的『第一个』URL 被改也能发现",
  );
  const logA = remotes.parseRemoteConfig(configStdout([["remote.multi.url", "a://one"]]), REMOTE_LOG_DIRECTORY);
  const logB = remotes.parseRemoteConfig(configStdout([["remote.multi.url", "a://one"]]), `${REMOTE_LOG_DIRECTORY} x=1`);
  check(
    remotes.sameRemoteConfig(
      { hasRepo: true, ...logA, remoteLog: REMOTE_LOG_DIRECTORY },
      { hasRepo: true, ...logB, remoteLog: `${REMOTE_LOG_DIRECTORY} x=1` },
    ) === false,
    "remote.log 变化 ⇒ 判定过期",
  );

  console.log("⑤ rowsFromSnapshot");
  const rows = remotes.rowsFromSnapshot(snapshot);
  check(rows.length === 3, `3 行可编辑（origin / dotted.name / valueless；得到 ${rows.length}）`);
  check(rows.every((row) => row.originalName === row.name), "每行记住原始名字");
  check(rows.find((row) => row.name === "origin").pushUrl === "ssh://nas.example/origin-push", "行里带出 push URL");

  console.log("⑥ 生成计划顺序 + 真仓库执行");
  const saveRepo = makeRepo("save");
  git(saveRepo, "remote", "add", "origin", "ssh://nas.example/old");
  git(saveRepo, "remote", "set-url", "--push", "origin", "ssh://nas.example/old-push");
  git(saveRepo, "remote", "add", "keep", "ssh://nas.example/keep");
  git(saveRepo, "remote", "add", "gone", "ssh://nas.example/gone");
  const before = remotes.readRemotes(saveRepo);
  const edited = remotes.rowsFromSnapshot(before).map((row) => ({ ...row }));
  edited.find((row) => row.name === "origin").fetchUrl = "  ssh://nas.example/new  ";
  edited.find((row) => row.name === "origin").pushUrl = null;
  edited.push({ originalName: "", name: "nas", fetchUrl: "ssh://nas.example/nas", pushUrl: "ssh://nas.example/nas-push" });
  edited.splice(
    edited.findIndex((row) => row.name === "gone"),
    1,
  );

  const plan = remotes.planRemoteChanges(edited, before);
  check(plan.issues.length === 0, `计划无校验错误（得到 ${JSON.stringify(plan.issues)}）`);
  const expected = [
    "remote remove gone",
    "remote set-url origin ssh://nas.example/new",
    "config --unset-all remote.origin.pushurl",
    "remote add nas ssh://nas.example/nas",
    "remote set-url --push nas ssh://nas.example/nas-push",
  ];
  check(JSON.stringify(argv(plan.steps)) === JSON.stringify(expected), `命令顺序正确且 URL 已去空白：${argv(plan.steps).join(" / ")}`);
  const applied = remotes.applyRemotePlan(saveRepo, plan);
  check(applied.ok === true && applied.failed === null, "全部命令执行成功");
  const after = remotes.readRemotes(saveRepo);
  check(after.gitRemotes.every((remote) => remote.name !== "gone"), "gone 已从 .git/config 删除");
  const originAfter = after.gitRemotes.find((remote) => remote.name === "origin");
  check(originAfter.fetchUrls[0] === "ssh://nas.example/new", "fetch URL 已写入 git（trim 后）");
  check(originAfter.pushUrls.length === 0, "push URL 已用 git config --unset-all 清空");
  const nasAfter = after.gitRemotes.find((remote) => remote.name === "nas");
  check(nasAfter !== undefined && nasAfter.pushUrls[0] === "ssh://nas.example/nas-push", "新 remote 及其 push URL 已写入");

  console.log("⑦ rename：保留 annex-* / 依赖顺序 / 名字复用 / 环");
  const renameRepo = makeRepo("rename");
  git(renameRepo, "remote", "add", "origin", "ssh://nas.example/r");
  git(renameRepo, "remote", "set-url", "--push", "origin", "ssh://nas.example/r-push");
  git(renameRepo, "config", "remote.origin.annex-uuid", "uuid-1");
  git(renameRepo, "config", "remote.origin.annex-ignore", "true");
  const renameBefore = remotes.readRemotes(renameRepo);
  const renameRows = remotes.rowsFromSnapshot(renameBefore);
  renameRows[0].name = "upstream";
  const renamePlan = remotes.planRemoteChanges(renameRows, renameBefore);
  check(JSON.stringify(argv(renamePlan.steps)) === JSON.stringify(["remote rename origin upstream"]), "只生成 git remote rename 一条命令");
  check(remotes.applyRemotePlan(renameRepo, renamePlan).ok === true, "rename 执行成功");
  const renamed = remotes.readRemotes(renameRepo);
  check(renamed.config["remote.upstream.annex-uuid"]?.[0] === "uuid-1", "annex-uuid 跟着改名保留");
  check(renamed.config["remote.upstream.annex-ignore"]?.[0] === "true", "annex-ignore 跟着改名保留");
  check(renamed.gitRemotes[0].pushUrls[0] === "ssh://nas.example/r-push", "push URL 跟着改名保留");

  const chainSnapshot = {
    hasRepo: true,
    gitRemotes: [
      { name: "a", fetchUrls: ["a://a"], pushUrls: [], kind: "git", hasAnnexUuid: false },
      { name: "b", fetchUrls: ["a://b"], pushUrls: [], kind: "git", hasAnnexUuid: false },
    ],
    specialRemotes: [],
    config: {},
    remoteLog: "",
  };
  const chain = remotes.planRemoteChanges(
    [
      { originalName: "a", name: "b", fetchUrl: "a://a", pushUrl: null },
      { originalName: "b", name: "c", fetchUrl: "a://b", pushUrl: null },
    ],
    chainSnapshot,
  );
  check(
    JSON.stringify(argv(chain.steps)) === JSON.stringify(["remote rename b c", "remote rename a b"]),
    "rename 链按依赖排序（先腾名字）",
  );
  const freedSnapshot = {
    hasRepo: true,
    gitRemotes: [{ name: "a", fetchUrls: ["a://a"], pushUrls: [], kind: "git", hasAnnexUuid: false }],
    specialRemotes: [],
    config: {},
    remoteLog: "",
  };
  const freed = remotes.planRemoteChanges(
    [
      { originalName: "a", name: "c", fetchUrl: "a://a", pushUrl: null },
      { originalName: "", name: "a", fetchUrl: "a://new", pushUrl: null },
    ],
    freedSnapshot,
  );
  check(
    JSON.stringify(argv(freed.steps)) === JSON.stringify(["remote rename a c", "remote add a a://new"]),
    "rename 腾出的名字可以在同一次保存里复用",
  );
  const cycle = remotes.planRemoteChanges(
    [
      { originalName: "a", name: "b", fetchUrl: "a://a", pushUrl: null },
      { originalName: "b", name: "a", fetchUrl: "a://b", pushUrl: null },
    ],
    chainSnapshot,
  );
  check(cycle.issues.length > 0 && cycle.steps.length === 0, "rename 环 ⇒ 校验错误、零命令");

  console.log("⑧ 清空含正则元字符的 push URL");
  for (const pushUrl of ["git@h:foo/bar+baz.git", "ssh://git@[::1]:22/srv/repo.git"]) {
    const clearRepo = makeRepo(`clear-${pushUrl.includes("::") ? "v6" : "plus"}`);
    git(clearRepo, "remote", "add", "origin", "ssh://nas.example/origin");
    git(clearRepo, "remote", "set-url", "--push", "origin", pushUrl);
    const clearBefore = remotes.readRemotes(clearRepo);
    const clearRows = remotes.rowsFromSnapshot(clearBefore);
    clearRows[0].pushUrl = null;
    const clearPlan = remotes.planRemoteChanges(clearRows, clearBefore);
    check(
      JSON.stringify(argv(clearPlan.steps)) === JSON.stringify(["config --unset-all remote.origin.pushurl"]),
      `清空 ${pushUrl} 用 git config --unset-all（不把 URL 当正则）`,
    );
    check(remotes.applyRemotePlan(clearRepo, clearPlan).ok === true, `清空 ${pushUrl} 成功`);
    check(remotes.readRemotes(clearRepo).gitRemotes[0].pushUrls.length === 0, `push URL 真的没了：${pushUrl}`);
  }

  console.log("⑨ 名字校验 = git 的规则，非法名字零命令");
  const emptySnapshot = { hasRepo: true, gitRemotes: [], specialRemotes: [], config: {}, remoteLog: "" };
  for (const name of ["a..b", "a~b", "a*b", "a[b", "x.lock", "a@{b", ".hidden", "a b", "-rf", "a:b", "a//b", "a/"]) {
    const bad = remotes.planRemoteChanges([{ originalName: "", name, fetchUrl: "ssh://x/y", pushUrl: null }], emptySnapshot);
    check(bad.issues.some((issue) => issue.field === "name") && bad.steps.length === 0, `拒绝 git 不接受的 ${JSON.stringify(name)}，零命令`);
  }
  for (const name of ["a.", "a/b", "UPPER", "a_b-c.d", "@", "a@", "a{b", "a}b"]) {
    const ok = remotes.planRemoteChanges([{ originalName: "", name, fetchUrl: "ssh://x/y", pushUrl: null }], emptySnapshot);
    check(ok.issues.length === 0, `接受 git 允许的 ${JSON.stringify(name)}`);
  }

  console.log("⑩ 中途失败 ⇒ 立即停止、返回部分结果、不回滚");
  const partialRepo = makeRepo("partial");
  git(partialRepo, "remote", "add", "origin", "ssh://nas.example/x");
  const partialPlan = {
    issues: [],
    steps: [
      { kind: "set-fetch-url", name: "origin", args: ["remote", "set-url", "origin", "ssh://nas.example/y"], describe: "set fetch URL for origin" },
      { kind: "set-fetch-url", name: "missing", args: ["remote", "set-url", "missing", "ssh://nas.example/z"], describe: "set fetch URL for missing" },
      { kind: "add", name: "after", args: ["remote", "add", "after", "ssh://nas.example/after"], describe: "add remote after" },
    ],
  };
  const partial = remotes.applyRemotePlan(partialRepo, partialPlan);
  check(partial.ok === false && partial.failed !== null && partial.failed.name === "missing", "在 missing 那条失败并停止");
  check(partial.results.length === 2 && partial.results[0].ok === true && partial.results[1].ok === false, "结果只含已尝试的两条");
  check(partial.results[1].detail.length > 0, `失败结果带 git stderr：${partial.results[1].detail.split("\n")[0]}`);
  check(runGit(partialRepo, ["remote", "get-url", "after"]).code !== 0, "失败之后的命令没有执行");
  check(runGit(partialRepo, ["remote", "get-url", "origin"]).stdout === "ssh://nas.example/y", "已执行的命令不回滚");

  console.log(`\nREMOTES CHECK PASS=${pass} FAIL=${fail}`);
  fs.rmSync(WORK, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
  console.log("REMOTES OK");
})().catch((error) => {
  console.error("REMOTES CHECK FAILED:", error);
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
