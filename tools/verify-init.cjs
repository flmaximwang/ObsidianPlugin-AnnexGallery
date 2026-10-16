#!/usr/bin/env node
/**
 * 「初始化 gallery」命令的端到端校验（spec: docs/commands.md）。
 *
 * 用 `tools/smoke-test.cjs` 的同一套桩加载**构建产物** `main.js`，跑插件注册的那条命令
 * （`init-gallery`）本身 —— 不是只调 `src/core/init.ts`，所以连 Notice 文案一起核。
 *
 *   1. 空目录 → 跑命令：`git init -b main` + `git annex init` + `annex.addunlocked=true`
 *      + 合并两条规则文件，跑完 `.git/annex` 在盘上（真仓库，不是只看 Notice）；
 *   2. **命令不碰工作树**：init 之前就摆在那里的文件跑完仍是未跟踪（不 add / 不 commit）；
 *   3. **形态口径**：init 之后 `git annex add` 的新文件是 unlocked —— index mode `100644`、
 *      工作树里是真实文件（`lstat().isSymbolicLink() === false`），不是 `120000` 符号链接；
 *   4. **幂等**：再跑一次命令，git-annex 分支的提交**不动**（`annex.addunlocked` 已是 true 就
 *      不再 `--set`），Notice 写「已是 true，未改动」；
 *   5. **只管以后 add 的**：init 之前就已经 locked 的 annex 文件跑完仍是 locked（`120000`）——
 *      想解锁得另跑 `git annex unlock`；
 *   6. `--dry-run`（CLI 路径）：一个字节都不写（没有 `.git`），JSON 里 `action: "planned"`。
 *
 *   node tools/verify-init.cjs
 *
 * 需要 `git` 与 `git annex`（没有 annex 时打印 SKIP 并以 0 退出）。全程只动 `os.tmpdir()`
 * 下的临时目录，跑完删掉。前置：`npm run build`（读的是 `main.js` 与 `tools/annex-gallery.mjs`）。
 */
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function check(cond, msg) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}`);
  }
}

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
const git = (args, cwd) => sh("git", args, cwd);
const annexConfig = (key, cwd) => git(["annex", "config", "--get", key], cwd).stdout.trim();
/** `git ls-files -s <file>` 的 mode 字段（`100644` = unlocked 真实文件 / `120000` = locked 符号链接）。 */
function indexMode(file, cwd) {
  const line = git(["ls-files", "-s", "--", file], cwd).stdout.trim();
  return line === "" ? "" : line.split(/\s+/)[0];
}
/** git-annex 分支当前的提交（幂等判据：写没写新配置就看它动没动）。 */
const annexBranchHead = (cwd) => git(["rev-parse", "git-annex"], cwd).stdout.trim();
function writeRandom(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(bytes));
}

/** 载入构建产物（与 smoke-test / status-check 同一套桩）。 */
const stub = require(path.join(__dirname, "obsidian-stub.cjs"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};
let PluginClass;
try {
  PluginClass = require(path.join(repo, "main.js")).default;
} finally {
  Module._load = originalLoad;
}

/** 建一个插件（vault 根 = dir）并把它 onload 那一趟排空。 */
async function withPlugin(dir) {
  const plugin = new PluginClass(stub.makeApp(dir), { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  await plugin.refreshStatus(); // 状态栏在 onload 里就开跑，先排空，后面读 Notice 才是确定性的
  return plugin;
}

/**
 * 跑「初始化 gallery」命令并等它的 Notice 落地。
 *
 * 命令的回调是 `void this.runInit()`（不返回 Promise），所以只能等副作用：`git annex init`
 * 在空目录上要几秒，这里最多等 60 秒。
 *
 * 取**最后注册**的那条命令（`registry.commands.at(-1)`）：每个场景都新建一个插件实例，
 * `find()` 会拿到第一个实例的命令，于是命令跑在**上一个** vault 根上 —— 实测踩过。
 */
async function runInitCommand() {
  const command = stub.registry.commands.at(-1);
  if (command === undefined || command.id !== "init-gallery") throw new Error("插件没注册 init-gallery 命令");
  const before = stub.registry.notices.length;
  command.callback();
  for (let i = 0; i < 1200; i += 1) {
    if (stub.registry.notices.length > before) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return stub.registry.notices.slice(before).join("\n");
}

async function main() {
  if (sh("git", ["annex", "version"]).status !== 0) {
    console.log("SKIP：这台机器上没有 git annex，跳过（插件本身不需要它才能加载）。");
    return;
  }

  const lab = fs.mkdtempSync(path.join(os.tmpdir(), "annex-init-verify-"));
  const fresh = path.join(lab, "fresh");
  const legacy = path.join(lab, "legacy-locked");
  const dry = path.join(lab, "dry-run");
  try {
    // ── 1. 空目录：跑命令 ────────────────────────────────────────────────
    console.log("1. 空目录 → 「初始化 gallery」");
    fs.mkdirSync(fresh, { recursive: true });
    // init **之前**就摆在那里的文件：命令不许碰它（不 add / 不 commit）。
    writeRandom(path.join(fresh, "photo.bin"), 1024);
    await withPlugin(fresh);
    const notice = await runInitCommand();
    console.log(`   Notice：${notice.split("\n").slice(0, 6).join(" / ")}`);
    check(/初始化 gallery 完成/.test(notice), "命令跑完给出「初始化 gallery 完成」报告");
    check(/annex\.addunlocked：已设为 true/.test(notice), "报告里有「annex.addunlocked：已设为 true」一行");
    check(fs.existsSync(path.join(fresh, ".git")), "盘上出现了 .git");
    check(fs.existsSync(path.join(fresh, ".git/annex")), "盘上出现了 .git/annex（真的是 annex 仓库）");
    check(
      fs.readFileSync(path.join(fresh, ".gitattributes"), "utf8").includes("*               annex.largefiles=anything"),
      ".gitattributes 合并进了内置规则",
    );
    check(fs.readFileSync(path.join(fresh, ".gitignore"), "utf8").includes(".obsidian"), ".gitignore 合并进了 .obsidian");
    check(
      git(["status", "--porcelain", "--", "photo.bin"], fresh)
        .stdout.trim()
        .startsWith("??"),
      "init 之前就在的文件跑完仍是未跟踪（命令不 add、不 commit）",
    );

    // ── 2. 形态口径：新文件以 unlocked 入库 ──────────────────────────────
    console.log("2. annex.addunlocked → 新文件 unlocked 入库");
    check(annexConfig("annex.addunlocked", fresh) === "true", "git annex config --get annex.addunlocked = true");
    check(
      git(["show", "git-annex:config.log"], fresh)
        .stdout.includes("annex.addunlocked true"),
      "写进了 git-annex 分支的 config.log（跟着分支传播，不是本地 .git/config）",
    );
    check(git(["config", "--local", "--get", "annex.addunlocked"], fresh).stdout.trim() === "", "本地 .git/config 里没有这个键");
    git(["annex", "add", "--", "photo.bin"], fresh);
    check(indexMode("photo.bin", fresh) === "100644", "git annex add 之后 index mode = 100644（unlocked，不是 120000）");
    check(!fs.lstatSync(path.join(fresh, "photo.bin")).isSymbolicLink(), "工作树里 photo.bin 是真实文件，不是指向 .git/annex 的符号链接");
    check(
      git(["annex", "find", "--in=here", "--format=${file}"], fresh).stdout.includes("photo.bin"),
      "photo.bin 确实在 annex 里（annex find --in=here 列得到）",
    );

    // ── 3. 幂等：再跑一次不动 git-annex 分支 ─────────────────────────────
    console.log("3. 再跑一次（幂等）");
    const headBefore = annexBranchHead(fresh);
    const notice2 = await runInitCommand();
    const headAfter = annexBranchHead(fresh);
    check(/annex\.addunlocked：已是 true，未改动/.test(notice2), "第二次报告写「已是 true，未改动」");
    check(headBefore !== "" && headBefore === headAfter, `git-annex 分支没有新提交（${headBefore.slice(0, 7)} 未变）`);
    check(annexConfig("annex.addunlocked", fresh) === "true", "配置仍是 true");

    // ── 4. 只管以后 add 的：已 locked 的老文件不动 ────────────────────────
    console.log("4. 已 locked 的老文件 → 仍在 locked");
    fs.mkdirSync(legacy, { recursive: true });
    git(["init", "-q", "-b", "main", "."], legacy);
    git(["annex", "init", "-q", "legacy"], legacy);
    writeRandom(path.join(legacy, "old.bin"), 1024);
    git(["annex", "add", "--", "old.bin"], legacy);
    check(indexMode("old.bin", legacy) === "120000", "（前置）addunlocked 没设时 add 的是 locked 符号链接 120000");
    await withPlugin(legacy);
    const notice3 = await runInitCommand();
    check(annexConfig("annex.addunlocked", legacy) === "true", "跑命令后配置变成 true");
    check(indexMode("old.bin", legacy) === "120000", "已经 locked 的 old.bin 仍是 120000（addunlocked 只管以后 add 的）");
    check(/已设为 true/.test(notice3), "报告写的是「已设为 true」（这一次真的写了配置）");

    // ── 5. --dry-run：一个字节都不写（CLI 路径，同一条 core）─────────────
    console.log("5. CLI --dry-run");
    fs.mkdirSync(dry, { recursive: true });
    const cli = sh("node", [path.join(repo, "tools/annex-gallery.mjs"), "init", dry, "--dry-run", "--json"]);
    const payload = cli.stdout.startsWith("{") ? JSON.parse(cli.stdout) : {};
    check(cli.status === 0, `node tools/annex-gallery.mjs init <dir> --dry-run --json 退出码 0（实际 ${cli.status}）`);
    check(payload.addUnlocked !== undefined && payload.addUnlocked.action === "planned", "JSON 里 addUnlocked.action = planned");
    check(!fs.existsSync(path.join(dry, ".git")), "dry-run 之后没有 .git（一个字节都没写）");

    console.log(`\nPASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    else console.log("VERIFY-INIT OK");
  } finally {
    // annex 的对象文件是只读的（mode 400/444），Node 的 rmSync 会半途 EACCES 失败。
    sh("chmod", ["-R", "u+w", lab]);
    sh("rm", ["-rf", lab]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
