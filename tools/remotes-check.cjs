#!/usr/bin/env node
/**
 * 「remote 设置」核心模型检查（真 git 仓库，不是桩）：
 *
 *   node tools/remotes-check.cjs
 *
 * 验的是 src/core/remotes.ts —— 设置页 remotes 区块现在完全以 `.git/config` 为准：
 *   ① 不是 git 仓库 ⇒ hasRepo=false，不抛异常；
 *   ② `git config --get-regexp '^remote\.'` 解析：pushurl / 多 URL / 特殊 remote
 *      （type、externaltype、annex-uuid、主设置）/ 带点的名字 / 无值 key；
 *   ③ sameRemoteConfig：push URL、特殊 remote 配置变化都能检测出来（过期检查）；
 *   ④ rowsFromSnapshot：只有单 URL 的 git remote 变成可编辑行；
 *   ⑤ 保存 = 生成命令计划，顺序 remove -> rename -> set-url fetch -> set-url push -> add，
 *      在真仓库上执行并逐项核对 .git/config；
 *   ⑥ rename 保留 annex-uuid / annex-ignore / push URL；
 *   ⑦ 删除 + 同一保存里重新添加同名 remote 可行（remove 在前）；
 *   ⑧ 校验失败 ⇒ 一条命令都不跑；
 *   ⑨ 中途失败 ⇒ 立即停止，返回已执行的部分结果，不回滚；
 *   ⑩ specialRemoteDocUrl 指向 git-annex 文档页（未知类型回索引页）。
 *
 * 全程只动 os.tmpdir() 下的临时仓库，跑完删掉；不 fetch / 不 push / 不碰 annex 内容。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

function makeRepo(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "check@example.com");
  git(dir, "config", "user.name", "check");
  return dir;
}

const argv = (steps) => steps.map((step) => step.args.join(" "));

(async () => {
  const remotes = await loadModule();

  console.log("① 不是 git 仓库 ⇒ hasRepo=false");
  const noRepo = remotes.readRemotes(path.join(WORK, "not-a-repo"));
  check(noRepo.hasRepo === false, "hasRepo 为 false");
  check(noRepo.gitRemotes.length === 0 && noRepo.specialRemotes.length === 0, "没有任何 remote");
  check(Object.keys(noRepo.config).length === 0, "config 为空");

  console.log("② 解析 .git/config");
  const repo = makeRepo("parse");
  git(repo, "remote", "add", "origin", "ssh://nas.example/origin");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/origin-push");
  git(repo, "remote", "add", "multi", "ssh://nas.example/a");
  git(repo, "remote", "set-url", "--add", "multi", "ssh://nas.example/b");
  git(repo, "config", "remote.archive.type", "directory");
  git(repo, "config", "remote.archive.directory", "/Volumes/Archive");
  git(repo, "config", "remote.archive.annex-uuid", "uuid-archive");
  git(repo, "config", "remote.cloud.type", "external");
  git(repo, "config", "remote.cloud.externaltype", "rclone");
  git(repo, "config", "remote.cloud.annex-uuid", "uuid-cloud");
  git(repo, "config", "remote.dotted.name.url", "ssh://nas.example/dotted");
  fs.appendFileSync(path.join(repo, ".git", "config"), '\n[remote "valueless"]\n\turl = ssh://nas.example/v\n\tbarekey\n');

  const snapshot = remotes.readRemotes(repo);
  check(snapshot.hasRepo === true, "hasRepo 为 true");
  check(snapshot.gitRemotes.length === 4, `解析出 4 个 git remote（得到 ${snapshot.gitRemotes.length}）`);
  check(snapshot.specialRemotes.length === 2, `解析出 2 个特殊 remote（得到 ${snapshot.specialRemotes.length}）`);

  const origin = snapshot.gitRemotes.find((remote) => remote.name === "origin");
  check(origin.kind === "git" && origin.fetchUrls[0] === "ssh://nas.example/origin", "origin 的 fetch URL 正确");
  check(origin.pushUrls[0] === "ssh://nas.example/origin-push", "origin 的 push URL 被读到（不是只看 git remote -v）");
  check(snapshot.gitRemotes.find((remote) => remote.name === "multi").kind === "multi-url", "两个 fetch URL ⇒ multi-url");
  const archive = snapshot.specialRemotes.find((remote) => remote.name === "archive");
  check(archive.type === "directory" && archive.hasAnnexUuid === true, "特殊 remote 的 type / annex-uuid 正确");
  check(archive.mainSetting.key === "directory" && archive.mainSetting.value === "/Volumes/Archive", "主设置显示 directory 路径");
  const cloud = snapshot.specialRemotes.find((remote) => remote.name === "cloud");
  check(cloud.type === "rclone", "type=external ⇒ 显示 externaltype（rclone）");
  check(snapshot.gitRemotes.some((remote) => remote.name === "dotted.name"), "名字里带点的 remote 解析正确");
  check(snapshot.config["remote.valueless.barekey"] === "", "无值 key 解析为空字符串");

  console.log("③ 过期检查 sameRemoteConfig");
  check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === true, "两次读取完全一致");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/changed");
  check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === false, "push URL 变化 ⇒ 判定过期");
  git(repo, "remote", "set-url", "--push", "origin", "ssh://nas.example/origin-push");
  git(repo, "config", "remote.archive.annex-cost", "50");
  check(remotes.sameRemoteConfig(snapshot, remotes.readRemotes(repo)) === false, "特殊 remote 配置变化 ⇒ 判定过期");
  git(repo, "config", "--unset", "remote.archive.annex-cost");

  console.log("④ rowsFromSnapshot 只取单 URL 的 git remote");
  const rows = remotes.rowsFromSnapshot(snapshot);
  check(rows.length === 3, `3 行可编辑（origin / dotted.name / valueless，multi 被排除；得到 ${rows.length}）`);
  check(rows.every((row) => row.originalName === row.name), "每行记住原始名字");
  check(rows.find((row) => row.name === "origin").pushUrl === "ssh://nas.example/origin-push", "行里带出 push URL");

  console.log("⑤ 生成计划顺序 + 真仓库执行");
  const saveRepo = makeRepo("save");
  git(saveRepo, "remote", "add", "origin", "ssh://nas.example/old");
  git(saveRepo, "remote", "set-url", "--push", "origin", "ssh://nas.example/old-push");
  git(saveRepo, "remote", "add", "keep", "ssh://nas.example/keep");
  git(saveRepo, "remote", "add", "gone", "ssh://nas.example/gone");
  const before = remotes.readRemotes(saveRepo);
  const edited = remotes.rowsFromSnapshot(before).map((row) => ({ ...row }));
  edited.find((row) => row.name === "origin").fetchUrl = "ssh://nas.example/new";
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
    "remote set-url --delete --push origin ssh://nas.example/old-push",
    "remote add nas ssh://nas.example/nas",
    "remote set-url --push nas ssh://nas.example/nas-push",
  ];
  check(JSON.stringify(argv(plan.steps)) === JSON.stringify(expected), `命令顺序 = remove -> set-url fetch -> set-url push -> add：${argv(plan.steps).join(" / ")}`);
  const applied = remotes.applyRemotePlan(saveRepo, plan);
  check(applied.ok === true && applied.failed === null, "全部命令执行成功");
  const after = remotes.readRemotes(saveRepo);
  check(after.gitRemotes.every((remote) => remote.name !== "gone"), "gone 已从 .git/config 删除");
  const originAfter = after.gitRemotes.find((remote) => remote.name === "origin");
  check(originAfter.fetchUrls[0] === "ssh://nas.example/new", "fetch URL 已写入 git");
  check(originAfter.pushUrls.length === 0, "push URL 已清空（set-url --delete --push）");
  const nasAfter = after.gitRemotes.find((remote) => remote.name === "nas");
  check(nasAfter !== undefined && nasAfter.pushUrls[0] === "ssh://nas.example/nas-push", "新 remote 及其 push URL 已写入");

  console.log("⑥ rename 保留 annex-uuid / annex-ignore / push URL");
  const renameRepo = makeRepo("rename");
  git(renameRepo, "remote", "add", "origin", "ssh://nas.example/r");
  git(renameRepo, "remote", "set-url", "--push", "origin", "ssh://nas.example/r-push");
  git(renameRepo, "config", "remote.origin.annex-uuid", "uuid-1");
  git(renameRepo, "config", "remote.origin.annex-ignore", "true");
  const renameBefore = remotes.readRemotes(renameRepo);
  const renameRows = remotes.rowsFromSnapshot(renameBefore);
  renameRows[0].name = "upstream";
  const renamePlan = remotes.planRemoteChanges(renameRows, renameBefore);
  check(
    JSON.stringify(argv(renamePlan.steps)) === JSON.stringify(["remote rename origin upstream"]),
    "只生成 git remote rename 一条命令",
  );
  check(remotes.applyRemotePlan(renameRepo, renamePlan).ok === true, "rename 执行成功");
  const renamed = remotes.readRemotes(renameRepo);
  check(renamed.config["remote.upstream.annex-uuid"] === "uuid-1", "annex-uuid 跟着改名保留");
  check(renamed.config["remote.upstream.annex-ignore"] === "true", "annex-ignore 跟着改名保留");
  check(renamed.gitRemotes[0].pushUrls[0] === "ssh://nas.example/r-push", "push URL 跟着改名保留");

  console.log("⑦ 删除 + 同一保存里重新添加同名 remote");
  const readdRepo = makeRepo("readd");
  git(readdRepo, "remote", "add", "nas", "ssh://nas.example/old");
  const readdBefore = remotes.readRemotes(readdRepo);
  const readdPlan = remotes.planRemoteChanges(
    [{ originalName: "", name: "nas", fetchUrl: "ssh://nas.example/new", pushUrl: null }],
    readdBefore,
  );
  check(readdPlan.issues.length === 0, "同名重建不算冲突（remove 在前）");
  check(
    JSON.stringify(argv(readdPlan.steps)) === JSON.stringify(["remote remove nas", "remote add nas ssh://nas.example/new"]),
    "顺序是先 remove 再 add",
  );
  check(remotes.applyRemotePlan(readdRepo, readdPlan).ok === true, "同名重建执行成功");
  check(remotes.readRemotes(readdRepo).gitRemotes[0].fetchUrls[0] === "ssh://nas.example/new", "仓库里是新地址");

  console.log("⑧ 校验失败 ⇒ 一条命令都不跑");
  const invalidRepo = makeRepo("invalid");
  git(invalidRepo, "remote", "add", "origin", "ssh://nas.example/x");
  git(invalidRepo, "config", "remote.archive.type", "directory");
  git(invalidRepo, "config", "remote.archive.annex-uuid", "uuid-archive");
  const invalidBefore = remotes.readRemotes(invalidRepo);
  const configFile = path.join(invalidRepo, ".git", "config");
  const configBefore = fs.readFileSync(configFile, "utf8");
  const invalidRows = remotes.rowsFromSnapshot(invalidBefore);
  invalidRows[0].name = "bad name";
  invalidRows.push({ originalName: "", name: "archive", fetchUrl: "ssh://nas.example/a", pushUrl: null });
  const invalidPlan = remotes.planRemoteChanges(invalidRows, invalidBefore);
  check(invalidPlan.issues.length > 0, `非法名字 / 普通 remote 冲突都被报出来（${invalidPlan.issues.length} 条）`);
  check(invalidPlan.steps.length === 0, "有校验错误时计划里零命令");
  check(invalidRepo && fs.readFileSync(configFile, "utf8") === configBefore, ".git/config 逐字节未变");

  console.log("⑨ 中途失败 ⇒ 立即停止、返回部分结果、不回滚");
  const partialPlan = {
    issues: [],
    steps: [
      { kind: "set-fetch-url", name: "origin", args: ["remote", "set-url", "origin", "ssh://nas.example/y"], describe: "set fetch URL for origin" },
      { kind: "set-fetch-url", name: "missing", args: ["remote", "set-url", "missing", "ssh://nas.example/z"], describe: "set fetch URL for missing" },
      { kind: "add", name: "after", args: ["remote", "add", "after", "ssh://nas.example/after"], describe: "add remote after" },
    ],
  };
  const partial = remotes.applyRemotePlan(invalidRepo, partialPlan);
  check(partial.ok === false && partial.failed !== null && partial.failed.name === "missing", "在 missing 那条失败并停止");
  check(partial.results.length === 2 && partial.results[0].ok === true && partial.results[1].ok === false, "结果只含已尝试的两条");
  check(partial.results[1].detail.length > 0, `失败结果带 git stderr：${partial.results[1].detail.split("\n")[0]}`);
  check(runGit(invalidRepo, ["remote", "get-url", "after"]).code !== 0, "失败之后的命令没有执行");
  check(runGit(invalidRepo, ["remote", "get-url", "origin"]).stdout === "ssh://nas.example/y", "已执行的命令不回滚");

  console.log("⑩ specialRemoteDocUrl");
  const known = { name: "a", type: "directory", hasAnnexUuid: true, mainSetting: null, config: { type: "directory" } };
  const external = { name: "b", type: "rclone", hasAnnexUuid: true, mainSetting: null, config: { type: "external", externaltype: "rclone" } };
  const unknown = { name: "c", type: "mystery", hasAnnexUuid: true, mainSetting: null, config: { type: "mystery" } };
  check(remotes.specialRemoteDocUrl(known).endsWith("/special_remotes/directory/"), "已知类型 → 对应文档页");
  check(remotes.specialRemoteDocUrl(external).endsWith("/special_remotes/external/"), "external 类型 → external 文档页");
  check(remotes.specialRemoteDocUrl(unknown).endsWith("/special_remotes/"), "未知类型 → 索引页");

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
