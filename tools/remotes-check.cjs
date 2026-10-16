#!/usr/bin/env node
/**
 * 「remote 设置」的核心行为检查（真 git 仓库，不是桩）：
 *
 *   node tools/remotes-check.cjs
 *
 * 验的是 src/core/remotes.ts —— 也就是「初始化 gallery」第 6 步真正执行的那段：
 *   ① 空行/缺名称/缺地址/名称带空白 ⇒ skipped，且不动仓库；
 *   ② 全新仓库 ⇒ git remote add；
 *   ③ 同一条再跑一次 ⇒ unchanged（.git/config 逐字节不变）；
 *   ④ 改了地址 ⇒ git remote set-url（原来的 url 在结果里带出来）；
 *   ⑤ dry-run ⇒ 只报不加，仓库零变化；
 *   ⑥ 同名重复出现 ⇒ 只有第一条生效。
 *
 * 本脚本自己用 esbuild 把 TS 打成临时 CJS 再 require（跟 npm run build 同一套 bundler）。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "annex-remotes-check-"));

let pass = 0;
function check(condition, message) {
  assert.ok(condition, message);
  pass += 1;
  console.log(`  ✓ ${message}`);
}

/** src/core/remotes.ts → 临时 CJS，返回它的导出。 */
async function loadModule() {
  const esbuild = require(path.join(REPO, "node_modules", "esbuild"));
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

const git = (dir, ...args) => {
  try {
    return { code: 0, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

(async () => {
  const { applyRemotes, scanRemotes, mergeScannedRemotes } = await loadModule();
  const repo = path.join(WORK, "gallery");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "check@example.com");
  git(repo, "config", "user.name", "check");
  const configPath = path.join(repo, ".git", "config");
  const configBefore = fs.readFileSync(configPath, "utf8");

  console.log("① 坏行只跳过，不动仓库");
  const bad = applyRemotes(repo, [
    { name: "", url: "" },
    { name: "nas", url: "" },
    { name: "with space", url: "ssh://nas/x" },
    { name: "", url: "ssh://nas/x" },
  ]);
  check(bad.length === 3, `空行被忽略，其余 3 条有结果（得到 ${bad.length} 条）`);
  check(bad.every((r) => r.action === "skipped" && typeof r.detail === "string"), `三条都 skipped 且带原因：${bad.map((r) => r.detail).join(" / ")}`);
  check(fs.readFileSync(configPath, "utf8") === configBefore, "坏行之后 .git/config 逐字节未变");

  console.log("② 新 remote 走 git remote add");
  const added = applyRemotes(repo, [
    { name: "origin", url: "ssh://nas.example/volume1/Data_lab_10" },
    { name: "backup", url: "/Volumes/Backup/Data_lab_10" },
  ]);
  check(added.map((r) => r.action).join(",") === "added,added", `两条都 added：${added.map((r) => `${r.name}=${r.action}`).join(" ")}`);
  check(git(repo, "remote", "get-url", "origin").out.trim() === "ssh://nas.example/volume1/Data_lab_10", "origin 的地址写进了仓库");
  check(git(repo, "remote", "get-url", "backup").out.trim() === "/Volumes/Backup/Data_lab_10", "backup 的地址写进了仓库");

  console.log("③ 再跑一次同一条 → unchanged（幂等）");
  const configAfterAdd = fs.readFileSync(configPath, "utf8");
  const again = applyRemotes(repo, [{ name: "origin", url: "ssh://nas.example/volume1/Data_lab_10" }]);
  check(again[0].action === "unchanged" && again[0].previous === "ssh://nas.example/volume1/Data_lab_10", "地址没变 ⇒ unchanged，并带回原地址");
  check(fs.readFileSync(configPath, "utf8") === configAfterAdd, "幂等：.git/config 逐字节未变");

  console.log("④ 改地址走 git remote set-url");
  const changed = applyRemotes(repo, [{ name: "origin", url: "ssh://nas.example/volume2/Data_lab_10" }]);
  check(changed[0].action === "updated" && changed[0].previous === "ssh://nas.example/volume1/Data_lab_10", "updated，并带回旧地址");
  check(git(repo, "remote", "get-url", "origin").out.trim() === "ssh://nas.example/volume2/Data_lab_10", "仓库里的地址真的换了");

  console.log("⑤ dry-run 只报不写");
  const beforeDry = fs.readFileSync(configPath, "utf8");
  const dry = applyRemotes(
    repo,
    [
      { name: "origin", url: "ssh://nas.example/volume3/Data_lab_10" },
      { name: "third", url: "ssh://nas.example/volume3/third" },
    ],
    { dryRun: true },
  );
  check(dry.map((r) => r.action).join(",") === "updated,added", `dry-run 报 updated + added：${dry.map((r) => `${r.name}=${r.action}`).join(" ")}`);
  check(fs.readFileSync(configPath, "utf8") === beforeDry, "dry-run 之后 .git/config 逐字节未变");

  console.log("⑥ 同名重复只认第一条");
  const dup = applyRemotes(repo, [
    { name: "dup", url: "ssh://nas.example/a" },
    { name: "dup", url: "ssh://nas.example/b" },
  ]);
  check(dup[0].action === "added" && dup[1].action === "skipped", `第一条 added、第二条 skipped：${dup.map((r) => `${r.action}${r.detail === undefined ? "" : `(${r.detail})`}`).join(" / ")}`);
  check(git(repo, "remote", "get-url", "dup").out.trim() === "ssh://nas.example/a", "仓库里留下的是第一条的地址");

  console.log("⑦ 从仓库扫描 remote（加载插件时自动补进设置）");
  const scanned = scanRemotes(repo);
  check(
    scanned.map((r) => r.name).sort().join(",") === "backup,dup,origin",
    `git remote -v 扫出仓库里真实存在的 3 条：${scanned.map((r) => `${r.name}=${r.url}`).join(" ")}`,
  );
  check(scanned.find((r) => r.name === "origin").url === "ssh://nas.example/volume2/Data_lab_10", "扫到的地址就是仓库里那条（不是设置里的）");

  const empty = mergeScannedRemotes([], scanned);
  check(empty.added.length === 3 && empty.remotes.length === 3, `设置里为空 ⇒ 3 条全补进来：${empty.added.join(",")}`);

  const partial = mergeScannedRemotes([{ name: "origin", url: "ssh://我刚改的/xx" }], scanned);
  check(partial.added.sort().join(",") === "backup,dup", `只补缺的两条：${partial.added.join(",")}`);
  check(
    partial.remotes.find((r) => r.name === "origin").url === "ssh://我刚改的/xx",
    "同名那条**不覆盖**用户刚改的地址（仓库旧地址不会盖回来）",
  );
  check(mergeScannedRemotes([{ name: "", url: "" }], scanned).added.length === 3, "空草稿行不算已配置，三条照样补进来");
  check(scanRemotes(path.join(WORK, "not-a-repo")).length === 0, "不是 git 仓库 ⇒ 扫出 0 条（不报错）");

  console.log(`\nREMOTES PASS=${pass} FAIL=0`);
  fs.rmSync(WORK, { recursive: true, force: true });
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
