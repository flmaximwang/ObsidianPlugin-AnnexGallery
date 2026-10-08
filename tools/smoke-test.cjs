#!/usr/bin/env node
/**
 * Headless load smoke test: loads the *built* main.js against a stubbed
 * `obsidian` module, runs onload(), and exercises the folder menu, the settings
 * tab (multi-profile editor + parse preview) and the right-click prompt modal.
 *
 *   node tools/smoke-test.cjs [vaultPath]
 *
 * It answers "does the plugin load, render its UI and remember choices" without
 * a real Obsidian restart — i.e. it catches import errors, wrong API use, menu
 * wiring, and (T-008) profile edit / pick / ask persistence mistakes.
 */
const Module = require("module");
const path = require("path");

const stubPath = path.join(__dirname, "obsidian-stub.cjs");
const stub = require(stubPath);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};

const repo = path.resolve(__dirname, "..");
const vaultPath = process.argv[2] ?? "/tmp/annex-gallery-smoke-vault";
// Default = the real bundle. ANNEX_SMOKE_MAIN lets a caller point at an
// alternate build (used to exercise the "engine implemented" preview branch).
const mainJs = process.env.ANNEX_SMOKE_MAIN ?? path.join(repo, "main.js");
const PluginClass = require(mainJs).default;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const byClass = (root, cls) => stub.walk(root).filter((el) => el.hasClass(cls));

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

