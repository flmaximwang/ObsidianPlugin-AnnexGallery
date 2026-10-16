#!/usr/bin/env node
/**
 * largefiles 菜单（8 项里的 6 个 annex 操作 + drop）的端到端校验。
 *
 * 在**临时** annex 仓库里复刻真实布局 —— 图片进 annex、`.md` / `.thumbnail.png` 按
 * `annex.largefiles=nothing` 进 git、另一个仓库有副本、另有一个文件只有本地这一份 —— 然后：
 *
 *   1. `annex add`      ：未跟踪的新图进 annex（locked 软链），`.md` 不进 annex；候选数只算图片
 *   2. `annex unlock`   ：变实文件（index 100644，Obsidian 能索引）
 *   3. `annex lock`     ：变回软链（index 120000）
 *   4. `annex drop`     ：别处有副本的丢成、本地唯一副本被挡下；`.md` / 缩略图逐字节未动
 *   5. `annex get`      ：内容取回本地
 *   6. `annex unannex`  ：退出 annex、内容留在盘上、并被 `git add` 回索引
 *   7. 插件路径         ：桩加载构建产物 main.js，走「右键 → 菜单项 → Notice」，动作真的落到盘上
 *   8. 非 git 仓库的目录：明确报错 + 退出码 1
 *
 *   node tools/verify-annex-ops.cjs
 *
 * 需要 `git` 与 `git annex`（没有 annex 时打印 SKIP 并以 0 退出）。全程只动 `os.tmpdir()` 下的临时目录。
 */
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const cli = path.join(repo, "tools", "annex-gallery.mjs");

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
function annexFind(cwd, extra = []) {
  return git(["annex", "find", "--format=${file}\\n", ...extra], cwd)
    .stdout.split(/\r?\n/)
    .filter((line) => line !== "");
}
function indexMode(cwd, file) {
  const out = git(["ls-files", "-s", "--", file], cwd).stdout.trim();
  return out === "" ? "(不在 index)" : out.split(/\s+/)[0];
}
function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function writeRandom(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(bytes));
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function runCli(args) {
  return sh(process.execPath, [cli, ...args]);
}
function runCliJson(args) {
  const r = runCli(args);
  if (r.stdout.trim() === "") {
    throw new Error(`CLI ${args.join(" ")} 没有输出（exit=${r.status}）\nstderr: ${r.stderr}`);
  }
  if (r.status !== 0) {
    throw new Error(`CLI ${args.join(" ")} 退出码 ${r.status}\nstderr: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}
function runCliExpectError(args) {
  return runCli(args);
}

/** 一个临时的真 annex 仓库：图片进 annex，md/缩略图进 git，clone 里另存一份副本。 */
function makeRepo(label, imageNames, addPaths = ["images"]) {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), `annex-ops-${label}-`));
  const src = path.join(lab, "src");
  const clone = path.join(lab, "clone");
  fs.mkdirSync(src, { recursive: true });
  git(["init", "-q", "."], src);
  git(["annex", "init", "-q", `verify-${label}`], src);
  writeText(
    path.join(src, ".gitattributes"),
    ["*               annex.largefiles=anything", "*.thumbnail.png annex.largefiles=nothing", "*.md            annex.largefiles=nothing", ""].join("\n"),
  );
  for (const image of imageNames) {
    writeRandom(path.join(src, image), 200 * 1024);
    const stem = image.replace(/\.(tif|png)$/, "");
    writeText(path.join(src, `${stem}.md`), `---\nsample: "verify"\n---\n`);
    writeRandom(path.join(src, `${stem}.thumbnail.png`), 4096);
  }
  git(["annex", "add", "--", ...addPaths], src);
  commit(src, "add images");
  git(["clone", "-q", src, clone], undefined);
  git(["annex", "init", "-q", `verify-${label}-clone`], clone);
  git(["remote", "add", "clone", clone], src);
  return { lab, src, clone };
}

/** 桩加载构建产物 main.js（与 tools/smoke-test.cjs 同一套做法）。 */
function loadPlugin(vaultPath) {
  const Module = require("module");
  const stub = require(path.join(repo, "tools", "obsidian-stub.cjs"));
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
  return { stub, PluginClass };
}

async function main() {
  if (sh("git", ["annex", "version"]).status !== 0) {
    console.log("SKIP：这台机器上没有 git annex，跳过（插件本身不需要它才能加载）。");
    return;
  }
  const cleanup = [];

  // ══ 1. annex 操作：add / unlock / lock / get / unannex ══════════════════
  console.log("\n── annex 操作（临时真 annex 仓）──");
  {
    const images = ["images/a.tif", "images/b.tif", "images/sub/c.tif"];
    const { lab, src } = makeRepo("ops", images);
    cleanup.push(lab);
    // 新图（未跟踪）+ 只给 copy 的副本：new.tif 故意不拷给 clone，用它验证「唯一副本」路径
    writeRandom(path.join(src, "images/new.tif"), 150 * 1024);
    git(["annex", "copy", "--to", "clone", "--", "images/a.tif", "images/b.tif", "images/sub/c.tif"], src);

    console.log(`  临时仓库 ${lab}`);
    check(annexFind(src, ["--in=here"]).length === 3, "起点：3 个图片已在 annex（locked）");
    check(indexMode(src, "images/a.tif") === "120000", "起点：a.tif 是 locked 软链（index 120000）");

    // ── add ──
    const addReport = runCliJson(["annex", "add", path.join(src, "images"), "--json"]);
    console.log(`    add → candidates=${addReport.candidates} ok=${addReport.ok}`);
    check(addReport.candidates === 4, "add：候选只数图片（4 张：3 旧 + 1 新；a.thumbnail.png 被排除）");
    check(annexFind(src).includes("images/new.tif"), "add：未跟踪的新图进了 annex");
    check(indexMode(src, "images/new.tif") === "120000", "add：新图是 locked 软链（index 120000）");
    check(indexMode(src, "images/a.md") === "100644", "add：.md 仍由 git 管（index 100644，不进 annex）");

    // ── unlock ──
    const unlockReport = runCliJson(["annex", "unlock", path.join(src, "images"), "--json"]);
    console.log(`    unlock → ok=${unlockReport.ok}`);
    check(unlockReport.ok === 4, "unlock：4 张图都解锁了");
    check(
      ["images/a.tif", "images/b.tif", "images/sub/c.tif", "images/new.tif"].every(
        (file) => indexMode(src, file) === "100644" && !isSymlink(path.join(src, file)),
      ),
      "unlock：全部变成实文件（index 100644，Obsidian 能索引）",
    );
    check(annexFind(src).length === 4, "unlock：annex 仍然认这 4 张图（只是解锁，不是退出）");

    // ── lock ──
    const lockReport = runCliJson(["annex", "lock", path.join(src, "images"), "--json"]);
    console.log(`    lock → ok=${lockReport.ok}`);
    check(lockReport.ok === 4, "lock：4 张图都锁上了");
    check(indexMode(src, "images/a.tif") === "120000" && isSymlink(path.join(src, "images/a.tif")), "lock：a.tif 又变回软链");

    // ── drop（本地唯一副本的 new.tif 应被挡下）──
    const dropReport = runCliJson(["annex", "drop", path.join(src, "images"), "--json"]);
    console.log(`    drop → ok=${dropReport.ok} skipped=${dropReport.skipped} freed=${dropReport.bytesFreed}`);
    check(dropReport.ok === 3, "drop：别处有副本的 3 张丢了");
    check(dropReport.skipped === 1, "drop：本地唯一副本的新图被 annex 挡下");
    check(dropReport.bytesFreed === 3 * 200 * 1024, "drop：报出释放的字节数 = 3×200KB");
    check(
      annexFind(src, ["--in=here"]).join(",") === "images/new.tif",
      "drop：只有 new.tif 还有本地内容",
    );

    // ── get ──
    const getReport = runCliJson(["annex", "get", path.join(src, "images"), "--json"]);
    console.log(`    get → candidates=${getReport.candidates} ok=${getReport.ok}`);
    check(getReport.candidates === 3, "get：先数出本地缺内容 3 个");
    check(getReport.ok === 3, "get：3 个都取回");
    check(annexFind(src, ["--in=here"]).length === 4, "get：本地内容回到 4 个");

    // ── unannex ──
    const unannexReport = runCliJson(["annex", "unannex", path.join(src, "images"), "--json"]);
    console.log(`    unannex → ok=${unannexReport.ok} staged=${unannexReport.staged}`);
    check(unannexReport.ok === 4, "unannex：4 张图退出 annex");
    check(unannexReport.staged === 4, "unannex：4 张都补了 git add（--force-small）");
    check(annexFind(src).length === 0, "unannex：annex 不再认这些文件");
    check(
      fs.statSync(path.join(src, "images/a.tif")).size === 200 * 1024 && !isSymlink(path.join(src, "images/a.tif")),
      "unannex：内容留在工作树里（实文件，字节数不变）",
    );
    check(
      git(["diff", "--cached", "--name-only"], src).stdout.includes("images/a.tif"),
      "unannex：已暂存回索引（不会变成未跟踪文件）",
    );
    // 决定性一步：提交后 HEAD 里的 blob 必须是**原文件大小**。
    // 若用普通 `git add`，`.git/info/attributes` 的 `* filter=annex` 会把它重新 annex，
    // HEAD 里落的会是 ~100 字节的指针（实测过），unannex 就成了假动作。
    commit(src, "unannexed");
    // 用 `cat-file -s` 取**字节数**：`cat-file -p` 的 stdout 会被按 utf8 解码，
    // 二进制内容里多字节序列会塌缩，用 JS 字符串长度量会得到偏小的假数字（踩过）。
    const blobBytes = Number.parseInt(git(["cat-file", "-s", "HEAD:images/a.tif"], src).stdout.trim(), 10);
    console.log(`    提交后 HEAD:images/a.tif 的 blob = ${blobBytes} 字节`);
    check(blobBytes === 200 * 1024, "unannex：提交后 HEAD 里是完整文件（真进 git，不是 annex 指针）");
    check(git(["annex", "whereis", "images/a.tif"], src).stdout.trim() === "", "unannex：annex whereis 也为空（确实不再管它）");
  }

  // ══ 2. drop 的既有语义（预览 / 范围 / md 与缩略图不受影响）══════════════
  console.log("\n── drop 的既有语义 ──");
  {
    const images = ["sub/ses1/a.tif", "sub/ses1/b.tif", "sub/ses2/c.tif", "sub/ses2/only-here.tif", "outside/d.tif"];
    const { lab, src, clone } = makeRepo("drop", images, ["sub", "outside"]);
    cleanup.push(lab);
    git(
      ["annex", "copy", "--to", "clone", "--", "sub/ses1/a.tif", "sub/ses1/b.tif", "sub/ses2/c.tif", "outside/d.tif"],
      src,
    );
    const mdBefore = sha256(path.join(src, "sub/ses1/a.md"));
    const thumbBefore = sha256(path.join(src, "sub/ses1/a.thumbnail.png"));

    const dry = runCliJson(["drop", path.join(src, "sub"), "--dry-run", "--json"]);
    console.log(`    预览 → present=${dry.present} bytesPresent=${dry.bytesPresent} planned=${dry.planned}`);
    check(dry.present === 4, "预览只数 sub/ 下的 4 个 annex 文件（不含 outside/）");
    check(dry.planned === 4 && dry.dropped === 0, "预览阶段 dropped=0（一个字节都不动）");
    check(annexFind(src, ["--in=here"]).length === 5, "预览后本地内容数不变");

    const report = runCliJson(["drop", path.join(src, "sub"), "--json"]);
    console.log(`    真丢 → dropped=${report.dropped} skipped=${report.skipped} freed=${report.bytesFreed}`);
    check(report.dropped === 3, "别处有副本的 3 个被丢掉");
    check(report.skipped === 1, "本地唯一副本被 annex 挡下（skipped）");
    check(report.failed === 0, "没有硬失败");
    check(report.bytesFreed === 3 * 200 * 1024, `释放字节数 = 3×200KB（实测 ${report.bytesFreed}）`);
    check(annexFind(src, ["--in=here"]).join(",") === "outside/d.tif,sub/ses2/only-here.tif", "只剩被挡下的 + 子目录之外的两个");
    check(!fs.existsSync(path.join(src, "sub/ses1/a.tif")) && isSymlink(path.join(src, "sub/ses1/a.tif")), "丢掉的 locked 文件变成断软链");
    check(sha256(path.join(src, "sub/ses1/a.md")) === mdBefore, "sidecar .md 逐字节未动");
    check(sha256(path.join(src, "sub/ses1/a.thumbnail.png")) === thumbBefore, "缩略图 .thumbnail.png 逐字节未动");
  }

  // ══ 3. 插件路径：右键菜单 → 菜单项 → Notice，动作真落到盘上 ═════════════
  console.log("\n── 插件路径（桩 + 真 annex 仓）──");
  {
    const images = ["TEM/ses1/a.tif", "TEM/ses1/b.tif"];
    const { lab, src, clone } = makeRepo("plugin", images, ["TEM"]);
    cleanup.push(lab);
    git(["annex", "copy", "--to", "clone", "--", "TEM/ses1/a.tif", "TEM/ses1/b.tif"], src);
    const { stub, PluginClass } = loadPlugin(src);
    stub.registry.savedData = null;
    const plugin = new PluginClass(stub.makeApp(src), { id: "annex-gallery", version: "0.1.0" });
    await plugin.onload();

    const folderMenu = new stub.Menu();
    stub.registry.menus[0](folderMenu, new stub.TFolder("TEM"), "file-explorer");
    const items = folderMenu.items[0].submenu.items;
    const titles = items.map((item) => item.title);
    console.log(`    子菜单 ${titles.length} 项：${titles.join(" | ")}`);
    check(titles.length === 8, "插件注册了 8 个菜单项");
    check(
      titles.join("|") ===
        ["生成元数据", "生成缩略图", "Add largefiles to Annex", "Unlock & unannex largefiles", "Lock largefiles", "Unlock largefiles", "Get largefiles", "Drop largefiles"].join("|"),
      "顺序与用户口径逐项一致",
    );

    const unlockItem = items.find((item) => item.title === "Unlock largefiles");
    check(unlockItem !== undefined && typeof unlockItem.callback === "function", "找到「Unlock largefiles」菜单项");
    unlockItem.callback();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const unlockNotice = stub.registry.notices.filter((n) => typeof n === "string" && n.includes("Unlock largefiles")).pop() ?? "";
    console.log(`    「Unlock largefiles」→ ${unlockNotice.split("\n").join(" / ")}`);
    check(/Unlock largefiles 完成/.test(unlockNotice), "菜单项跑完给出完成报告");
    check(indexMode(src, "TEM/ses1/a.tif") === "100644", "盘上真的解锁了（index 100644）");

    const dropItem = items.find((item) => item.title === "Drop largefiles");
    const modalsBefore = stub.registry.modals.length;
    dropItem.callback();
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(stub.registry.modals.length === modalsBefore + 1, "「Drop largefiles」先开确认弹窗");
    const modal = stub.registry.modals[stub.registry.modals.length - 1];
    const texts = stub.walk(modal.contentEl).map((el) => el.textContent).join(" | ");
    check(/2 个 annex 文件在本地有内容/.test(texts), "弹窗写明本地有内容的文件数（2 个）");
    const confirmBtn = stub
      .walk(modal.contentEl)
      .filter((el) => el.tagName === "BUTTON" && el.textContent.includes("丢弃"))
      .pop();
    confirmBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const finalNotice = stub.registry.notices[stub.registry.notices.length - 1] ?? "";
    console.log(`    「Drop largefiles」→ ${finalNotice.split("\n").join(" / ")}`);
    check(/Drop largefiles 完成/.test(finalNotice), "点确认后给出完成报告");
    check(annexFind(src, ["--in=here"]).length === 0, "盘上确实丢了（git annex find --in=here 为空）");
  }

  // ══ 4. 非 git 仓库的目录：明确报错 ═════════════════════════════════════
  console.log("\n── 非 git 仓库的目录 ──");
  {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "annex-ops-notrepo-"));
    cleanup.push(notRepo);
    for (const args of [["annex", "add", notRepo], ["drop", notRepo]]) {
      const bad = runCliExpectError(args);
      console.log(`    ${args.join(" ")} → exit=${bad.status} ${bad.stderr.trim().split("\n")[0]}`);
      check(bad.status === 1, `${args[0]}：非 git 仓库退出码 1`);
      check(/不是 git 仓库/.test(bad.stderr), `${args[0]}：报错说清「不是 git 仓库」`);
    }
  }

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exitCode = 1;
  else console.log("VERIFY-ANNEX-OPS OK");

  // annex 的对象文件是只读的（mode 400/444），Node 的 rmSync 会半途 EACCES；先 chmod 再 rm -rf。
  for (const dir of cleanup) {
    sh("chmod", ["-R", "u+w", dir]);
    sh("rm", ["-rf", dir]);
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
