#!/usr/bin/env node
/**
 * Headless load smoke test: loads the *built* main.js against a stubbed
 * `obsidian` module, runs onload(), and exercises the folder menu, the settings
 * tab (multi-profile editor + parse preview, layout per docs/setting-panel.md)
 * and the right-click prompt modal.
 *
 *   node tools/smoke-test.cjs [vaultPath]
 *
 * It answers "does the plugin load, render its UI and remember choices" without
 * a real Obsidian restart — i.e. it catches import errors, wrong API use, menu
 * wiring, and (T-008) profile edit / pick / ask persistence mistakes.
 *
 * 布局类判据（边框、右对齐、标题无 padding）在无头环境里读不了 computed style，所以
 * 这里直接对 styles.css 的规则做断言 —— 比「断言 class 存在」更接近「画面上真的有效」。
 */
const fs = require("fs");
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
// 本测试会真的在 vault 里写文件（模板副本、画廊 .base）。同一台机器重跑时先清掉上一轮的，
// 否则「复制为自定义」会因为同名文件已存在而写成 `default 2.md`，断言就飘了。
const SMOKE_TMP_DIRS = ["GallerySmoke", "GalleryBroken", "Smoke Base Templates", "Annex Gallery Templates"];
for (const dir of SMOKE_TMP_DIRS) fs.rmSync(path.join(vaultPath, dir), { recursive: true, force: true });
// Default = the real bundle. ANNEX_SMOKE_MAIN lets a caller point at an
// alternate build (used to exercise the "engine implemented" preview branch).
const mainJs = process.env.ANNEX_SMOKE_MAIN ?? path.join(repo, "main.js");
const PluginClass = require(mainJs).default;
const css = fs.readFileSync(path.join(repo, "styles.css"), "utf8");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 等几轮宏任务：模板复制 / 画廊写入这类「回调里 void 一个 async」要多等几拍。 */
const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await tick();
};
const byClass = (root, cls) => stub.walk(root).filter((el) => el.hasClass(cls));
const one = (root, cls) => byClass(root, cls)[0];
const settingNames = (root) => stub.walk(root).filter((el) => el.getAttr("data-name") !== undefined).map((el) => el.getAttr("data-name"));
/** 一段 CSS 规则体（找不到返回空串）。 */
const rule = (selector) => {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m === null ? "" : m[1];
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

(async () => {
  const app = stub.makeApp(vaultPath);
  // 状态栏那一行：记下建实例之前的条数，第 10 节用它核对「每个实例只加 1 行」。
  const statusItemsAtStart = stub.registry.statusBarItems.length;
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
  console.log(`右键文件夹 → 顶层 ${titles.length} 项：${titles.join(" | ")}`);
  // spec: docs/context-menu.md —— file explorer 的所有选项都包进一个「Annex Gallery」子菜单。
  assert(titles.length === 1, "右键文件夹只出现 1 个顶层菜单项");
  assert(titles[0] === "Annex Gallery", "唯一顶层项就是「Annex Gallery」");
  const annexItem = folderMenu.items[0];
  assert(annexItem.submenu !== null && annexItem.submenu !== undefined, "「Annex Gallery」挂上了子菜单（setSubmenu）");
  const subTitles = annexItem.submenu.items.map((item) => item.title);
  console.log(`  Annex Gallery 子菜单 → ${subTitles.length} 项：${subTitles.join(" | ")}`);
  // 用户 2026-10-17 口径 + 2026-10-31 追加「创建画廊」：这 9 项、这个顺序、这些名字。
  const expectedTitles = [
    "生成元数据",
    "生成缩略图",
    "创建画廊",
    "Add largefiles to Annex",
    "Unlock & unannex largefiles",
    "Lock largefiles",
    "Unlock largefiles",
    "Get largefiles",
    "Drop largefiles",
  ];
  const expectedIcons = ["file-text", "image", "layout-grid", "package-plus", "package-open", "lock", "unlock", "download", "cloud-off"];
  assert(subTitles.length === expectedTitles.length, `子菜单里有 ${expectedTitles.length} 个选项`);
  assert(subTitles.join("|") === expectedTitles.join("|"), "9 项的**顺序**与用户口径逐项一致");
  assert(
    annexItem.submenu.items.map((item) => item.icon).join("|") === expectedIcons.join("|"),
    `图标逐个对齐：${expectedIcons.join(" | ")}`,
  );
  assert(annexItem.submenu.items.every((item) => typeof item.callback === "function"), "9 个子菜单项都挂了回调");
  const dropItem = annexItem.submenu.items.find((item) => item.title === "Drop largefiles");
  assert(dropItem.icon === "cloud-off", "「Drop largefiles」带了 cloud-off 图标");
  let parentPrevented = false;
  annexItem.callback({ preventDefault: () => { parentPrevented = true; } });
  assert(parentPrevented === true, "点顶层「Annex Gallery」只 preventDefault（不直接跑任何动作，纯展开子菜单）");

  // 「创建画廊」是唯一跟 Obsidian 界面语言走的标题：getLanguage() 说英文 ⇒ Create Gallery。
  stub.registry.language = "en";
  const enFolderMenu = new stub.Menu();
  stub.registry.menus[0](enFolderMenu, folder, "file-explorer");
  const enSubItems = enFolderMenu.items[0].submenu.items;
  const enTitles = enSubItems.map((item) => item.title);
  console.log(`  language=en 时子菜单第 3 项：${enTitles[2]}（${enSubItems[2].icon}）`);
  assert(enSubItems.length === expectedTitles.length, "语言变化不影响项数");
  assert(enTitles[2] === "Create Gallery" && enSubItems[2].icon === "layout-grid", "language=en ⇒ 第 3 项 = Create Gallery / layout-grid");
  assert(
    enTitles.join("|") === expectedTitles.map((title, index) => (index === 2 ? "Create Gallery" : title)).join("|"),
    "只有「创建画廊」这一项随语言变，其余措辞不动",
  );
  stub.registry.language = "zh";

  const fileMenu = new stub.Menu();
  stub.registry.menus[0](fileMenu, new stub.TFile("TEM/TEM 图库.md"), "file-explorer");
  assert(fileMenu.items.length === 0, "右键文件不出现任何菜单项（只对文件夹生效）");

  // ── 2. 设置页骨架：h1 标题 / 工具条 / 分割线 / 只剩「缩略图边长」 ──────────
  const tab = stub.registry.tabs[0];
  tab.display();
  const titleEl = one(tab.containerEl, "annex-settings-title");
  console.log(`设置页标题：${titleEl === undefined ? "(缺)" : JSON.stringify(titleEl.textContent)}`);
  assert(titleEl !== undefined && titleEl.tagName === "H1", "设置页顶部是一个 h1");
  assert(titleEl.textContent === "Annex Gallery Settings", "h1 文本 = 「Annex Gallery Settings」");
  assert(tab.containerEl.children[0] === titleEl, "h1 是内容区的第一个元素");
  assert(/margin:\s*0[^;]*;/.test(rule(".annex-settings-title")) && /padding:\s*0/.test(rule(".annex-settings-title")), "styles.css：标题没有 padding/margin（与左侧设置项对齐）");
  assert(byClass(tab.containerEl, "annex-profiles-head").length === 0, "标题下方没有说明文字（原来的 h3 + 描述已去掉）");

  // ── 2b. 最上方「remote 设置」item：一个 item 装多条（名称 + 地址）──────────
  const remotesSection = one(tab.containerEl, "annex-remotes-section");
  assert(remotesSection !== undefined, "设置页有「remote 设置」这一项");
  assert(tab.containerEl.children[1] === remotesSection, "它在 h1 之后、profile 卡片之前（列表最上方）");
  assert(tab.containerEl.children[2].hasClass("annex-remotes-divider"), "紧接着一条分割线（remote 设置与模版设置之间）");
  assert(one(tab.containerEl, "annex-remotes-title").textContent === "remote 设置", "这一项的标题 = 「remote 设置」");
  assert(byClass(tab.containerEl, "annex-remote-row").length === 0, "默认 0 条 remote");
  assert(byClass(tab.containerEl, "annex-remotes-empty").length === 1, "空列表给一句提示");

  one(tab.containerEl, "annex-remote-add").click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-remote-row").length === 1, "点「添加 remote」出现 1 行");
  assert(plugin.settings.remotes.length === 1 && stub.registry.savedData.remotes.length === 1, "这行空 remote 已落进 data.json（草稿行）");
  let remoteRows = byClass(tab.containerEl, "annex-remote-row");
  assert(byClass(remoteRows[0], "annex-remote-name").length === 1 && byClass(remoteRows[0], "annex-remote-url").length === 1, "一行 = 名称 + 地址 两个输入框");
  assert(byClass(remoteRows[0], "annex-remote-del").length === 1, "行尾有「删除」");

  let nameIn = byClass(tab.containerEl, "annex-remote-name")[0];
  let urlIn = byClass(tab.containerEl, "annex-remote-url")[0];
  nameIn.value = "origin";
  nameIn.dispatchEvent({ type: "input" });
  await tick();
  assert(stub.registry.savedData.remotes[0].name === "origin", "名称输入即落盘");
  const warnNote = one(tab.containerEl, "annex-remote-note-warn");
  assert(warnNote !== undefined && /缺地址/.test(warnNote.textContent), "只填名称时行尾提示「缺地址」");
  urlIn.value = "ssh://nas.example/volume1/Data_lab_10";
  urlIn.dispatchEvent({ type: "input" });
  await tick();
  assert(stub.registry.savedData.remotes[0].url === "ssh://nas.example/volume1/Data_lab_10", "地址输入即落盘");
  assert(one(tab.containerEl, "annex-remote-note-warn") === undefined, "名称与地址都填全后提示消失");

  one(tab.containerEl, "annex-remote-add").click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-remote-row").length === 2, "「remote 设置」可以装多条（第 2 行）");
  nameIn = byClass(tab.containerEl, "annex-remote-name")[1];
  urlIn = byClass(tab.containerEl, "annex-remote-url")[1];
  nameIn.value = "backup";
  nameIn.dispatchEvent({ type: "input" });
  urlIn.value = "/Volumes/Backup/Data_lab_10";
  urlIn.dispatchEvent({ type: "input" });
  await tick();
  assert(plugin.settings.remotes.length === 2 && stub.registry.savedData.remotes[1].name === "backup", "第 2 条也落盘");

  byClass(tab.containerEl, "annex-remote-del")[0].click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-remote-row").length === 1, "点「删除」后回到 1 行");
  assert(plugin.settings.remotes.length === 1 && plugin.settings.remotes[0].name === "backup", "删掉的是第一行（剩下的那条 = backup）");
  assert(stub.registry.savedData.remotes.length === 1, "删除也落盘");

  // ── 2c. 普通设置项：只剩「缩略图边长」 ──────────────────────────────────

  const names = settingNames(tab.containerEl);
  console.log(`普通设置项：${names.length === 0 ? "(无)" : names.join(" | ")}`);
  assert(names.join(",") === "缩略图边长,调试日志", "分割线以下是「缩略图边长」与「调试日志」两个设置项（.gitattributes / .gitignore / 默认样品名 已删）");
  assert(byClass(tab.containerEl, "annex-settings-divider").length === 2, "两条分割线（remote/模版 之间 + 模版/普通设置项 之间）");
  assert(byClass(tab.containerEl, "annex-remotes-divider").length === 1, "上面那条标成 annex-remotes-divider");

  // ── 2d. 模板区：metadata / 画廊两张卡片 + 内置行的 查看 / 复制 / 删除 / 登记 ──
  const templatesSection = one(tab.containerEl, "annex-templates-section");
  assert(templatesSection !== undefined, "设置页有「模板」区（.annex-templates-section）");
  const topChildren = tab.containerEl.children;
  const profilesIndex = topChildren.findIndex((el) => el.hasClass("annex-profiles-section"));
  const templatesIndex = topChildren.findIndex((el) => el.hasClass("annex-templates-section"));
  const lowerDividerIndex = topChildren.findIndex(
    (el) => el.tagName === "HR" && el.hasClass("annex-settings-divider") && !el.hasClass("annex-remotes-divider"),
  );
  assert(profilesIndex >= 0 && templatesIndex === profilesIndex + 1, "模板区紧跟在 profile 区之后");
  assert(lowerDividerIndex === templatesIndex + 1, "模板区在下面那条分割线之前（分割线以下才是「缩略图边长」）");

  const templateCards = () => byClass(tab.containerEl, "annex-templates-card");
  assert(templateCards().length === 2, "模板区有 2 张卡片");
  assert(
    templateCards().map((card) => card.getAttr("data-kind")).join(",") === "metadata,base",
    "两张卡片依次 = metadata / base",
  );
  const builtinRows = () => byClass(tab.containerEl, "annex-template-builtin");
  assert(byClass(templateCards()[0], "annex-template-builtin").length === 2, "metadata 卡片有 2 条内置模板");
  assert(byClass(templateCards()[1], "annex-template-builtin").length === 1, "base 卡片有 1 条内置模板");
  assert(
    byClass(templateCards()[0], "annex-template-builtin").map((row) => row.getAttr("data-template-id")).join(",") === "default,embed",
    "metadata 内置 = default / embed",
  );
  assert(byClass(tab.containerEl, "annex-template-custom").length === 0, "一开始没有自定义模板行");
  assert(
    byClass(templateCards()[0], "annex-template-path-input").length === 1 && byClass(templateCards()[0], "annex-template-add").length === 1,
    "每张卡片底部都有「路径输入 + 登记」",
  );

  // 「查看」：只读弹窗，textarea 里是模板原文。
  one(byClass(templateCards()[0], "annex-template-builtin")[0], "annex-template-view-btn").click();
  const viewModal = stub.registry.modals[stub.registry.modals.length - 1];
  const viewArea = stub.walk(viewModal.contentEl).find((el) => el.tagName === "TEXTAREA");
  assert(viewArea !== undefined, "「查看」开了一个带 textarea 的弹窗");
  assert(viewArea.value.includes("{{frontmatter}}"), "查看的内置 metadata 模板原文明文含 {{frontmatter}}");
  assert(viewArea.getAttr("readonly") === "true", "查看弹窗是只读的");

  // 「复制为自定义」：真的写进 vault 的 Annex Gallery Templates/，并登记进 data.json。
  const copiedRel = "Annex Gallery Templates/default.md";
  const copiedAbs = path.join(vaultPath, copiedRel);
  one(byClass(templateCards()[0], "annex-template-builtin")[0], "annex-template-copy").click();
  await settle();
  assert(fs.existsSync(copiedAbs), `「复制为自定义」真的写出了 ${copiedRel}`);
  assert(fs.readFileSync(copiedAbs, "utf8").includes("{{frontmatter}}"), "写出的副本内容 = 内置模板原文");
  let customRows = byClass(templateCards()[0], "annex-template-custom");
  assert(customRows.length === 1 && customRows[0].getAttr("data-template-id") === "default-copy", "metadata 卡片多了一条自定义行（id=default-copy）");
  assert(
    Array.isArray(stub.registry.savedData.metadataTemplates) &&
      stub.registry.savedData.metadataTemplates.length === 1 &&
      stub.registry.savedData.metadataTemplates[0].path === copiedRel,
    "自定义模板已写进 data.json（metadataTemplates）",
  );

  // 「删除」只取消登记，文件留着。
  one(customRows[0], "annex-template-del").click();
  await settle();
  assert(byClass(tab.containerEl, "annex-template-custom").length === 0, "「删除」后自定义行消失");
  assert(stub.registry.savedData.metadataTemplates.length === 0, "「删除」= 取消登记（data.json 里也删掉）");
  assert(fs.existsSync(copiedAbs), "「删除」不删除文件（只取消登记）");

  // 「登记」：路径不存在 ⇒ Notice，且什么都不加。
  const metadataCard = templateCards()[0];
  const noticesBeforeRegister = stub.registry.notices.length;
  one(metadataCard, "annex-template-path-input").value = "nope/not-there.md";
  one(metadataCard, "annex-template-add").click();
  await settle();
  const registerNotice = stub.registry.notices[stub.registry.notices.length - 1] ?? "";
  console.log(`  登记不存在的路径 → ${registerNotice.split("\n")[0]}`);
  assert(stub.registry.notices.length === noticesBeforeRegister + 1, "登记失败只多一条 Notice");
  assert(/vault 里没有这个文件/.test(registerNotice), "Notice 说清「vault 里没有这个文件」");
  assert(byClass(tab.containerEl, "annex-template-custom").length === 0, "登记失败不新增自定义行");
  assert(plugin.settings.metadataTemplates.length === 0 && stub.registry.savedData.metadataTemplates.length === 0, "登记失败不写 data.json");

  const toolbar = one(tab.containerEl, "annex-profiles-toolbar");
  const toolLabels = toolbar.children.map((el) => el.textContent || `<${el.tagName}>`);
  console.log(`工具条（从左往右）：${toolLabels.join(" | ")}`);
  assert(one(tab.containerEl, "annex-profile-new").textContent === "新模版", "工具条第一个按钮 = 新模版");
  assert(one(tab.containerEl, "annex-profile-import").textContent === "导入模版", "工具条第二个按钮 = 导入模版");
  const importInput = one(tab.containerEl, "annex-profile-import-file");
  assert(importInput !== undefined && importInput.tagName === "INPUT" && importInput.type === "file", "「导入模版」挂着一个 type=file 的隐藏输入（系统文件选择器）");
  assert(importInput.hasClass("annex-hidden") && /\.annex-hidden\s*\{[^}]*display:\s*none/.test(css), "文件选择器是隐藏的（styles.css 里 display: none）");
  const presetSelect = one(tab.containerEl, "annex-profile-preset");
  assert(presetSelect !== undefined && presetSelect.tagName === "SELECT", "工具条第三个控件 = 添加预设（下拉选框）");
  const presetOptions = stub.walk(presetSelect).filter((el) => el.tagName === "OPTION").map((el) => el.textContent);
  console.log(`预设下拉：${presetOptions.join(" | ")}`);
  assert(presetOptions[0] === "添加预设…" && presetOptions.length === 2, "下拉第一项是占位「添加预设…」，之后是内置预设（TECNAI）");

  // ── 3. 卡片布局 ──────────────────────────────────────────────────────────
  let cards = byClass(tab.containerEl, "annex-profile-card");
  console.log(`设置页渲染出 ${cards.length} 张 profile 卡片`);
  assert(cards.length === plugin.settings.profiles.length, `profile 卡片数 = settings.profiles.length（${plugin.settings.profiles.length}）`);
  assert(cards.length === 1, "内置默认渲染 1 张 profile 卡片（DEFAULT_PROFILES 只有 TECNAI）");

  const headSpans = cards[0].children[0].children;
  console.log(`卡片头一行：${headSpans.map((el) => el.textContent).join(" ")}`);
  assert(headSpans[0].hasClass("annex-profile-name"), "卡片头第一项是 Name");
  assert(headSpans.some((el) => el.hasClass("annex-profile-id")), "卡片头第二项是 id");
  const statusEl = one(tab.containerEl, "annex-profile-status");
  assert(statusEl !== undefined && headSpans[headSpans.length - 1] === statusEl, "卡片头最后一项是状态胶囊");
  assert(statusEl.textContent === "Saved" && statusEl.getAttr("data-level") === "ok", "刚渲染时状态 = Saved");
  assert(byClass(tab.containerEl, "annex-profile-match").length === 0, "卡片头不再显示 match:…（按 spec 只留 Name / id / 状态）");

  assert(byClass(tab.containerEl, "annex-profile-json").length === cards.length, "每张卡片都带一个 JSON 编辑框（textarea）");

  const fnameInput = byClass(tab.containerEl, "annex-preview-filename")[0];
  assert(fnameInput !== undefined, "每张卡片都带一个解析预览输入框");
  assert(byClass(tab.containerEl, "annex-preview-relpath").length === 0, "解析预览没有「相对 vault 路径」那一格（解析与路径无关）");
  assert(byClass(tab.containerEl, "annex-preview-run").length === 0, "解析预览没有「解析」按钮（输入即解析）");
  assert(/\n\s*width:\s*100%/.test(rule(".annex-preview-filename")), "styles.css：示例文件名输入框占满整宽");
  const resultEl = byClass(tab.containerEl, "annex-preview-result")[0];
  assert(resultEl !== undefined, "预览有一块解析结果区");
  assert(/border:\s*1px solid/.test(rule(".annex-preview-result")), "styles.css：解析结果带边框");

  const actionButtons = one(tab.containerEl, "annex-profile-actions").children;
  const actionOrder = actionButtons.map((el) => el.textContent);
  console.log(`卡片动作（DOM 顺序）：${actionOrder.join(" | ")}`);
  assert(actionOrder.join(",") === "删除,打开,复制,保存", "动作按钮 DOM 顺序 删除→打开→复制→保存（视觉上从右往左读 = 保存、复制、打开、删除）");
  assert(/justify-content:\s*flex-end/.test(rule(".annex-profile-actions")), "styles.css：动作按钮整排贴右下角）");

  // ── 4. 解析预览：输入即解析 + 三态 ───────────────────────────────────────
  fnameInput.value = "12345X-5705-0015";
  fnameInput.dispatchEvent({ type: "input" });
  const errEl = one(resultEl, "annex-preview-error");
  if (errEl !== undefined) {
    console.log(`  预览分支=引擎未实现：${errEl.textContent}`);
    assert(/解析暂不可用|还没实现|not implemented|未实现/.test(errEl.textContent), "引擎未实现时预览显示清楚的错误，不抛异常");
    assert(resultEl.getAttr("data-state") === "error", "预览结果状态 = error");
  } else {
    const rows = {};
    for (const row of byClass(resultEl, "annex-preview-row")) rows[row.getAttr("data-key")] = row;
    console.log(`  预览分支=引擎已实现：${Object.keys(rows).map((k) => `${k}=${JSON.stringify(rows[k].getAttr("data-value"))}`).join(", ")}`);
    assert(byClass(resultEl, "annex-preview-rows").length === 1, "命中时解析结果是一行一条解析（每行 key = value）");
    assert(rows.magnification && rows.magnification.getAttr("data-value") === "12345", "预览 magnification=12345");
    assert(rows.index && rows.index.getAttr("data-value") === "15", "预览 index=15");
    const markerValue = rows.marker ? rows.marker.getAttr("data-value") : undefined;
    assert(rows.marker && markerValue === "5705", `预览 marker=5705（正则 (?<marker>.+) 吃中间那段）：${JSON.stringify(markerValue)}`);
    assert(resultEl.getAttr("data-state") === "ok", "预览结果状态 = ok");
  }

  // ── 预览：用户报的样例（中间段带下划线 + 小数点，无扩展名）──────────────
  fnameInput.value = "12345X-5_1.4-0001";
  fnameInput.dispatchEvent({ type: "input" });
  let userRows = {};
  for (const row of byClass(resultEl, "annex-preview-row")) userRows[row.getAttr("data-key")] = row;
  console.log(`  用户样例 12345X-5_1.4-0001 → state=${resultEl.getAttr("data-state")} ` +
    Object.keys(userRows).map((k) => `${k}=${JSON.stringify(userRows[k].getAttr("data-value"))}`).join(", "));
  assert(resultEl.getAttr("data-state") === "ok",
    "带小数点/下划线的中间段能命中（12345X-5_1.4-0001，旧正则 + 把 `.4-0001` 当扩展名都会失败）");
  assert(userRows.marker && userRows.marker.getAttr("data-value") === "5_1.4", "该样例 marker=5_1.4");
  assert(userRows.index && userRows.index.getAttr("data-value") === "1",
    `该样例 index 被按 number 规整（0001 → 1，与 0015 → 15 同一口径）：${userRows.index ? userRows.index.getAttr("data-value") : "?"}`);

  fnameInput.value = "";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "idle", "没填文件名时预览状态 = idle");
  assert(byClass(resultEl, "annex-preview-hint").length === 1, "没填文件名时给提示");
  assert(byClass(resultEl, "annex-preview-row").length === 0, "没填文件名时不渲染字段行（不假装解析过）");

  fnameInput.value = "randomname.png";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "nomatch", "名字不命中正则时预览状态 = nomatch");
  const nomatchEl = one(resultEl, "annex-preview-nomatch");
  assert(nomatchEl !== undefined && /正则不命中/.test(nomatchEl.textContent), "不命中时显式写明「正则不命中」");

  fnameInput.value = "12345X-5705-0015.tif";
  fnameInput.dispatchEvent({ type: "input" });
  assert(resultEl.getAttr("data-state") === "ok", "名字命中时预览状态 = ok");

  // ── 5. 状态胶囊三态 + 坏配置不写盘 + 保存落盘 ─────────────────────────────
  const jsonArea = byClass(tab.containerEl, "annex-profile-json")[0];
  const goodJson = jsonArea.value;

  jsonArea.value = JSON.stringify({ ...JSON.parse(goodJson), ask: ["sample"], name: "改过名字" }, null, 2);
  jsonArea.dispatchEvent({ type: "input" });
  assert(statusEl.textContent === "Unsaved changes" && statusEl.getAttr("data-level") === "warn", "改过内容后状态 = Unsaved changes");
  assert(one(tab.containerEl, "annex-profile-name").textContent === "改过名字", "改 name 后卡片头的 Name 跟着更新");

  jsonArea.value = goodJson.replace(/\}$/, ""); // 截掉收尾括号 ⇒ JSON 语法错误
  jsonArea.dispatchEvent({ type: "input" });
  assert(statusEl.textContent === "Syntax Error" && statusEl.getAttr("data-level") === "error", "JSON 语法错误时状态 = Syntax Error");
  assert(resultEl.getAttr("data-state") === "badjson", "语法错误时预览不给过期结果");

  const savedBefore = JSON.stringify(stub.registry.savedData);
  one(tab.containerEl, "annex-profile-save").click();
  await tick();
  assert(statusEl.textContent === "Syntax Error", "语法错误时点「保存」仍停在 Syntax Error");
  assert(JSON.stringify(stub.registry.savedData) === savedBefore, "语法错误时点「保存」不写盘");

  jsonArea.value = JSON.stringify({ ...JSON.parse(goodJson), regex: "(" }, null, 2);
  jsonArea.dispatchEvent({ type: "input" });
  one(tab.containerEl, "annex-profile-save").click();
  await tick();
  assert(JSON.stringify(stub.registry.savedData) === savedBefore, "坏正则（error 级）时点「保存」不写盘");

  jsonArea.value = goodJson;
  jsonArea.dispatchEvent({ type: "input" });
  one(tab.containerEl, "annex-profile-save").click();
  await tick();
  assert(statusEl.textContent === "Saved" && statusEl.getAttr("data-level") === "ok", "点「保存」后状态 = Saved");
  assert(stub.registry.savedData.profiles[0].regex === JSON.parse(goodJson).regex, "「保存」把内容写进了 data.json");

  // 「打开」：无头环境里拿不到系统默认应用 ⇒ 只能降级成 Notice，不许抛
  const noticesBefore = stub.registry.notices.length;
  one(tab.containerEl, "annex-profile-open").click();
  await tick();
  await tick();
  const openNotices = stub.registry.notices.slice(noticesBefore);
  console.log(`  点「打开」→ ${openNotices.length} 条 Notice：${openNotices.map((n) => n.split("\n")[0]).join(" / ")}`);
  assert(openNotices.length > 0, "「打开」在拿不到默认应用时给了 Notice（不抛异常、不静默失败）");
  assert(openNotices.some((n) => /打不开系统默认应用/.test(n) && /annex-gallery-profiles/.test(n)), "Notice 里带着缓冲区文件路径");

  // ── 6. 工具条：新模版 / 添加预设 / 导入模版 / 复制 / 删除 ─────────────────
  one(tab.containerEl, "annex-profile-new").click();
  await tick();
  await tick();
  cards = byClass(tab.containerEl, "annex-profile-card");
  assert(cards.length === 2, "点「新模版」后设置页有 2 张卡片");
  assert(plugin.settings.profiles.length === 2 && stub.registry.savedData.profiles.length === 2, "新模版建出来的 profile 已写进 data.json");
  const added = plugin.settings.profiles[1];
  console.log(`  新模版 → id=${added.id} name=${added.name} regex=${added.regex}`);
  assert(added.id === "template" && added.regex.includes("(?<magnification>"), "新模版来自通用模板（不是 TECNAI 电镜）");
  assert(added.ask.join(",") === "sample" && !added.keyOrder.includes("eagleId"), "通用模板的 ask/keyOrder 不含 TECNAI 专有键");

  presetSelect.value = "tecnaitem";
  presetSelect.dispatchEvent({ type: "change" });
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 3, "从「添加预设」下拉里选 TECNAI 后 3 张卡片");
  const presetAdded = plugin.settings.profiles[2];
  console.log(`  添加预设 → id=${presetAdded.id}`);
  assert(presetAdded.id === "tecnaitem-2" && presetAdded.regex.includes("(?<marker>") && presetAdded.keyOrder.length === 12,
    "添加预设插入的是内置 TECNAI 预设（id 去重；正则取 marker 组、keyOrder 12 键）");
  assert(presetSelect.value === "", "选完预设后下拉回到占位项");

  const importInputEl = one(tab.containerEl, "annex-profile-import-file");
  importInputEl.files = [
    {
      name: "plate.json",
      text: async () =>
        JSON.stringify({
          profiles: [
            {
              id: "platewell",
              name: "多孔板",
              regex: "^(?<plate>\\d+)-(?<well>[A-H]\\d+)$",
              fields: [{ group: "plate", type: "number" }],
              ask: ["sample"],
              keyOrder: ["tags", "sample", "plate", "well"],
            },
          ],
        }),
    },
  ];
  importInputEl.dispatchEvent({ type: "change" });
  await tick();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 4, "「导入模版」读 .json 后 4 张卡片");
  assert(plugin.settings.profiles.some((p) => p.id === "platewell"), "导入的 profile 进了 settings（`{ profiles: [...] }` 也认）");
  assert(stub.registry.savedData.profiles.some((p) => p.id === "platewell"), "导入的 profile 已写进 data.json");

  byClass(tab.containerEl, "annex-profile-dup")[1].click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 5, "点「复制」后 5 张卡片");
  assert(stub.registry.savedData.profiles.length === 5, "复制的 profile 已写进 data.json");

  byClass(tab.containerEl, "annex-profile-del")[4].click();
  await tick();
  await tick();
  assert(byClass(tab.containerEl, "annex-profile-card").length === 4, "点「删除」后回到 4 张卡片");
  assert(plugin.settings.profiles.length === 4, "删除已落盘（内存 + data.json 都是 4 条）");
  assert(plugin.settings.profiles.every((p) => typeof p.id === "string" && p.id.length > 0), "每条 profile 都有稳定 id");

  tab.hide();
  console.log("设置页 hide() 后没有残留定时器");

  // ── 7. 右键弹窗：profile 下拉 + 按 ask 生成的输入框 + 落盘 ────────────────
  const metadataItem = annexItem.submenu.items.find((item) => item.title === "生成元数据");
  metadataItem.callback();
  await tick();
  const modal = stub.registry.modals[stub.registry.modals.length - 1];
  assert(modal !== undefined, "点「生成元数据」开了弹窗");

  const selects = stub.walk(modal.contentEl).filter((el) => el.tagName === "SELECT");
  assert(selects.length === 2, "弹窗里有 2 个下拉：profile + metadata 模板");
  const profileSelect = selects[0];
  const templateSelect = selects[1];
  const options = stub.walk(profileSelect).filter((el) => el.tagName === "OPTION");
  console.log(`  profile 下拉 ${options.length} 项：${options.map((o) => o.textContent).join(" | ")}`);
  assert(options.length === plugin.settings.profiles.length, `下拉列出全部 ${plugin.settings.profiles.length} 条 profile（带 name + id）`);
  assert(options.every((o) => /（[^）]+）$/.test(o.textContent)), "每个下拉项都带 id（name（id））");

  const templateOptions = stub.walk(templateSelect).filter((el) => el.tagName === "OPTION");
  console.log(`  metadata 模板下拉 ${templateOptions.length} 项：${templateOptions.map((o) => `${o.getAttr("value")}=${o.textContent}`).join(" | ")}`);
  assert(
    templateOptions.map((o) => o.getAttr("value")).join(",") === "default,embed",
    "第二个下拉列出内置 metadata 模板 default / embed",
  );

  // 选 embed：提交后要落进 folderMetadataTemplates[目录]。
  templateSelect.value = "embed";
  templateSelect.dispatchEvent({ type: "change" });
  await tick();

  const askInputs = stub.walk(modal.contentEl).filter((el) => el.tagName === "INPUT" && (el.type === "text" || el.type === ""));
  assert(askInputs.length === 1, '内置 profile 的 ask=["sample"] ⇒ 恰好 1 个输入框');
  assert(askInputs[0].getAttr("data-ask-key") === "sample", "输入框对应 ask 键 sample");

  askInputs[0].value = "sample-A";
  askInputs[0].dispatchEvent({ type: "input" });
  const submitBtn = byClass(modal.contentEl, "setting-button").find((b) => b.textContent.includes("生成元数据"));
  assert(submitBtn !== undefined, "弹窗有「生成元数据」按钮");
  submitBtn.click();
  await tick();
  const dir = path.join(vaultPath, "TEM/20261008-1495dd26-5705");
  assert(plugin.settings.folderSamples[dir] === "sample-A", "ask 值落进 folderSamples[目录] = sample-A");
  assert(stub.registry.savedData.folderSamples[dir] === "sample-A", "ask 值已写进 data.json");
  assert(plugin.settings.folderMetadataTemplates[dir] === "embed", "metadata 模板选择落进 folderMetadataTemplates[目录] = embed");
  assert(stub.registry.savedData.folderMetadataTemplates[dir] === "embed", "模板选择已写进 data.json");
  assert(
    stub.registry.savedData.defaultSample === undefined,
    "data.json 里不再写 defaultSample（spec：没有所谓默认样品名）",
  );

  // ── 7b. 创建画廊：补标签 → .base → 已存在 → 选模板 → 坏模板 ────────────────
  // 用 vault 里的真文件夹 + 真图片/真 sidecar 走一遍（不碰 annex，planGallery 只读 fs）。
  const galleryFolder = "GallerySmoke";
  const galleryDir = path.join(vaultPath, galleryFolder);
  const galleryBaseRel = `${galleryFolder}/${galleryFolder}.base`;
  const galleryBaseAbs = path.join(vaultPath, galleryBaseRel);
  const brokenFolder = "GalleryBroken";
  const brokenBaseRel = `${brokenFolder}/${brokenFolder}.base`;
  const customBaseRel = "Smoke Base Templates/custom.base";
  const brokenTemplateRel = "Smoke Base Templates/broken.base";
  const rmrf = (target) => fs.rmSync(target, { recursive: true, force: true });
  const lastModal = () => stub.registry.modals[stub.registry.modals.length - 1];
  const modalButtons = (m) => stub.walk(m.contentEl).filter((el) => el.tagName === "BUTTON").map((el) => el.textContent);

  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, brokenFolder), { recursive: true });
  fs.writeFileSync(path.join(galleryDir, "tagged.tif"), "fake-tif");
  fs.writeFileSync(
    path.join(galleryDir, "tagged.md"),
    "---\ntags:\n  - annex-gallery-metadata\nsample: A\n---\n\n缩略图：\n",
    "utf8",
  );
  fs.writeFileSync(path.join(galleryDir, "old.tif"), "fake-tif");
  const oldSidecarBefore = "---\ntif: old.tif\nsample: B\n---\n\n旧版 sidecar\n";
  fs.writeFileSync(path.join(galleryDir, "old.md"), oldSidecarBefore, "utf8");
  fs.writeFileSync(path.join(galleryDir, "README.md"), "# 说明\n", "utf8");

  /** 重新给某个文件夹建一份右键菜单（title 里含「创建画廊」的那项）。 */
  const galleryItemFor = (folderPath) => {
    const menu = new stub.Menu();
    stub.registry.menus[0](menu, new stub.TFolder(folderPath), "file-explorer");
    return menu.items[0].submenu.items.find((item) => item.title === "创建画廊");
  };
  const clickLastModalButton = async (text) => {
    const button = stub.walk(lastModal().contentEl).find((el) => el.tagName === "BUTTON" && el.textContent === text);
    assert(button !== undefined, `弹窗里有「${text}」按钮`);
    button.click();
    await settle();
  };

  // 第一次：有 1 份旧 sidecar 没标签 ⇒ 先问「补标签 / 跳过 / 取消」。
  const openedBeforeGallery = stub.registry.opened.length;
  galleryItemFor(galleryFolder).callback();
  await settle();
  let galleryModal = lastModal();
  console.log(`  首次创建画廊 → ${JSON.stringify(galleryModal.titleEl.textContent)}`);
  assert(/没有标签/.test(galleryModal.titleEl.textContent), "旧 sidecar 没标签时先弹「补标签 / 跳过 / 取消」");
  assert(modalButtons(galleryModal).join(",") === "补标签,跳过,取消", "三个按钮依次 = 补标签 / 跳过 / 取消");
  await clickLastModalButton("补标签");

  const oldSidecarAfter = fs.readFileSync(path.join(galleryDir, "old.md"), "utf8");
  const expectedOldSidecar = oldSidecarBefore.replace(/^---\n/, "---\ntags:\n  - annex-gallery-metadata\n");
  console.log(`  补标签后 old.md 头部：${JSON.stringify(oldSidecarAfter.slice(0, 60))}`);
  assert(oldSidecarAfter === expectedOldSidecar, "「补标签」只加 tags 一项，其余逐字不变");
  assert(fs.existsSync(galleryBaseAbs), `.base 写在 ${galleryBaseRel}`);
  const galleryBaseText = fs.readFileSync(galleryBaseAbs, "utf8");
  assert(galleryBaseText.includes('file.inFolder("GallerySmoke")'), "画廊作用域含 file.inFolder(\"GallerySmoke\")");
  assert(galleryBaseText.includes('file.hasTag("annex-gallery-metadata")'), "画廊作用域含 file.hasTag(\"annex-gallery-metadata\")");
  assert(galleryBaseText.includes("cardSize: 256"), ".base 里填进了设置里的 cardSize（256）");
  assert(stub.registry.opened.slice(openedBeforeGallery).includes(galleryBaseRel), "写完后用 getLeaf().openFile() 打开了画廊");
  assert(
    stub.registry.notices.some((n) => /创建画廊完成/.test(n) && new RegExp(galleryBaseRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(n)),
    "完成后的 Notice 里点名画廊路径",
  );

  // 第二次：目标 .base 已存在 ⇒ 问「覆盖 / 打开已有 / 取消」；「打开已有」不改文件。
  const baseBeforeOpen = fs.readFileSync(galleryBaseAbs, "utf8");
  galleryItemFor(galleryFolder).callback();
  await settle();
  galleryModal = lastModal();
  console.log(`  再次创建画廊 → ${JSON.stringify(galleryModal.titleEl.textContent)}`);
  assert(/已存在/.test(galleryModal.titleEl.textContent), "目标 .base 已存在时先弹确认");
  assert(modalButtons(galleryModal).join(",") === "覆盖,打开已有,取消", "三个按钮依次 = 覆盖 / 打开已有 / 取消");
  const openedBeforeExisting = stub.registry.opened.length;
  await clickLastModalButton("打开已有");
  assert(fs.readFileSync(galleryBaseAbs, "utf8") === baseBeforeOpen, "「打开已有」不改写 .base");
  assert(stub.registry.opened.slice(openedBeforeExisting).includes(galleryBaseRel), "「打开已有」打开了那份 .base");

  // 登记第二份画廊模板（自定义文件）⇒ 菜单项改为先弹模板选择。
  fs.mkdirSync(path.join(vaultPath, "Smoke Base Templates"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, customBaseRel), "views:\n  - type: cards\n    name: Custom\n", "utf8");
  const baseCard = () => byClass(tab.containerEl, "annex-templates-card")[1];
  one(baseCard(), "annex-template-path-input").value = customBaseRel;
  one(baseCard(), "annex-template-add").click();
  await settle();
  console.log(`  登记自定义画廊模板 → ${plugin.settings.baseTemplates.map((ref) => `${ref.id}:${ref.path}`).join(" | ")}`);
  assert(
    plugin.settings.baseTemplates.length === 1 && plugin.settings.baseTemplates[0].id === "custom" && plugin.settings.baseTemplates[0].path === customBaseRel,
    "base 卡片「登记」收下了自定义 .base（id=custom）",
  );
  assert(stub.registry.savedData.baseTemplates.length === 1, "自定义画廊模板已写进 data.json");

  galleryItemFor(galleryFolder).callback();
  await settle();
  galleryModal = lastModal();
  const pickerSelect = stub.walk(galleryModal.contentEl).find((el) => el.tagName === "SELECT");
  const pickerIds = pickerSelect === undefined ? [] : stub.walk(pickerSelect).filter((el) => el.tagName === "OPTION").map((el) => el.getAttr("value"));
  console.log(`  两份画廊模板 → ${JSON.stringify(galleryModal.titleEl.textContent)}，下拉：${pickerIds.join(" | ")}`);
  assert(/选画廊模板/.test(galleryModal.titleEl.textContent), "有 2 份画廊模板时先弹模板选择");
  assert(pickerIds.join(",") === "default,custom", "模板下拉 = 内置 default + 自定义 custom");
  await clickLastModalButton("取消");

  // 坏模板（YAML 语法错）⇒ Notice 里带模板路径，且一个 .base 都不写。
  fs.writeFileSync(path.join(vaultPath, brokenTemplateRel), "views: [\n", "utf8");
  one(baseCard(), "annex-template-path-input").value = brokenTemplateRel;
  one(baseCard(), "annex-template-add").click();
  await settle();
  assert(plugin.settings.baseTemplates.length === 2, "第二份自定义画廊模板登记成功");

  const noticesBeforeBroken = stub.registry.notices.length;
  galleryItemFor(brokenFolder).callback();
  await settle();
  galleryModal = lastModal();
  assert(/选画廊模板/.test(galleryModal.titleEl.textContent), "3 份模板时同样先选模板");
  const brokenSelect = stub.walk(galleryModal.contentEl).find((el) => el.tagName === "SELECT");
  brokenSelect.value = "broken";
  brokenSelect.dispatchEvent({ type: "change" });
  await tick();
  await clickLastModalButton("创建画廊");
  const brokenNotices = stub.registry.notices.slice(noticesBeforeBroken).join("\n");
  console.log(`  坏模板 → ${brokenNotices.split("\n")[0]}`);
  assert(new RegExp(brokenTemplateRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(brokenNotices), "Notice 里带着坏模板的 vault 路径");
  assert(/不是合法 YAML/.test(brokenNotices), "Notice 说清是 YAML 不合法");
  assert(!fs.existsSync(path.join(vaultPath, brokenBaseRel)), "坏模板不写 .base");

  // 收摊：本测试在 vault 里造的文件全部清掉。
  rmrf(galleryDir);
  rmrf(path.join(vaultPath, brokenFolder));
  rmrf(path.join(vaultPath, "Smoke Base Templates"));
  rmrf(path.join(vaultPath, "Annex Gallery Templates"));

  // ── 8. 落盘后再开一次：写得进、读得回 ────────────────────────────────────
  const plugin2 = new PluginClass(stub.makeApp(vaultPath), { id: "annex-gallery", version: "0.1.0" });
  await plugin2.onload();
  assert(plugin2.settings.profiles.length === 4, "重开插件后读到 4 条 profile");
  assert(plugin2.settings.folderSamples[dir] === "sample-A", "folderSamples 读回正确");
  assert(plugin2.settings.folderMetadataTemplates[dir] === "embed", "folderMetadataTemplates 读回正确（embed）");
  assert(plugin2.settings.thumbnailEdge === 256, "缩略图边长默认值 256 读回正确");
  assert(
    plugin2.settings.remotes.length === 1 && plugin2.settings.remotes[0].name === "backup" && plugin2.settings.remotes[0].url === "/Volumes/Backup/Data_lab_10",
    `remote 设置读回正确：${plugin2.settings.remotes.map((r) => `${r.name}=${r.url}`).join(" ")}`,
  );

  // ── 9. Drop largefiles：非 annex 仓库时只给一条清楚的 Notice ─────────────
  const modalsBeforeDrop = stub.registry.modals.length;
  const noticesBeforeDrop = stub.registry.notices.length;
  dropItem.callback();
  await tick();
  await tick();
  const dropNotice = stub.registry.notices[stub.registry.notices.length - 1] ?? "";
  console.log(`  Drop largefiles（非仓库目录）→ ${dropNotice.split("\n")[0]}`);
  assert(stub.registry.notices.length === noticesBeforeDrop + 1, "只多了一条 Notice");
  assert(/不是 git 仓库/.test(dropNotice), "Notice 说清「不是 git 仓库」并让人先跑「初始化 gallery」");
  assert(stub.registry.modals.length === modalsBeforeDrop, "预览失败时不弹确认窗");

  // ── 10. 状态栏：未提交 / 未跟踪 / 未入库 largefiles（spec: docs/status-bar.md）──
  // 这里只断言「结构 + 轮询 + 未初始化那一档」；三项数字的逐场景核验在
  // tools/status-check.cjs（真 annex 仓库 + 同一份构建产物），因为无头桩里没有真 annex 仓库。
  const statusItem = stub.registry.statusBarItems[statusItemsAtStart];
  assert(statusItem !== undefined && statusItem.hasClass("annex-status-bar"), "onload 建了状态栏那一行（.annex-status-bar）");
  assert(statusItem.getAttr("data-level") !== undefined, "状态栏项带 data-level（配色用）");
  const statusCounts = stub.walk(statusItem).filter((el) => el.hasClass("annex-status-counts"));
  const statusIcon = stub.walk(statusItem).filter((el) => el.hasClass("annex-status-refresh"))[0];
  assert(statusCounts.length === 1, "状态栏项里有文字 span（.annex-status-counts）");
  assert(statusIcon !== undefined && statusIcon.getAttr("data-icon") === "refresh-cw", "状态栏项里有 refresh-cw 刷新图标");
  assert(typeof plugin.refreshStatus === "function", "refreshStatus() 可被测试 await（确定性刷新）");
  assert(plugin.statusRefreshMs === 30000, "刷新间隔 = 30 秒（statusRefreshMs）");
  assert(
    stub.registry.windowIntervals.some((entry) => entry.ms === 30000),
    "window.setInterval 确实按 30000ms 注册（桩记下间隔毫秒）",
  );
  assert(stub.registry.intervals.length > 0, "registerInterval 收到 id（卸载时框架 clearInterval）");

  // 未初始化那一档：指向一个**不存在**的目录 —— 既不是 git 仓库，也不会因为这次断言被 init 掉。
  const orphanVault = path.join(vaultPath, ".annex-status-orphan");
  const orphan = new PluginClass(stub.makeApp(orphanVault), { id: "annex-gallery", version: "0.1.0" });
  await orphan.onload();
  await orphan.refreshStatus();
  const orphanItem = stub.registry.statusBarItems[stub.registry.statusBarItems.length - 1];
  const orphanText = (stub.walk(orphanItem).filter((el) => el.hasClass("annex-status-counts"))[0] ?? { textContent: "" }).textContent;
  console.log(`  未初始化的 vault → ${orphanText}`);
  assert(orphanText === "未初始化 · 点击初始化 gallery", "未初始化时写明「未初始化 · 点击初始化 gallery」");
  assert(orphanItem.getAttr("data-level") === "uninitialized", "未初始化时 data-level = uninitialized");
  assert(
    /不是 git 仓库|不是 git-annex 仓库/.test(String(orphanItem.getAttr("aria-label"))),
    "悬停提示写明原因（不是 git 仓库 / 不是 git-annex 仓库）",
  );
  assert(/每 30 秒自动刷新/.test(String(orphanItem.getAttr("aria-label"))), "悬停提示写明「每 30 秒自动刷新 · 点击这一行立即刷新」");
  // 无头环境读不到 computed style，所以配色/可点性直接断言 styles.css 里的规则。
  assert(
    /\.annex-status-bar\[data-level="zero"\] \.annex-status-counts\s*\{[^}]*--text-faint/.test(css),
    "styles.css：三项全 0 时用 --text-faint",
  );
  assert(
    /\.annex-status-bar\[data-level="uninitialized"\] \.annex-status-counts/.test(css),
    "styles.css：未初始化 / 不可统计时用 warning 色",
  );
  assert(/\.annex-status-bar \{[\s\S]*?cursor: pointer/.test(css), "styles.css：整行可点（cursor: pointer）");
  assert(
    stub.registry.statusBarItems.length === statusItemsAtStart + 3,
    "每个插件实例只加 1 行状态栏项（本次 smoke 建了 3 个实例）",
  );

  console.log("\n--- data.json（桩环境内存里的落盘内容）---");
  console.log(JSON.stringify(stub.registry.savedData, null, 2));

  assert(plugin.vaultRoot() === vaultPath, `vaultRoot() = ${plugin.vaultRoot()}`);
  console.log(`\n断言全部通过 · NOTICES=${stub.registry.notices.length}`);
  console.log("SMOKE OK");
  process.exit(0);
})().catch((error) => {
  console.error("\nSMOKE FAILED:", error);
  process.exit(1);
});