(async () => {
  const app = stub.makeApp(vaultPath);
  const plugin = new PluginClass(app, { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  console.log("onload() 完成");

  // ── 1. onload 注册：命令 / 设置页 / file-menu 处理器 ──────────────────────
  assert(stub.registry.commands.length === 1, `注册了 1 条命令：${stub.registry.commands.map((c) => `${c.id} / ${c.name}`).join(", ")}`);
  assert(stub.registry.tabs.length === 1, "注册了 1 个设置页");
  assert(stub.registry.menus.length === 1, "注册了 1 个 file-menu 处理器");

  const folder = new stub.TFolder("TEM/20261008-1495dd26-5705");
  const folderMenu = new stub.Menu();
  stub.registry.menus[0](folderMenu, folder, "file-explorer");
  const titles = folderMenu.items.map((item) => item.title);
  console.log(`右键文件夹 → ${titles.length} 项：${titles.join(" | ")}`);
  assert(titles.length === 2, "右键文件夹出现 2 个菜单项");
  assert(titles.some((t) => t.includes("生成缩略图")), "菜单项含「生成缩略图」");
  assert(titles.some((t) => t.includes("生成 metadata")), "菜单项含「使用 Annex Gallery 管理（生成 metadata）」");
  assert(folderMenu.items.every((item) => typeof item.callback === "function"), "两个菜单项都挂了回调");

  const fileMenu = new stub.Menu();
  stub.registry.menus[0](fileMenu, new stub.TFile("TEM/TEM 图库.md"), "file-explorer");
  assert(fileMenu.items.length === 0, "右键文件不出现任何菜单项（只对文件夹生效）");

  // ── 2. 设置页：profile 卡片渲染 ───────────────────────────────────────────
  const tab = stub.registry.tabs[0];
  tab.display();
  let cards = byClass(tab.containerEl, "annex-profile-card");
  console.log(`设置页渲染出 ${cards.length} 张 profile 卡片`);
  assert(cards.length === plugin.settings.profiles.length, `profile 卡片数 = settings.profiles.length（${plugin.settings.profiles.length}）`);
  assert(cards.length === 1, "内置默认渲染 1 张 profile 卡片（DEFAULT_PROFILES 只有 TECNAI）");
  assert(byClass(tab.containerEl, "annex-profile-json").length === cards.length, "每张卡片都带一个 JSON 编辑框（textarea）");
  assert(byClass(tab.containerEl, "annex-preview-filename").length === cards.length, "每张卡片都带一个解析预览输入框");

  // ── 3. 解析预览：12345X-5705-0015（引擎未实现 / 已实现，两种都算过）────────
  const fnameInput = byClass(tab.containerEl, "annex-preview-filename")[0];
  const runBtn = byClass(tab.containerEl, "annex-preview-run")[0];
  fnameInput.value = "12345X-5705-0015";
  fnameInput.dispatchEvent({ type: "input" });
  runBtn.click();
  const resultEl = byClass(tab.containerEl, "annex-preview-result")[0];
  const errEl = byClass(resultEl, "annex-preview-error")[0];
  if (errEl) {
    console.log(`  预览分支=引擎未实现：${errEl.textContent}`);
    assert(/解析暂不可用|还没实现|not implemented|未实现/.test(errEl.textContent), "引擎未实现时预览显示清楚的错误，不抛异常");
    assert(resultEl.getAttr("data-state") === "error", "预览结果状态 = error");
  } else {
    const rows = {};
    for (const row of byClass(resultEl, "annex-preview-row")) rows[row.getAttr("data-key")] = row;
    console.log(`  预览分支=引擎已实现：${Object.keys(rows).map((k) => `${k}=${JSON.stringify(rows[k].getAttr("data-value"))}`).join(", ")}`);
    assert(rows.magnification && rows.magnification.getAttr("data-value") === "12345", "预览 magnification=12345");
    assert(rows.index && rows.index.getAttr("data-value") === "15", "预览 index=15");
    const lensValue = rows.lens ? rows.lens.getAttr("data-value") : undefined;
    assert(rows.lens && (lensValue === "" || lensValue === '""' || rows.lens.hasClass("annex-preview-empty-value")), "预览 lens 为空（该可选组未参与匹配）");
    assert(resultEl.getAttr("data-state") === "ok", "预览结果状态 = ok");
  }

  // ── 3b. 预览的三种状态：没填 / 不命中 / 命中（不许把「没填」渲染成假结果表）──
  fnameInput.value = "";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "idle", "没填文件名时预览状态 = idle");
  assert(byClass(resultEl, "annex-preview-hint").length === 1, "没填文件名时给提示");
  assert(byClass(resultEl, "annex-preview-row").length === 0, "没填文件名时不渲染字段行（不假装解析过）");

  fnameInput.value = "randomname.png";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "nomatch", "名字不命中正则时预览状态 = nomatch");
  const nomatchEl = byClass(resultEl, "annex-preview-nomatch")[0];
  assert(nomatchEl !== undefined && /正则不命中/.test(nomatchEl.textContent), "不命中时显式写明「正则不命中」");

  fnameInput.value = "12345X-5705-0015.tif";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "ok", "名字命中时预览状态 = ok");

  // ── 3c. 有 error 的配置不许写盘（坏正则写进 data.json 会让右键弹窗崩）─────
  const jsonArea = byClass(tab.containerEl, "annex-profile-json")[0];
  const goodJson = jsonArea.value;
  jsonArea.value = JSON.stringify({ ...JSON.parse(goodJson), regex: "(" }, null, 2);
  jsonArea.dispatchEvent({ type: "input" });
  const savedBefore = JSON.stringify(stub.registry.savedData);
  byClass(tab.containerEl, "annex-profile-apply")[0].click();
  await tick();
  assert(JSON.stringify(stub.registry.savedData) === savedBefore, "坏正则时点「应用」不写盘");
  jsonArea.value = goodJson;
  jsonArea.dispatchEvent({ type: "input" });

  // ── 4. 设置页：新增 / 复制 / 删除 都落盘 ───────────────────────────────────
  byClass(tab.containerEl, "annex-profile-add")[0].click();
  await tick();
  await tick();
  cards = byClass(tab.containerEl, "annex-profile-card");
  assert(cards.length === 2, "点「新增」后设置页有 2 张卡片");
  assert(plugin.settings.profiles.length === 2 && stub.registry.savedData.profiles.length === 2, "新增的 profile 已写进 data.json");

  byClass(tab.containerEl, "annex-profile-dup")[1].click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 3, "点「复制」后 3 张卡片");
  assert(stub.registry.savedData.profiles.length === 3, "复制的 profile 已写进 data.json");

  byClass(tab.containerEl, "annex-profile-del")[2].click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 2, "点「删除」后回到 2 张卡片");
  assert(plugin.settings.profiles.length === 2, "删除已落盘（内存 + data.json 都是 2 条）");
  assert(plugin.settings.profiles.every((p) => typeof p.id === "string" && p.id.length > 0), "每条 profile 都有稳定 id");

  // ── 5. 右键弹窗：profile 下拉 + 按 ask 生成的输入框 + 落盘 ────────────────
  const metadataItem = folderMenu.items.find((item) => item.title.includes("生成 metadata"));
  metadataItem.callback();
  await tick();
  const modal = stub.registry.modals[stub.registry.modals.length - 1];
  assert(modal !== undefined, "点「生成 metadata」开了弹窗");
  assert(stub.registry.notices.length === 0, "弹窗打开时不报错");

  const selects = stub.walk(modal.contentEl).filter((el) => el.tagName === "SELECT");
  assert(selects.length === 1, "弹窗里有 1 个 profile 下拉");
  const options = stub.walk(selects[0]).filter((el) => el.tagName === "OPTION");
  console.log(`  下拉 ${options.length} 项：${options.map((o) => o.textContent).join(" | ")}`);
  assert(options.length === plugin.settings.profiles.length, `下拉列出全部 ${plugin.settings.profiles.length} 条 profile（带 name + id）`);
  assert(options.every((o) => /（[^）]+）$/.test(o.textContent)), "每个下拉项都带 id（name（id））");

  const askInputs = stub.walk(modal.contentEl).filter((el) => el.tagName === "INPUT" && (el.type === "text" || el.type === ""));
  assert(askInputs.length === 1, '内置 profile 的 ask=["sample"] ⇒ 恰好 1 个输入框');
  assert(askInputs[0].getAttr("data-ask-key") === "sample", "输入框对应 ask 键 sample");

  askInputs[0].value = "sample-A";
  askInputs[0].dispatchEvent({ type: "input" });
  const submitBtn = byClass(modal.contentEl, "setting-button").find((b) => b.textContent.includes("生成 metadata"));
  assert(submitBtn !== undefined, "弹窗有「生成 metadata」按钮");
  submitBtn.click();
  await tick();
  const dir = path.join(vaultPath, "TEM/20261008-1495dd26-5705");
  assert(plugin.settings.folderProfiles[dir] === plugin.settings.profiles[0].id, `选择落进 folderProfiles[目录] = ${plugin.settings.folderProfiles[dir]}`);
  assert(plugin.settings.folderSamples[dir] === "sample-A", "ask 值落进 folderSamples[目录] = sample-A");
  assert(stub.registry.savedData.folderProfiles[dir] === plugin.settings.profiles[0].id, "profile 选择已写进 data.json");

  // ── 6. 两 profile 的 data.json：写得进、读得回 ────────────────────────────
  const second = JSON.parse(JSON.stringify(plugin.settings.profiles[0]));
  second.id = "second-lens";
  second.name = "第二套（测试用）";
  plugin.settings.profiles = [plugin.settings.profiles[0], second];
  plugin.settings.folderProfiles["/tmp/other-folder"] = "second-lens";
  await plugin.saveSettings();

  const plugin2 = new PluginClass(stub.makeApp(vaultPath), { id: "annex-gallery", version: "0.1.0" });
  await plugin2.onload();
  assert(plugin2.settings.profiles.length === 2, "重开插件后读到 2 条 profile");
  assert(plugin2.settings.profiles.map((p) => p.id).join(",") === "tecnaitem,second-lens", "两条 profile 的 id 原样读回");
  assert(plugin2.settings.folderProfiles["/tmp/other-folder"] === "second-lens", "folderProfiles 读回正确");
  assert(plugin2.settings.folderSamples[dir] === "sample-A", "folderSamples 读回正确");

  console.log("\n--- data.json（桩环境内存里的落盘内容）---");
  console.log(JSON.stringify(stub.registry.savedData, null, 2));

  assert(plugin.vaultRoot() === vaultPath, `vaultRoot() = ${plugin.vaultRoot()}`);
  console.log(`\n断言全部通过 · NOTICES=${stub.registry.notices.length}`);
  console.log("SMOKE OK");
})().catch((error) => {
  console.error("\nSMOKE FAILED:", error);
  process.exit(1);
});
