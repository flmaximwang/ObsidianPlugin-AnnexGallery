#!/usr/bin/env node
/**
 * 「状态栏：未提交 / 未跟踪 / 未入库 largefiles」的端到端校验（spec: docs/status-bar.md）。
 *
 * 在一个**临时** annex 仓库里复刻真实布局（图片进 annex、`.md` / `.thumbnail.png` 按
 * `annex.largefiles=nothing` 进 git），用 `tools/smoke-test.cjs` 的同一套桩加载**构建产物**
 * `main.js`，然后逐场景断言状态栏那一行的文字：
 *
 *   1. 干净仓库 → `未提交 0 · 未跟踪 0 · 未入库 largefiles 0`（data-level=zero）；
 *   2. 拷进 2 张图 + 1 个 `.md`（都未跟踪）→ `未跟踪 3 · 未入库 largefiles 2`
 *      —— `.md` 只算未跟踪，不算 largefile（它按 .gitattributes 进 git）；
 *   3. `git annex add .` 之后（已 add 未 commit）→ `未提交 3 · 未跟踪 0 · 未入库 largefiles 0`
 *      —— 「未入库」是「还没 add 进 annex」，不是「还没 commit」；
 *   4. commit 后归零；再改一张已 annexed 的图 → `未提交 1 · 未入库 largefiles 1`
 *      （已跟踪但改过还没重新 add 的大文件也算未入库）；
 *   5. 未跟踪目录里的 3 个文件算 3（`-uall`，一个文件一行，不是 `?? dir/` 一行）；
 *   6. 非 annex 仓库 / 非 git 目录 → `未初始化 · 点击初始化 gallery`，悬停提示写明原因；
 *   6b. PATH 只剩 launchd 那四个目录（= 从 Finder / Dock 启动的 Obsidian）→ 仍然量出三个数
 *      （子进程 PATH 末尾补了 /opt/homebrew/bin 等目录）；关掉补 PATH 时改报
 *      「找不到 git-annex 命令」—— 见 issues/git-annex-not-on-gui-path_2026.10.19.md；
 *   7. 空目录上**点击状态栏** → 真跑「初始化 gallery」（`.git/annex` 出现），
 *      刷新后 `未跟踪 2 · 未入库 largefiles 0`（两个 dotfile 进 git 不算 largefile）；
 *   8. 注册 1 个状态栏项、文字 + `refresh-cw` 图标、30 秒轮询（间隔字段与 setInterval 一致）。
 *
 *   node tools/status-check.cjs
 *
 * 需要 `git` 与 `git annex`（没有 annex 时打印 SKIP 并以 0 退出）。全程只动 `os.tmpdir()`
 * 下的临时目录，跑完删掉。
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
function commit(cwd, message) {
  return git(["-c", "user.email=verify@local", "-c", "user.name=verify", "commit", "-qm", message], cwd);
}
function writeRandom(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(bytes));
}
function byClass(root, cls) {
  return stub.walk(root).filter((el) => el.hasClass(cls));
}

/** 载入构建产物（与 smoke-test 同一套桩）。 */
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

