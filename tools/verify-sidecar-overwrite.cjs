#!/usr/bin/env node
/**
 * 「生成元数据」重跑 + 「是否覆盖」提示的端到端校验（用户 2026-10-17 口径）。
 *
 * 在一个**临时 vault**（同时是 git 仓库）里造出：两张图 + 一张已存在的 sidecar，然后：
 *
 *   1. `--plan`          ：只读数出 images / existing / dirty，不写盘
 *   2. `--apply`         ：已存在且干净的**不重写**（skipped-existing），只为缺的图新建
 *   3. `--apply --overwrite`：已存在的**覆盖重算**（overwritten）
 *   4. 脏文件保护        ：手改过 sidecar 后，不带 --overwrite 时不动它（skipped-dirty）
 *   5. 插件路径          ：桩加载 main.js，走「右键 → 生成元数据 → 填字段 → 提交」，
 *                          断言弹出「覆盖重算 / 只补缺失 / 取消」，点「覆盖重算」后文件真的被重写
 *
 * 第 4 步同时是 `isDirty()` 那个修复的回归测试：临时目录在 macOS 的 `/var/…`（git 认 `/private/var/…`），
 * 老写法 `path.relative(repoRoot, target)` 会算出 `../../..` 让 `git status` 直接 fatal，
 * 于是「脏文件保护」静默失效 —— 那样第 4 步会看到文件被改写。
 *
 *   node tools/verify-sidecar-overwrite.cjs
 *
 * 需要 `git` 与 ImageMagick（`magick`）；缺 `magick` 时打印 SKIP 并以 0 退出。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const cli = path.join(repo, "tools", "annex-gallery.mjs");
const MARKER = "<!-- OLD-MARKER 这是手写的内容 -->\n";

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
function runCliJson(args) {
  const r = sh(process.execPath, [cli, ...args]);
  if (r.stdout.trim() === "") throw new Error(`CLI ${args.join(" ")} 没有输出（exit=${r.status}）\nstderr: ${r.stderr}`);
  if (r.status !== 0) throw new Error(`CLI ${args.join(" ")} 退出码 ${r.status}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const byClass = (stub, root, cls) => stub.walk(root).filter((el) => el.hasClass(cls));
const buttonsOf = (stub, root) => stub.walk(root).filter((el) => el.tagName === "BUTTON");

async function main() {
  if (sh("magick", ["-version"]).status !== 0 && sh("magick", ["--version"]).status !== 0) {
    console.log("SKIP：这台机器上没有 ImageMagick（`magick`），跳过。");
    return;
  }

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-overwrite-"));
  try {
    git(["init", "-q", "."], vault);
    for (const name of ["a.png", "b.png"]) {
      const made = sh("magick", ["-size", "32x32", "xc:red", path.join(vault, name)]);
      if (made.status !== 0) throw new Error(`magick 造图失败：${made.stderr}`);
    }
    fs.writeFileSync(path.join(vault, "a.md"), MARKER);
    git(["add", "-A"], vault);
    git(["-c", "user.email=v@local", "-c", "user.name=v", "commit", "-qm", "init"], vault);

    const args = (extra) => ["sidecar", vault, "--vault", vault, "--sample", "verify", ...extra, "--json"];
    console.log(`临时 vault ${vault}`);

    // ── 1. --plan：只读 ──────────────────────────────────────────────────
    const plan = runCliJson(args(["--plan"]));
    console.log(`    plan → images=${plan.images} existing=${plan.existing} dirty=${plan.dirty}`);
    check(plan.images === 2, "--plan 数出 2 张图");
    check(plan.existing === 1, "--plan 数出 1 份已存在的 sidecar");
    check(plan.dirty === 0, "--plan 数出 0 份被改过（a.md 已提交）");
    check(read(path.join(vault, "a.md")) === MARKER, "--plan 不写盘（a.md 原样）");
    check(!fs.existsSync(path.join(vault, "b.md")), "--plan 不写盘（b.md 仍未创建）");

    // ── 2. 默认（无 overwrite）：只补缺失 ────────────────────────────────
    const applied = runCliJson(args(["--apply"]));
    const counts = applied.entries.reduce((acc, entry) => ({ ...acc, [entry.action]: (acc[entry.action] ?? 0) + 1 }), {});
    console.log(`    --apply → ${JSON.stringify(counts)}`);
    check(read(path.join(vault, "a.md")).includes("OLD-MARKER"), "--apply 不动已存在的 a.md（skipped-existing）");
    check(fs.existsSync(path.join(vault, "b.md")), "--apply 为缺的图新建了 b.md");
    check(counts["skipped-existing"] === 1 && counts.created === 1, "报告口径：新建 1 份 · 跳过（已存在）1 份");

    // ── 3. --overwrite：覆盖重算（a.md 老的 + b.md 上一步刚建的，两份都重写）──
    const overwritten = runCliJson(args(["--apply", "--overwrite"]));
    const counts2 = overwritten.entries.reduce((acc, entry) => ({ ...acc, [entry.action]: (acc[entry.action] ?? 0) + 1 }), {});
    console.log(`    --apply --overwrite → ${JSON.stringify(counts2)}`);
    check(!read(path.join(vault, "a.md")).includes("OLD-MARKER"), "--overwrite 重写了 a.md（旧内容没了）");
    check(read(path.join(vault, "a.md")).startsWith("---"), "--overwrite 写出来的是正常 frontmatter");
    check(counts2.overwritten === 2, "报告口径：已存在的 2 份都被覆盖（overwritten=2）");

    // 先把两份 sidecar 提交成「干净」状态，下一步测脏文件保护才有分辨力。
    git(["add", "-A"], vault);
    git(["-c", "user.email=v@local", "-c", "user.name=v", "commit", "-qm", "sidecars"], vault);

    // ── 4. 脏文件保护（同时回归 isDirty 的 /private/var 修复）────────────
    fs.appendFileSync(path.join(vault, "a.md"), "\n手改一行\n");
    const dirtyPlan = runCliJson(args(["--plan"]));
    console.log(`    plan（手改后）→ dirty=${dirtyPlan.dirty}`);
    check(dirtyPlan.dirty === 1, "--plan 认出 1 份被改过的 sidecar（脏文件检测在 /var 路径下也有效）");
    const dirtyRun = runCliJson(args(["--apply"]));
    check(read(path.join(vault, "a.md")).includes("手改一行"), "不带 --overwrite 时脏文件被保护（没被覆盖）");
    check(
      dirtyRun.entries.some((entry) => entry.action === "skipped-dirty"),
      "报告里记成 skipped-dirty",
    );
    const dirtyOverwrite = runCliJson(args(["--apply", "--overwrite"]));
    check(!read(path.join(vault, "a.md")).includes("手改一行"), "--overwrite 连脏文件一起覆盖（用户要的「重算」）");
    check(
      dirtyOverwrite.entries.some((entry) => entry.action === "overwritten" && /脏/.test(entry.detail ?? "")),
      "报告里写明「覆盖已存在的 .md（git 报脏）」",
    );

    // ── 5. 插件路径：右键 → 生成元数据 → 提示是否覆盖 ────────────────────
    const { stub, PluginClass } = loadPlugin(vault);
    stub.registry.savedData = null;
    const plugin = new PluginClass(stub.makeApp(vault), { id: "annex-gallery", version: "0.1.0" });
    await plugin.onload();
    // 外部文件模型（spec-774d7ee）：设置里只登记路径，profile / metadata 模板都来自 vault 里的文件。
    fs.mkdirSync(path.join(vault, "Profiles"), { recursive: true });
    fs.mkdirSync(path.join(vault, "Templates"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, "Profiles", "verify.json"),
      JSON.stringify(
        {
          id: "verify",
          name: "验证用（a/b）",
          source: "stem",
          regex: "^(?<stem>[a-z])$",
          fields: [{ group: "stem", type: "text" }],
          ask: ["sample"],
          keyOrder: ["tags", "sample", "stem"],
          onMismatch: "empty",
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(vault, "Templates", "meta.md"), "{{frontmatter}}\n\n样本：{{sample}}\n缩略图：{{thumbnail}}\n");
    plugin.settings.profileFiles = [{ path: "Profiles/verify.json" }];
    plugin.settings.metadataTemplates = [{ id: "meta", name: "meta", path: "Templates/meta.md" }];
    await plugin.saveSettings();
    const folderMenu = new stub.Menu();
    stub.registry.menus[0](folderMenu, new stub.TFolder("/"), "file-explorer");
    const items = folderMenu.items[0].submenu.items;
    const metadataItem = items.find((item) => item.title === "生成元数据");
    check(metadataItem !== undefined, "找得到「生成元数据」菜单项");

    metadataItem.callback();
    await tick();
    const askModal = stub.registry.modals[stub.registry.modals.length - 1];
    const askInputs = stub.walk(askModal.contentEl).filter((el) => el.tagName === "INPUT" && el.getAttr("data-ask-key") === "sample");
    check(askInputs.length === 1, "先弹出「选配置 + 填字段」弹窗");

    askInputs[0].value = "rerun";
    askInputs[0].dispatchEvent({ type: "input" });
    buttonsOf(stub, askModal.contentEl).find((b) => b.textContent.includes("生成元数据")).click();
    await tick();
    await tick();
    const promptModal = stub.registry.modals[stub.registry.modals.length - 1];
    check(promptModal !== askModal, "提交后弹出第二个弹窗（问是否覆盖）");
    const promptText = stub.walk(promptModal.contentEl).map((el) => el.textContent).join(" | ");
    console.log(`    覆盖提示弹窗：${/已有 \d+ 份 sidecar[^|]*/.exec(promptText)?.[0] ?? "(没抓到)"}`);
    check(/已有 2 份 sidecar/.test(promptText), "提示里写明已有 2 份 sidecar");
    const labels = buttonsOf(stub, promptModal.contentEl).map((b) => b.textContent);
    check(
      labels.join("|") === "覆盖重算|只补缺失|取消",
      `三个按钮按口径排列：${labels.join(" | ")}`,
    );
    check(read(path.join(vault, "a.md")).startsWith("---"), "弹窗阶段还没写盘（等用户选）");

    // 选「只补缺失」→ 已存在的不动
    fs.writeFileSync(path.join(vault, "a.md"), MARKER);
    buttonsOf(stub, promptModal.contentEl).find((b) => b.textContent === "只补缺失").click();
    await tick();
    await tick();
    await tick();
    check(read(path.join(vault, "a.md")) === MARKER, "点「只补缺失」后 a.md 原样未动");
    const noticeKeep = stub.registry.notices[stub.registry.notices.length - 1] ?? "";
    console.log(`    只补缺失 → ${noticeKeep.split("\n").join(" / ")}`);
    check(/生成元数据完成/.test(noticeKeep), "给出完成报告");

    // 再走一遍，选「覆盖重算」→ 重写
    fs.writeFileSync(path.join(vault, "a.md"), MARKER);
    metadataItem.callback();
    await tick();
    const askModal2 = stub.registry.modals[stub.registry.modals.length - 1];
    const askInputs2 = stub.walk(askModal2.contentEl).filter((el) => el.tagName === "INPUT" && el.getAttr("data-ask-key") === "sample");
    askInputs2[0].value = "rerun";
    askInputs2[0].dispatchEvent({ type: "input" });
    buttonsOf(stub, askModal2.contentEl).find((b) => b.textContent.includes("生成元数据")).click();
    await tick();
    await tick();
    const promptModal2 = stub.registry.modals[stub.registry.modals.length - 1];
    const confirmBtn = buttonsOf(stub, promptModal2.contentEl).find((b) => b.textContent === "覆盖重算");
    check(confirmBtn !== undefined, "找到「覆盖重算」按钮");
    confirmBtn.click();
    await tick();
    await tick();
    await tick();
    const noticeOverwrite = stub.registry.notices[stub.registry.notices.length - 1] ?? "";
    console.log(`    覆盖重算 → ${noticeOverwrite.split("\n").join(" / ")}`);
    check(!read(path.join(vault, "a.md")).includes("OLD-MARKER"), "点「覆盖重算」后 a.md 真的被重写了");
    check(/覆盖 2 份/.test(noticeOverwrite), "报告里写「覆盖 2 份」（a.md + b.md 都已存在）");
    check(/模式：覆盖重算/.test(noticeOverwrite), "报告里标明本次是覆盖重算");

    console.log(`\nPASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    else console.log("VERIFY-SIDECAR-OVERWRITE OK");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