/** 建一个插件（vault 根 = dir），并把它那一行状态栏元素 + 文字读出来。 */
async function withPlugin(dir) {
  const before = stub.registry.statusBarItems.length;
  const plugin = new PluginClass(stub.makeApp(dir), { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  await plugin.refreshStatus(); // 把 onload 那趟一起排空，之后每次刷新都是确定性的
  return {
    plugin,
    el: stub.registry.statusBarItems[stub.registry.statusBarItems.length - 1],
    itemsAdded: stub.registry.statusBarItems.length - before,
  };
}

function textOf(el) {
  const span = byClass(el, "annex-status-counts")[0];
  return span === undefined ? "" : span.textContent;
}

async function main() {
  const version = sh("git", ["annex", "version"]);
  if (version.status !== 0) {
    console.log("SKIP：这台机器上没有 git annex，跳过（插件本身不需要它才能加载）。");
    return;
  }

  const lab = fs.mkdtempSync(path.join(os.tmpdir(), "annex-status-verify-"));
  const gallery = path.join(lab, "gallery");
  const notAnnex = path.join(lab, "not-annex");
  const notRepo = path.join(lab, "not-repo");
  const fresh = path.join(lab, "fresh");
  try {
    // ── 造场景 ────────────────────────────────────────────────────────────
    fs.mkdirSync(gallery, { recursive: true });
    git(["init", "-q", "."], gallery);
    git(["annex", "init", "-q", "verify-status"], gallery);
    fs.writeFileSync(
      path.join(gallery, ".gitattributes"),
      [
        "# 默认都进 annex",
        "*               annex.largefiles=anything",
        "*.thumbnail.png annex.largefiles=nothing",
        "*.md            annex.largefiles=nothing",
        "*.base          annex.largefiles=nothing",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(gallery, ".gitignore"), ".obsidian\n");
    writeRandom(path.join(gallery, "sub/ses1/a.tif"), 200 * 1024);
    writeRandom(path.join(gallery, "sub/ses1/a.thumbnail.png"), 4096);
    fs.writeFileSync(path.join(gallery, "sub/ses1/a.md"), `---\nsample: "verify"\n---\n`);
    git(["annex", "add", "."], gallery);
    commit(gallery, "init gallery");

    fs.mkdirSync(notAnnex, { recursive: true });
    git(["init", "-q", "."], notAnnex);
    fs.mkdirSync(notRepo, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });

    console.log(`临时仓库 ${lab}`);
    check(fs.existsSync(path.join(gallery, ".git/annex")), "场景就绪：gallery 是 git-annex 仓库（.git/annex 存在）");

    // ── 1. 干净仓库 ───────────────────────────────────────────────────────
    const galleryPlugin = await withPlugin(gallery);
    console.log(`  干净仓库 → ${textOf(galleryPlugin.el)}`);
    check(textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 0 · 未入库 largefiles 0", "干净仓库：三项全 0");
    check(galleryPlugin.el.getAttr("data-level") === "zero", "干净仓库：data-level=zero（配色用）");
    check(
      /每 30 秒自动刷新/.test(String(galleryPlugin.el.getAttr("aria-label"))),
      "悬停提示写明「每 30 秒自动刷新」",
    );
    check(
      /未入库 largefiles：git annex add --dry-run/.test(String(galleryPlugin.el.getAttr("aria-label"))),
      "悬停提示写明「未入库 largefiles」的口径",
    );

    // ── 2. 拷进 2 张图 + 1 个 .md（未跟踪）────────────────────────────────
    writeRandom(path.join(gallery, "sub/ses2/b.tif"), 200 * 1024);
    writeRandom(path.join(gallery, "sub/ses2/c.tif"), 200 * 1024);
    fs.writeFileSync(path.join(gallery, "sub/ses2/b.md"), `---\nsample: "b"\n---\n`);
    await galleryPlugin.plugin.refreshStatus();
    console.log(`  2 图 + 1 md（未跟踪）→ ${textOf(galleryPlugin.el)}`);
    check(textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 3 · 未入库 largefiles 2", "未跟踪 3 个，其中 2 个是未入库 largefiles");
    check(!/未入库 largefiles 3/.test(textOf(galleryPlugin.el)), "未跟踪的 .md 不算 largefile（它按 .gitattributes 进 git）");

    // ── 3. 已 add 未 commit ───────────────────────────────────────────────
    git(["annex", "add", "."], gallery);
    await galleryPlugin.plugin.refreshStatus();
    console.log(`  git annex add 之后（未 commit）→ ${textOf(galleryPlugin.el)}`);
    check(
      textOf(galleryPlugin.el) === "未提交 3 · 未跟踪 0 · 未入库 largefiles 0",
      "已 add 未 commit：未提交 3、未入库 0（「未入库」= 还没 add 进 annex，不是「还没 commit」）",
    );

    // ── 4. commit 后归零 → 改一张已 annexed 的图 ──────────────────────────
    commit(gallery, "add b/c");
    await galleryPlugin.plugin.refreshStatus();
    check(textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 0 · 未入库 largefiles 0", "commit 后三项归零");
    // 真实工作流：annex 文件先 `git annex unlock`（locked 时是指向 .git/annex/objects 的只读软链，
    // 直接写会 EACCES），再写新内容 —— 这时它在 index 里还没被重新 add。
    git(["annex", "unlock", "sub/ses1/a.tif"], gallery);
    writeRandom(path.join(gallery, "sub/ses1/a.tif"), 210 * 1024);
    await galleryPlugin.plugin.refreshStatus();
    console.log(`  改一张已 annexed 的图（解锁后改内容，未重新 add）→ ${textOf(galleryPlugin.el)}`);
    check(
      textOf(galleryPlugin.el) === "未提交 1 · 未跟踪 0 · 未入库 largefiles 1",
      "已跟踪但改过还没重新 add 的大文件：未提交 1、未入库 1",
    );
    git(["annex", "add", "."], gallery);
    await galleryPlugin.plugin.refreshStatus();
    check(textOf(galleryPlugin.el) === "未提交 1 · 未跟踪 0 · 未入库 largefiles 0", "重新 add 后未入库归 0（未提交仍 1）");
    commit(gallery, "re-add a");
    await galleryPlugin.plugin.refreshStatus();
    check(textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 0 · 未入库 largefiles 0", "再 commit 后三项归零");

    // ── 5. 未跟踪目录：一个文件一行（-uall）────────────────────────────────
    for (const name of ["x.tif", "y.tif", "z.tif"]) writeRandom(path.join(gallery, "sub/ses3", name), 64 * 1024);
    await galleryPlugin.plugin.refreshStatus();
    console.log(`  未跟踪目录里 3 个文件 → ${textOf(galleryPlugin.el)}`);
    check(textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 3 · 未入库 largefiles 3", "未跟踪目录按文件计数（3，不是 1）");
    check(
      git(["status", "--porcelain"], gallery).stdout.trim() === "?? sub/ses3/",
      "对照：不带 -uall 的 porcelain 只给一行 `?? sub/ses3/`（所以状态栏用的是 -uall）",
    );

    // ── 5b. 被 .gitignore 忽略的文件不算（git status 与 annex add 都尊重它）──
    fs.mkdirSync(path.join(gallery, ".obsidian/plugins/x"), { recursive: true });
    fs.writeFileSync(path.join(gallery, ".obsidian/plugins/x/data.json"), "{}");
    writeRandom(path.join(gallery, ".obsidian/plugins/x/big.bin"), 32 * 1024);
    await galleryPlugin.plugin.refreshStatus();
    check(
      textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 3 · 未入库 largefiles 3",
      "被 .gitignore 忽略的 .obsidian 下的文件一个都不算（数字与上一步相同）",
    );

    // ── 5c. 只有 launchd 那份 PATH（从 Finder / Dock 启动的 Obsidian）────────
    //
    // 实测（issues/git-annex-not-on-gui-path_2026.10.19.md）：GUI 里 PATH 只有
    // /usr/bin:/bin:/usr/sbin:/sbin，Homebrew 的 /opt/homebrew/bin 不在里面 ——
    // `git` 找得到（/usr/bin/git），`git annex` 却退化成
    // `git: 'annex' is not a git command. See 'git --help'.`。
    const realPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      delete process.env.ANNEX_GALLERY_NO_PATH_FIX;
      const bare = sh("git", ["-C", gallery, "annex", "add", "--dry-run", "--json"]);
      check(
        bare.status === 1 && /'annex' is not a git command/.test(bare.stderr),
        "对照：这份 PATH 下裸跑 git annex 就是用户看到的那句报错（复现）",
      );
      await galleryPlugin.plugin.refreshStatus();
      console.log(`  GUI 式 PATH（只剩 launchd 那四个目录）→ ${textOf(galleryPlugin.el)}`);
      check(
        textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 3 · 未入库 largefiles 3",
        "同一份 PATH 下仍然量出三个数（子进程 PATH 末尾补了 /opt/homebrew/bin 等目录）",
      );
      check(galleryPlugin.el.getAttr("data-level") === "dirty", "data-level=dirty，不是 unavailable");

      process.env.ANNEX_GALLERY_NO_PATH_FIX = "1";
      await galleryPlugin.plugin.refreshStatus();
      console.log(`  关掉补 PATH 之后 → ${textOf(galleryPlugin.el)}`);
      check(
        textOf(galleryPlugin.el) === "无法统计：找不到 git-annex 命令（brew install git-annex）",
        "真的找不到 git-annex 时，报「找不到 git-annex 命令（brew install git-annex）」",
      );
      check(
        !/is not a git command/.test(textOf(galleryPlugin.el)),
        "不再出现 git 的原文（那句对用户没有出路）",
      );
      check(
        /launchd/.test(String(galleryPlugin.el.getAttr("aria-label"))),
        "悬停提示补上原因：GUI 启动的 Obsidian 只有 launchd 那份极小 PATH",
      );
    } finally {
      delete process.env.ANNEX_GALLERY_NO_PATH_FIX;
      process.env.PATH = realPath;
    }
    await galleryPlugin.plugin.refreshStatus();
    check(
      textOf(galleryPlugin.el) === "未提交 0 · 未跟踪 3 · 未入库 largefiles 3",
      "PATH 恢复后数字与之前一致（补 PATH 是纯追加，不改变原有解析顺序）",
    );

    // ── 6. 非 annex 仓库 / 非 git 目录 ─────────────────────────────────────
    const notAnnexPlugin = await withPlugin(notAnnex);
    console.log(`  非 annex 仓库 → ${textOf(notAnnexPlugin.el)}`);
    check(textOf(notAnnexPlugin.el) === "未初始化 · 点击初始化 gallery", "非 annex 仓库：提示「未初始化 · 点击初始化 gallery」");
    check(notAnnexPlugin.el.getAttr("data-level") === "uninitialized", "data-level=uninitialized");
    check(
      /不是 git-annex 仓库/.test(String(notAnnexPlugin.el.getAttr("aria-label"))),
      "悬停提示写明原因（不是 git-annex 仓库）",
    );

    const notRepoPlugin = await withPlugin(notRepo);
    console.log(`  非 git 目录 → ${textOf(notRepoPlugin.el)}`);
    check(textOf(notRepoPlugin.el) === "未初始化 · 点击初始化 gallery", "非 git 目录：同样提示未初始化");
    check(/不是 git 仓库/.test(String(notRepoPlugin.el.getAttr("aria-label"))), "悬停提示写明原因（不是 git 仓库）");

    // ── 7. 空目录上点击状态栏 → 真跑「初始化 gallery」──────────────────────
    const freshPlugin = await withPlugin(fresh);
    check(textOf(freshPlugin.el) === "未初始化 · 点击初始化 gallery", "fresh 目录：未初始化");
    const noticesBefore = stub.registry.notices.length;
    freshPlugin.el.click();
    await freshPlugin.plugin.refreshStatus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await freshPlugin.plugin.refreshStatus();
    const clickNotice = stub.registry.notices.slice(noticesBefore).join(" | ");
    console.log(`  点击后 → ${clickNotice.split(" | ")[0]?.split("\n")[0] ?? "(没有 Notice)"}`);
    check(/初始化 gallery 完成/.test(clickNotice), "点击未初始化的状态栏 → 跑完「初始化 gallery」并给出完成报告");
    check(fs.existsSync(path.join(fresh, ".git/annex")), "点击之后 fresh 真的是 annex 仓库了（盘上复核）");
    console.log(`  初始化之后 → ${textOf(freshPlugin.el)}`);
    check(
      textOf(freshPlugin.el) === "未提交 0 · 未跟踪 2 · 未入库 largefiles 0",
      "初始化之后：.gitattributes / .gitignore 两个未跟踪 dotfile 进 git，不算 largefile",
    );

    // ── 8. 状态栏项本身（一个、文字 + 图标、30 秒轮询）────────────────────
    check(galleryPlugin.itemsAdded === 1, "onload 只注册 1 个状态栏项");
    check(byClass(galleryPlugin.el, "annex-status-counts").length === 1, "状态栏项里有文字 span");
    const icon = byClass(galleryPlugin.el, "annex-status-refresh")[0];
    check(icon !== undefined && icon.getAttr("data-icon") === "refresh-cw", "状态栏项里有 refresh-cw 刷新图标");
    check(stub.registry.domEvents.some((entry) => entry.el === galleryPlugin.el && entry.type === "click"), "点击监听挂在状态栏项上（registerDomEvent）");
    check(galleryPlugin.plugin.statusRefreshMs === 30_000, "刷新间隔字段 = 30000ms");
    const statusIntervals = stub.registry.windowIntervals.filter((entry) => entry.ms === 30_000);
    check(statusIntervals.length >= 1, "window.setInterval 真的按 30000ms 注册（桩记下间隔毫秒）");
    check(
      stub.registry.intervals.includes(statusIntervals[0].id),
      "registerInterval 收到的是同一个 id（卸载时由框架 clearInterval）",
    );

    console.log(`\nPASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    else console.log("VERIFY-STATUS OK");
  } finally {
    // annex 的对象文件是只读的（mode 400/444），Node 的 rmSync 会半途 EACCES 失败。
    sh("chmod", ["-R", "u+w", lab]);
    sh("rm", ["-rf", lab]);
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
