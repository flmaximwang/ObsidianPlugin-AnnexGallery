#!/usr/bin/env node
/**
 * Headless load smoke test: loads the *built* main.js against a stubbed
 * `obsidian` module, runs onload(), and exercises the real external-file model
 * (spec-774d7ee):
 *
 *   - 文件名匹配 / metadata / 画廊三类模板：登记外部文件、从预设创建、打开、取消登记；
 *   - 不再有可直接使用的内置模板行，也没有文件名匹配 JSON 的内联编辑器 / 解析预览 / 临时文件回同步；
 *   - profile JSON 每条独立文件、顶层单对象；跨文件 id 重复 / 坏 JSON / 坏正则 / 文件丢失 /
 *     越界路径 / 空列表 / 旧内置引用 / 旧内联 profiles 都有可见行为；
 *   - 生成流程每次重新读外部文件，坏文件在写盘前停下。
 *
 *   node tools/smoke-test.cjs [vaultPath]
 *
 * 全部产物只落在传入的 vault（默认 `/tmp/annex-gallery-smoke-vault`）里的测试目录，跑完删掉；
 * 不会碰真实用户 vault。
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
const SMOKE_TMP_DIRS = [
  "Profiles",
  "Templates",
  "AnnexGalleryTemplates",
  "GallerySmoke",
  "GalleryBroken",
  "GalleryReRead",
  "ReadProfiles",
];
for (const dir of SMOKE_TMP_DIRS) fs.rmSync(path.join(vaultPath, dir), { recursive: true, force: true });
fs.mkdirSync(vaultPath, { recursive: true });
// A fresh plugin instance should start from a clean data.json; the stub keeps it in memory.
stub.registry.savedData = null;

const mainJs = process.env.ANNEX_SMOKE_MAIN ?? path.join(repo, "main.js");
const PluginClass = require(mainJs).default;
const css = fs.readFileSync(path.join(repo, "styles.css"), "utf8");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 等几轮宏任务：模板创建 / 画廊写入这类「回调里 void 一个 async」要多等几拍。 */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await tick();
};
/** 轮询等待异步写盘完成（比固定拍数稳）。 */
async function waitFor(condition, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}
const byClass = (root, cls) => stub.walk(root).filter((el) => el.hasClass(cls));
const one = (root, cls) => byClass(root, cls)[0];
const settingNames = (root) =>
  stub.walk(root)
    .filter((el) => el.getAttr("data-name") !== undefined)
    .map((el) => el.getAttr("data-name"));
/** 一段 CSS 规则体（找不到返回空串）。 */
const rule = (selector) => {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m === null ? "" : m[1];
};
const rel = (...parts) => path.join(vaultPath, ...parts);
const writeText = (relPath, text) => {
  const abs = rel(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return abs;
};
const writeJson = (relPath, value) => writeText(relPath, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (relPath) => JSON.parse(fs.readFileSync(rel(relPath), "utf8"));
const lastNotice = () => stub.registry.notices[stub.registry.notices.length - 1] ?? "";
const lastModal = () => stub.registry.modals[stub.registry.modals.length - 1];

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

// 三条示例 profile：TECNAI / 多孔板 / 供写盘测试用的最小 profile。
const tec = JSON.parse(fs.readFileSync(path.join(repo, "tools/example-profiles/two-profiles.json"), "utf8"))[0];
const plate = JSON.parse(fs.readFileSync(path.join(repo, "tools/example-profiles/plate-profile.json"), "utf8"))[0];
const minimal = {
  id: "smoke",
  name: "Smoke（<序号>）",
  source: "stem",
  regex: "^(?<index>\\d+)$",
  fields: [{ group: "index", type: "number" }],
  ask: ["sample"],
  keyOrder: ["tags", "sample", "index"],
  onMismatch: "empty",
};
writeJson("Profiles/tecnaitem.json", tec);
writeJson("Profiles/Other/platewell.json", plate);
writeJson("Profiles/smoke.json", minimal);

const META_TEXT = "{{frontmatter}}\n\n缩略图：{{thumbnail}}\n原图（用系统默认程序打开）：{{tif}}\nSMOKE-META\n";
const BAD_META_TEXT = "not-frontmatter\n\n{{thumbnail}}\n";
const BASE_TEXT = "views:\n  - type: cards\n    name: Smoke {{folder}}\n    cardSize: {{cardSize}}\n";
const BASE_TEXT_2 = "views:\n  - type: cards\n    name: Second\n";
writeText("Templates/meta.md", META_TEXT);
writeText("Templates/broken.md", BAD_META_TEXT);
writeText("Templates/base.base", BASE_TEXT);
writeText("Templates/base2.base", BASE_TEXT_2);
writeText("Templates/broken.base", "views: [\n");

(async () => {
  const app = stub.makeApp(vaultPath);
  const statusItemsAtStart = stub.registry.statusBarItems.length;
  let instances = 0;
  const plugin = new PluginClass(app, { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  instances += 1;
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
  assert(titles.length === 1, "右键文件夹只出现 1 个顶层菜单项");
  assert(titles[0] === "Annex Gallery", "唯一顶层项就是「Annex Gallery」");
  const annexItem = folderMenu.items[0];
  assert(annexItem.submenu !== null && annexItem.submenu !== undefined, "「Annex Gallery」挂上了子菜单（setSubmenu）");
  const subTitles = annexItem.submenu.items.map((item) => item.title);
  console.log(`  Annex Gallery 子菜单 → ${subTitles.length} 项：${subTitles.join(" | ")}`);
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
  assert(annexItem.submenu.items.map((item) => item.icon).join("|") === expectedIcons.join("|"), `图标逐个对齐：${expectedIcons.join(" | ")}`);
  assert(annexItem.submenu.items.every((item) => typeof item.callback === "function"), "9 个子菜单项都挂了回调");
  const dropItem = annexItem.submenu.items.find((item) => item.title === "Drop largefiles");
  assert(dropItem.icon === "cloud-off", "「Drop largefiles」带了 cloud-off 图标");
  let parentPrevented = false;
  annexItem.callback({ preventDefault: () => { parentPrevented = true; } });
  assert(parentPrevented === true, "点顶层「Annex Gallery」只 preventDefault（不直接跑任何动作，纯展开子菜单）");

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

  // ── 2. 设置页骨架：h1 / remote / 两条分割线 / 普通设置项 ─────────────────
  const tab = stub.registry.tabs[0];
  tab.display();
  const titleEl = one(tab.containerEl, "annex-settings-title");
  console.log(`设置页标题：${titleEl === undefined ? "(缺)" : JSON.stringify(titleEl.textContent)}`);
  assert(titleEl !== undefined && titleEl.tagName === "H1", "设置页顶部是一个 h1");
  assert(titleEl.textContent === "Annex Gallery Settings", "h1 文本 = 「Annex Gallery Settings」");
  assert(tab.containerEl.children[0] === titleEl, "h1 是内容区的第一个元素");
  assert(/margin:\s*0[^;]*;/.test(rule(".annex-settings-title")) && /padding:\s*0/.test(rule(".annex-settings-title")), "styles.css：标题没有 padding/margin（与左侧设置项对齐）");
  assert(byClass(tab.containerEl, "annex-profiles-head").length === 0, "标题下方没有说明文字");

  const remotesSection = one(tab.containerEl, "annex-remotes-section");
  assert(remotesSection !== undefined, "设置页有「remote 设置」这一项");
  assert(tab.containerEl.children[1] === remotesSection, "它在 h1 之后、模板区之前（列表最上方）");
  assert(tab.containerEl.children[2].hasClass("annex-remotes-divider"), "紧接着一条分割线（remote 设置与模板区之间）");
  assert(one(tab.containerEl, "annex-remotes-title").textContent === "remote 设置", "这一项的标题 = 「remote 设置」");
  assert(byClass(tab.containerEl, "annex-remote-row").length === 0, "默认 0 条 remote");
  assert(byClass(tab.containerEl, "annex-remotes-empty").length === 1, "空列表给一句提示");

  one(tab.containerEl, "annex-remote-add").click();
  await settle();
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
  assert(one(tab.containerEl, "annex-remote-note-warn") !== undefined, "只填名称时行尾提示「缺地址」");
  urlIn.value = "ssh://nas.example/volume1/Data_lab_10";
  urlIn.dispatchEvent({ type: "input" });
  await tick();
  assert(stub.registry.savedData.remotes[0].url === "ssh://nas.example/volume1/Data_lab_10", "地址输入即落盘");
  assert(one(tab.containerEl, "annex-remote-note-warn") === undefined, "名称与地址都填全后提示消失");

  one(tab.containerEl, "annex-remote-add").click();
  await settle();
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
  await settle();
  assert(plugin.settings.remotes.length === 1 && plugin.settings.remotes[0].name === "backup", "删掉的是第一行（剩下的那条 = backup）");
  assert(stub.registry.savedData.remotes.length === 1, "删除也落盘");

  const names = settingNames(tab.containerEl);
  console.log(`普通设置项：${names.length === 0 ? "(无)" : names.join(" | ")}`);
  assert(names.join(",") === "缩略图边长,调试日志", "分割线以下是「缩略图边长」与「调试日志」两个设置项（.gitattributes / .gitignore / 默认样品名 已删）");
  assert(byClass(tab.containerEl, "annex-settings-divider").length === 2, "两条分割线（remote/模板 之间 + 模板/普通设置项 之间）");
  assert(byClass(tab.containerEl, "annex-remotes-divider").length === 1, "上面那条标成 annex-remotes-divider");

  // ── 3. 新外部模型：没有内联编辑器、没有内置可用行 ─────────────────────────
  const templatesSection = one(tab.containerEl, "annex-templates-section");
  const topChildren = tab.containerEl.children;
  const profilesIndex = topChildren.findIndex((el) => el.hasClass("annex-profiles-section"));
  const templatesIndex = topChildren.findIndex((el) => el.hasClass("annex-templates-section"));
  const lowerDividerIndex = topChildren.findIndex(
    (el) => el.tagName === "HR" && el.hasClass("annex-settings-divider") && !el.hasClass("annex-remotes-divider"),
  );
  assert(profilesIndex >= 0 && templatesIndex === profilesIndex + 1, "模板区紧跟在文件名匹配模板区之后");
  assert(lowerDividerIndex === templatesIndex + 1, "模板区在下面那条分割线之前");
  assert(templatesSection !== undefined, "设置页有「模板」区");

  assert(byClass(tab.containerEl, "annex-profile-card").length === 0, "没有旧的内联 profile 卡片");
  assert(byClass(tab.containerEl, "annex-profile-json").length === 0, "没有内联 JSON textarea");
  assert(byClass(tab.containerEl, "annex-preview-filename").length === 0, "没有解析预览输入框");
  assert(byClass(tab.containerEl, "annex-preview-result").length === 0, "没有解析预览结果区");
  assert(byClass(tab.containerEl, "annex-profile-status").length === 0, "没有 Saved / Unsaved changes / Syntax Error 状态胶囊");
  assert(byClass(tab.containerEl, "annex-profile-actions").length === 0, "没有 删除/打开/复制/保存 一排旧动作按钮");
  assert(
    ["annex-profile-new", "annex-profile-import", "annex-profile-import-file", "annex-profile-dup", "annex-profile-save"].every(
      (cls) => byClass(tab.containerEl, cls).length === 0,
    ),
    "没有 新模版 / 导入模版 / 复制 / 保存 这些旧交互",
  );
  assert(byClass(tab.containerEl, "annex-profiles-empty").length === 1, "空列表有「登记 / 从预设创建」引导");

  const profileToolbar = one(tab.containerEl, "annex-profiles-toolbar");
  assert(profileToolbar !== undefined, "文件名匹配模板区有工具条");
  const toolbarTags = profileToolbar.children.map((el) => el.tagName);
  console.log(`  文件名匹配工具条：${toolbarTags.join(" | ")}`);
  assert(toolbarTags.join(",") === "INPUT,BUTTON,SELECT", "工具条 = 路径输入 + 登记按钮 + 从预设创建下拉");
  assert(one(profileToolbar, "annex-profile-path-input") !== undefined, "第一格是 vault 相对路径输入框");
  assert(one(profileToolbar, "annex-profile-register").textContent === "登记", "第二个是「登记」按钮");
  const profilePreset = one(profileToolbar, "annex-profile-preset");
  const profilePresetOptions = stub.walk(profilePreset).filter((el) => el.tagName === "OPTION").map((el) => el.textContent);
  console.log(`  profile 预设下拉：${profilePresetOptions.join(" | ")}`);
  assert(profilePresetOptions[0] === "从预设创建…", "下拉第一项是占位「从预设创建…」");
  assert(profilePresetOptions.length === 3 && profilePresetOptions[1].includes("新模板"), "预设选项 = 通用模板 + TECNAI（只是创建素材）");
  assert(rule(".annex-legacy-profiles-warning").length > 0, "styles.css 有旧内联 profiles 的失效提示样式");

  const templateCards = () => byClass(tab.containerEl, "annex-templates-card");
  assert(templateCards().length === 2, "模板区有 2 张卡片");
  assert(templateCards().map((card) => card.getAttr("data-kind")).join(",") === "metadata,base", "两张卡片依次 = metadata / base");
  assert(byClass(tab.containerEl, "annex-template-builtin").length === 0, "没有可直接使用的内置模板行");
  assert(byClass(tab.containerEl, "annex-template-view-btn").length === 0, "没有「查看」内置模板按钮");
  assert(byClass(tab.containerEl, "annex-template-copy").length === 0, "没有「复制为自定义」按钮");
  assert(byClass(tab.containerEl, "annex-templates-empty").length === 2, "两张卡片都给出「登记 / 从预设创建」引导");
  for (const [index, kind] of ["metadata", "base"].entries()) {
    const card = templateCards()[index];
    const addRow = one(card, "annex-template-add-row");
    assert(addRow !== undefined, `${kind} 卡片有登记行`);
    assert(one(card, "annex-template-path-input") !== undefined && one(card, "annex-template-add").textContent === "登记", `${kind} 卡片 = 路径输入 + 登记`);
    const preset = one(card, "annex-template-preset");
    const options = stub.walk(preset).filter((el) => el.tagName === "OPTION").map((el) => el.textContent);
    assert(options[0] === "从预设创建…", `${kind} 卡片的预设下拉第一项是占位项`);
    assert(kind === "metadata" ? options.length === 3 : options.length === 2, `${kind} 卡片的预设素材数量正确（metadata 2 / base 1）`);
  }

  // ── 4. 空列表：生成 / 创建画廊都明确引导，不 fallback ─────────────────────
  let modalsBefore = stub.registry.modals.length;
  annexItem.submenu.items.find((item) => item.title === "生成元数据").callback();
  await settle();
  console.log(`  空 profile 列表 → ${lastNotice().split("\n")[0]}`);
  assert(/还没有登记任何文件名匹配模板/.test(lastNotice()) && /登记|从预设创建/.test(lastNotice()), "生成元数据：空列表明确引导去登记/从预设创建");
  assert(stub.registry.modals.length === modalsBefore, "空 profile 列表不打开弹窗");
  modalsBefore = stub.registry.modals.length;
  annexItem.submenu.items.find((item) => item.title === "创建画廊").callback();
  await settle();
  console.log(`  空 profile 列表 + 空画廊模板 → ${lastNotice().split("\n")[0]}`);
  assert(/还没有登记任何文件名匹配模板/.test(lastNotice()), "创建画廊：空 profile 列表同样在写盘前停下");
  assert(stub.registry.modals.length === modalsBefore, "空列表不打开模板选择弹窗");

  // ── 5. 文件名匹配模板：路径校验 / 登记 / 多份独立 profile / 外部改动 ────────
  const profileInput = () => one(tab.containerEl, "annex-profile-path-input");
  const profileRegister = () => one(tab.containerEl, "annex-profile-register");
  const profileRows = () => byClass(tab.containerEl, "annex-profile-row");
  const registerProfile = async (raw) => {
    profileInput().value = raw;
    profileRegister().click();
    await settle();
  };
  const removeProfileAt = async (relPath) => {
    const row = profileRows().find((entry) => entry.getAttr("data-profile-path") === relPath);
    assert(row !== undefined, `找得到要取消登记的 profile 行：${relPath}`);
    one(row, "annex-profile-del").click();
    await settle();
  };

  const noticesBeforeBadPaths = stub.registry.notices.length;
  await registerProfile("../outside.json");
  assert(stub.registry.notices.length === noticesBeforeBadPaths + 1, "越界路径只多一条 Notice");
  assert(/不能包含 \.\./.test(lastNotice()), "拒绝 `..`（会跑出 vault）");
  await registerProfile("/tmp/outside.json");
  assert(/不接受绝对路径/.test(lastNotice()), "拒绝绝对路径");
  await registerProfile("C:\\temp\\outside.json");
  assert(/不接受盘符路径/.test(lastNotice()), "拒绝 Windows 盘符路径");
  await registerProfile("Profiles/does-not-exist.json");
  assert(/文件不存在/.test(lastNotice()), "登记时拒绝不存在的文件");
  await registerProfile("Profiles/tecnaitem.txt");
  assert(/必须是 \.json 文件/.test(lastNotice()), "登记时拒绝错误扩展名");
  assert(profileRows().length === 0 && plugin.settings.profileFiles.length === 0, "路径校验失败不新增行、不写 data.json");

  // 反斜杠写法统一成正斜杠后仍能登记（同一文件只能一次）。
  await registerProfile("Profiles\\tecnaitem.json");
  assert(profileRows().length === 1, "Windows 分隔符写法能正确规范化并登记");
  assert(plugin.settings.profileFiles[0].path === "Profiles/tecnaitem.json", "落盘的是规范化后的正斜杠相对路径");
  assert(Object.keys(plugin.settings.profileFiles[0]).join(",") === "path", "设置里只存 path（id/name 以 JSON 内容为准）");

  await registerProfile("Profiles/Other/platewell.json");
  assert(profileRows().length === 2, "两条独立 profile JSON 分别登记成两行");
  let rowTec = profileRows().find((row) => row.getAttr("data-profile-path") === "Profiles/tecnaitem.json");
  let rowPlate = profileRows().find((row) => row.getAttr("data-profile-path") === "Profiles/Other/platewell.json");
  assert(one(rowTec, "annex-profile-name").textContent === tec.name && one(rowTec, "annex-profile-id").textContent === `id: ${tec.id}`, "行上的 name / id 来自外部 JSON（TECNAI）");
  assert(one(rowPlate, "annex-profile-name").textContent === plate.name && one(rowPlate, "annex-profile-id").textContent === `id: ${plate.id}`, "行上的 name / id 来自另一份外部 JSON（多孔板）");
  assert(one(rowTec, "annex-profile-open") !== undefined && one(rowTec, "annex-profile-del") !== undefined, "每行都有「打开」「删除」");
  assert(stub.registry.savedData.profileFiles.length === 2, "两条路径都写进 data.json");
  assert(stub.registry.savedData.profileFiles.every((entry) => Object.keys(entry).join(",") === "path"), "data.json 里没有复制 id/name/regex");

  const noticesBeforeDupPath = stub.registry.notices.length;
  await registerProfile("./Profiles//tecnaitem.json");
  assert(stub.registry.notices.length === noticesBeforeDupPath + 1 && /已经登记过/.test(lastNotice()), "同一路径不能重复登记");
  assert(profileRows().length === 2, "重复路径不新增行");

  // 外部改 id / name：设置页下一次渲染与下一次生成都读新内容。
  const tecEdited = JSON.parse(JSON.stringify(tec));
  tecEdited.id = "tec-live";
  tecEdited.name = "TECNAI 外部改名";
  writeJson("Profiles/tecnaitem.json", tecEdited);
  tab.display();
  rowTec = profileRows().find((row) => row.getAttr("data-profile-path") === "Profiles/tecnaitem.json");
  assert(one(rowTec, "annex-profile-id").textContent === "id: tec-live" && one(rowTec, "annex-profile-name").textContent === "TECNAI 外部改名", "外部改 id/name 后设置页重新读取并显示新值");
  writeJson("Profiles/tecnaitem.json", tec);
  tab.display();

  // ── 6. 坏 profile 文件：单对象约束 / JSON / 正则 / 丢失 / 重复 id ─────────
  writeJson("Profiles/array.json", [minimal]);
  writeJson("Profiles/wrapper.json", { profiles: [minimal] });
  writeText("Profiles/bad-json.json", '{ "id": "broken", ');
  writeJson("Profiles/bad-regex.json", { ...minimal, id: "bad-regex", regex: "(" });
  writeJson("Profiles/duplicate.json", { ...tec, name: "重复 id 的第二份" });
  writeJson("Profiles/vanishing.json", { ...minimal, id: "vanishing" });

  await registerProfile("Profiles/array.json");
  await registerProfile("Profiles/wrapper.json");
  await registerProfile("Profiles/bad-json.json");
  await registerProfile("Profiles/bad-regex.json");
  await registerProfile("Profiles/duplicate.json");
  await registerProfile("Profiles/vanishing.json");
  fs.rmSync(rel("Profiles/vanishing.json"));
  tab.display();
  const rowOf = (relPath) => profileRows().find((row) => row.getAttr("data-profile-path") === relPath);
  console.log(`  array 行错误：${one(rowOf("Profiles/array.json"), "annex-profile-error").textContent}`);
  assert(/顶层必须是单条 ParseProfile 对象/.test(one(rowOf("Profiles/array.json"), "annex-profile-error").textContent), "数组 JSON 被拒绝：每条模板必须一个独立对象文件");
  assert(/不接受 \{ profiles: \[\.\.\.\] \}/.test(one(rowOf("Profiles/wrapper.json"), "annex-profile-error").textContent), "`{ profiles: [...] }` 多 profile 包装被拒绝");
  assert(/不是合法 JSON/.test(one(rowOf("Profiles/bad-json.json"), "annex-profile-error").textContent), "坏 JSON 在行上显示可见错误");
  assert(/(正则|regex) 无法编译/.test(one(rowOf("Profiles/bad-regex.json"), "annex-profile-error").textContent), "坏正则显示可见错误");
  assert(/文件不存在/.test(one(rowOf("Profiles/vanishing.json"), "annex-profile-error").textContent), "登记后文件丢失仍在行上显示路径与错误");
  assert(/profile id「tecnaitem」重复登记/.test(one(rowOf("Profiles/duplicate.json"), "annex-profile-error").textContent), "跨文件 id 重复显示可见错误");
  assert(/profile id「tecnaitem」重复登记/.test(one(rowOf("Profiles/tecnaitem.json"), "annex-profile-error").textContent), "重复 id 的两行都被标出");
  assert(
    byClass(rowOf("Profiles/bad-json.json"), "annex-profile-open").length === 1 && one(rowOf("Profiles/bad-json.json"), "annex-profile-path").textContent === "Profiles/bad-json.json",
    "坏行仍保留 path 与「打开」，方便修复",
  );

  // 运行时任何一份坏文件都让整次操作停下（不跳过坏条目、不写盘）。
  const runtimeDir = "ReadProfiles";
  fs.mkdirSync(rel(runtimeDir), { recursive: true });
  modalsBefore = stub.registry.modals.length;
  let noticesBefore = stub.registry.notices.length;
  // 重复 id 这里同时存在；先移走它之前的所有坏行，逐项核验。
  for (const bad of ["Profiles/array.json", "Profiles/wrapper.json", "Profiles/bad-json.json", "Profiles/bad-regex.json", "Profiles/vanishing.json"]) {
    await removeProfileAt(bad);
  }
  // 剩下 tec + plate + duplicate：重复 id 必须让生成失败。
  annexItem.submenu.items.find((item) => item.title === "生成元数据").callback();
  await settle();
  console.log(`  重复 id → ${lastNotice().split("\n")[0]}`);
  assert(/id「tecnaitem」重复/.test(lastNotice()), "重复 id 让生成元数据在弹窗/写盘前失败");
  assert(stub.registry.modals.length === modalsBefore, "重复 id 不打开弹窗");
  await removeProfileAt("Profiles/duplicate.json");
  assert(profileRows().length === 2, "移除坏行后回到两条有效 profile");

  // ── 7. metadata / 画廊模板：登记 / 打开 / 取消登记 / 从预设创建 ───────────
  const cardOf = (kind) => byClass(tab.containerEl, "annex-templates-card").find((card) => card.getAttr("data-kind") === kind);
  const templateRows = (kind) => byClass(cardOf(kind), "annex-template-row");
  const registerTemplate = async (kind, raw) => {
    const card = cardOf(kind);
    one(card, "annex-template-path-input").value = raw;
    one(card, "annex-template-add").click();
    await settle();
  };
  const removeTemplateAt = async (kind, relPath) => {
    const row = templateRows(kind).find((entry) => entry.getAttr("data-template-path") === relPath);
    assert(row !== undefined, `找得到要取消登记的 ${kind} 模板行：${relPath}`);
    one(row, "annex-template-del").click();
    await settle();
  };
  const createFromPreset = async (kind, presetId) => {
    const select = one(cardOf(kind), "annex-template-preset");
    select.value = presetId;
    select.dispatchEvent({ type: "change" });
    await settle();
  };
  const createProfileFromPreset = async (presetId) => {
    const select = one(tab.containerEl, "annex-profile-preset");
    select.value = presetId;
    select.dispatchEvent({ type: "change" });
    await settle();
  };

  await registerTemplate("metadata", "Templates/meta.md");
  let metaRows = templateRows("metadata");
  assert(metaRows.length === 1, "metadata 模板：登记外部 .md 后出现一行");
  assert(metaRows[0].getAttr("data-template-id") === "meta" && metaRows[0].getAttr("data-template-path") === "Templates/meta.md", "行上 id 由文件名生成、path 是 vault 相对路径");
  assert(one(metaRows[0], "annex-template-open") !== undefined && one(metaRows[0], "annex-template-del") !== undefined, "metadata 行有「打开」「删除」");
  assert(stub.registry.savedData.metadataTemplates.length === 1, "metadata 模板登记写进 data.json");

  await registerTemplate("base", "Templates/base.base");
  assert(templateRows("base").length === 1, "画廊模板：登记外部 .base 后出现一行");
  assert(stub.registry.savedData.baseTemplates.length === 1, "画廊模板登记写进 data.json");

  const noticesBeforeMissingTemplate = stub.registry.notices.length;
  await registerTemplate("metadata", "Templates/nope.md");
  assert(/文件不存在/.test(lastNotice()) && stub.registry.notices.length === noticesBeforeMissingTemplate + 1, "登记不存在的模板只弹 Notice、不新增行");
  assert(templateRows("metadata").length === 1 && plugin.settings.metadataTemplates.length === 1, "登记失败不写 data.json");

  // 「打开」：真实方法在无 electron 的桩环境里必须给出可见失败（不静默、不自动创建）。
  noticesBefore = stub.registry.notices.length;
  one(templateRows("metadata")[0], "annex-template-open").click();
  await settle();
  console.log(`  无系统默认应用时「打开」→ ${lastNotice().split("\n")[0]}`);
  assert(stub.registry.notices.length === noticesBefore + 1, "打开失败只多一条 Notice");
  assert(/打不开「Templates\/meta\.md」/.test(lastNotice()) && /拿不到系统默认应用/.test(lastNotice()), "Notice 带路径与失败原因");

  // 「打开」成功：宿主收到的是 vault 内文件的绝对路径。
  const openedWith = [];
  const realOpen = plugin.openWithDefaultApp;
  plugin.openWithDefaultApp = async (abs) => {
    openedWith.push(abs);
  };
  one(templateRows("metadata")[0], "annex-template-open").click();
  await settle();
  assert(openedWith.length === 1 && openedWith[0] === rel("Templates/meta.md"), "打开成功时把外部文件的绝对路径交给系统默认应用宿主");
  // 宿主失败：可见错误，不抛。
  plugin.openWithDefaultApp = async () => {
    throw new Error("no-default-app");
  };
  noticesBefore = stub.registry.notices.length;
  one(templateRows("metadata")[0], "annex-template-open").click();
  await settle();
  assert(stub.registry.notices.length === noticesBefore + 1 && /打不开「Templates\/meta\.md」：no-default-app/.test(lastNotice()), "宿主打开失败显示路径与原因");
  plugin.openWithDefaultApp = realOpen;

  // 登记项重复：路径不能再登记一次。
  noticesBefore = stub.registry.notices.length;
  await registerTemplate("metadata", "Templates/meta.md");
  assert(/已经登记过/.test(lastNotice()) && stub.registry.notices.length === noticesBefore + 1, "同一模板路径不能重复登记");

  // 「删除」只取消登记，文件必须留着；随后重新登记给运行时使用。
  await removeTemplateAt("metadata", "Templates/meta.md");
  assert(plugin.settings.metadataTemplates.length === 0 && fs.existsSync(rel("Templates/meta.md")), "metadata「删除」只取消登记、文件仍在");
  await registerTemplate("metadata", "Templates/meta.md");
  await removeTemplateAt("base", "Templates/base.base");
  assert(plugin.settings.baseTemplates.length === 0 && fs.existsSync(rel("Templates/base.base")), "画廊模板「删除」只取消登记、文件仍在");
  await registerTemplate("base", "Templates/base.base");

  // 从预设创建：每次都写一个独立文件到 AnnexGalleryTemplates/（无空格），不覆盖、不自动打开。
  const openedBeforePreset = stub.registry.opened.length;
  await createFromPreset("metadata", "default");
  assert(fs.existsSync(rel("AnnexGalleryTemplates/default.md")), "metadata「从预设创建」写到 AnnexGalleryTemplates/default.md");
  assert(stub.registry.opened.length === openedBeforePreset, "从预设创建后不自动打开");
  assert(plugin.settings.metadataTemplates.some((entry) => entry.path === "AnnexGalleryTemplates/default.md"), "预设创建的 metadata 文件已登记");
  const firstPresetText = fs.readFileSync(rel("AnnexGalleryTemplates/default.md"), "utf8");
  await createFromPreset("metadata", "default");
  assert(fs.existsSync(rel("AnnexGalleryTemplates/default 2.md")), "同名预设第二次创建加序号，不覆盖");
  assert(fs.readFileSync(rel("AnnexGalleryTemplates/default.md"), "utf8") === firstPresetText, "原有预设文件逐字节未变");
  assert(plugin.settings.metadataTemplates.some((entry) => entry.path === "AnnexGalleryTemplates/default 2.md" && entry.id === "default-2"), "冲突副本的 id 自动去重");

  await createFromPreset("base", "default");
  assert(fs.existsSync(rel("AnnexGalleryTemplates/default.base")), "画廊模板「从预设创建」写到 AnnexGalleryTemplates/default.base");
  assert(plugin.settings.baseTemplates.some((entry) => entry.path === "AnnexGalleryTemplates/default.base"), "预设创建的 .base 已登记");

  await createProfileFromPreset("template");
  assert(fs.existsSync(rel("AnnexGalleryTemplates/template.json")), "文件名匹配模板「从预设创建」写到 AnnexGalleryTemplates/template.json");
  const presetProfile1 = readJson("AnnexGalleryTemplates/template.json");
  assert(!Array.isArray(presetProfile1) && typeof presetProfile1 === "object" && presetProfile1.id === "template", "预设创建的 profile JSON 顶层是单条对象（不是数组）");
  assert(plugin.settings.profileFiles.some((entry) => entry.path === "AnnexGalleryTemplates/template.json"), "预设创建的 profile 已登记");
  await createProfileFromPreset("template");
  const presetProfile2 = readJson("AnnexGalleryTemplates/template 2.json");
  console.log(`  第二次从 profile 预设创建 → id=${presetProfile2.id} name=${presetProfile2.name}`);
  assert(fs.existsSync(rel("AnnexGalleryTemplates/template 2.json")), "profile 预设冲突时也加序号，不覆盖");
  assert(presetProfile2.id === "template-2" && /副本/.test(presetProfile2.name), "profile 预设 id 撞车时在待创建 JSON 内生成唯一 id（名称标副本）");
  assert(readJson("AnnexGalleryTemplates/template.json").id === "template", "第一份预设 profile 的 id 未变");
  // 清掉这两份预设 profile，后面只留两条手工登记的外部 JSON。
  await removeProfileAt("AnnexGalleryTemplates/template.json");
  await removeProfileAt("AnnexGalleryTemplates/template 2.json");
  assert(fs.existsSync(rel("AnnexGalleryTemplates/template.json")) && fs.existsSync(rel("AnnexGalleryTemplates/template 2.json")), "取消登记 profile 不删除预设文件");

  // ── 8. 生成元数据：运行时读外部文件、模板下拉无内置、坏文件写盘前停下 ─────
  // 当前：profileFiles = tecnaitem + platewell；metadataTemplates = meta + default + default 2；
  //       baseTemplates = base + default.base。
  assert(plugin.settings.profileFiles.length === 2, "生成前有 2 条独立 profile");
  const readDir = rel(runtimeDir);
  fs.mkdirSync(readDir, { recursive: true });
  writeText(`${runtimeDir}/001.tif`, "fake-tif");
  const submenuAction = (folderPath, title) => {
    const menu = new stub.Menu();
    stub.registry.menus[0](menu, new stub.TFolder(folderPath), "file-explorer");
    return menu.items[0].submenu.items.find((item) => item.title === title);
  };
  // 让目录里只有最小 profile 能稳定写出 sidecar：把 tec/plate 暂时移出登记，改为 smoke + plate?
  // 这里保留两条 profile 但用 --profile 逻辑由弹窗选第一条：登记顺序 tecnaitem, platewell；TECNAI
  // 正则不命中 001.tif，onMismatch=empty 仍会写。为了让断言稳定，临时只登记 smoke。
  const savedProfiles = [...plugin.settings.profileFiles];
  plugin.settings.profileFiles = [{ path: "Profiles/smoke.json" }];
  await plugin.saveSettings();
  tab.display();

  modalsBefore = stub.registry.modals.length;
  submenuAction(runtimeDir, "生成元数据").callback();
  await settle();
  assert(stub.registry.modals.length === modalsBefore + 1, "有效外部 profile + metadata 模板时打开生成弹窗");
  let modal = lastModal();
  let selects = stub.walk(modal.contentEl).filter((el) => el.tagName === "SELECT");
  assert(selects.length === 2, "弹窗里有 profile + metadata 模板两个下拉");
  let profileOptions = stub.walk(selects[0]).filter((el) => el.tagName === "OPTION").map((el) => el.getAttr("value"));
  let metadataOptions = stub.walk(selects[1]).filter((el) => el.tagName === "OPTION").map((el) => el.getAttr("value"));
  console.log(`  profile 下拉：${profileOptions.join(" | ")}；metadata 下拉：${metadataOptions.join(" | ")}`);
  assert(profileOptions.join(",") === "smoke", "profile 下拉只列已登记的外部 JSON");
  assert(metadataOptions.join(",") === "meta,default,default-2", "metadata 下拉只列已登记的外部文件，没有未登记的旧内置 default/embed");
  assert(selects[1].value === "meta", "没有 profile.metadataTemplate 时默认第一条已登记模板（不是内置 default）");
  const askInput = stub.walk(modal.contentEl).find((el) => el.tagName === "INPUT" && el.getAttr("data-ask-key") === "sample");
  assert(askInput !== undefined, "按 profile 的 ask 生成 sample 输入框");
  askInput.value = "smoke-sample";
  askInput.dispatchEvent({ type: "input" });
  const submitButton = stub.walk(modal.contentEl).find((el) => el.tagName === "BUTTON" && el.textContent === "生成元数据");
  assert(submitButton !== undefined, "弹窗有「生成元数据」按钮");
  submitButton.click();
  const sidecarAbs = path.join(readDir, "001.md");
  assert(await waitFor(() => fs.existsSync(sidecarAbs)), "提交后真的写出 sidecar（运行时读外部 profile / 模板）");
  const sidecarText = fs.readFileSync(sidecarAbs, "utf8");
  console.log(`  写出的 sidecar 头部：${JSON.stringify(sidecarText.slice(0, 70))}`);
  assert(sidecarText.includes("SMOKE-META"), "sidecar 正文来自已登记的外部 metadata 模板");
  assert(/tags:\n  - annex-gallery-metadata/.test(sidecarText), "sidecar 带 annex-gallery-metadata 标签");
  assert(/sample: "smoke-sample"/.test(sidecarText), "sidecar 写入了弹窗填的 ask 值");
  assert(plugin.settings.folderSamples[path.join(vaultPath, runtimeDir)] === "smoke-sample", "ask 值按文件夹记住并落盘");

  // 外部改 profile 的 id/name：下一次打开生成弹窗读新内容（不沿用内存旧值）。
  const smokeEdited = { ...minimal, id: "smoke-live", name: "Smoke 实时改名" };
  writeJson("Profiles/smoke.json", smokeEdited);
  tab.display();
  submenuAction(runtimeDir, "生成元数据").callback();
  await settle();
  modal = lastModal();
  selects = stub.walk(modal.contentEl).filter((el) => el.tagName === "SELECT");
  profileOptions = stub.walk(selects[0]).filter((el) => el.tagName === "OPTION").map((el) => el.textContent);
  console.log(`  外部改名后 profile 下拉：${profileOptions.join(" | ")}`);
  assert(profileOptions.some((text) => text.includes("smoke-live") && text.includes("Smoke 实时改名")), "下一次生成重新读取外部 JSON 的新 id/name");
  modal.close();
  writeJson("Profiles/smoke.json", minimal);

  // 坏 metadata 模板：弹窗能打开，但提交后整个操作在写盘前停下。
  const badDir = "ReadProfiles/bad-template";
  fs.mkdirSync(rel(badDir), { recursive: true });
  writeText(`${badDir}/002.tif`, "fake-tif");
  plugin.settings.metadataTemplates = [{ id: "broken", name: "broken", path: "Templates/broken.md" }];
  await plugin.saveSettings();
  tab.display();
  modalsBefore = stub.registry.modals.length;
  submenuAction(badDir, "生成元数据").callback();
  await settle();
  modal = lastModal();
  const badSubmit = stub.walk(modal.contentEl).find((el) => el.tagName === "BUTTON" && el.textContent === "生成元数据");
  const badAsk = stub.walk(modal.contentEl).find((el) => el.tagName === "INPUT" && el.getAttr("data-ask-key") === "sample");
  badAsk.value = "x";
  badAsk.dispatchEvent({ type: "input" });
  noticesBefore = stub.registry.notices.length;
  badSubmit.click();
  await settle(12);
  console.log(`  坏 metadata 模板 → ${lastNotice().split("\n")[0]}`);
  assert(/第一行必须是 \{\{frontmatter\}\}/.test(lastNotice()), "坏 metadata 模板给出可见错误");
  assert(!fs.existsSync(rel(`${badDir}/002.md`)), "坏模板在写盘前停下（一份 sidecar 都不写）");
  assert(stub.registry.modals.length === modalsBefore + 1, "坏模板失败不再弹二次确认");
  plugin.settings.metadataTemplates = [
    { id: "meta", name: "meta", path: "Templates/meta.md" },
    { id: "default", name: "默认（从预设）", path: "AnnexGalleryTemplates/default.md" },
    { id: "default-2", name: "默认（副本）", path: "AnnexGalleryTemplates/default 2.md" },
  ];
  await plugin.saveSettings();
  tab.display();

  // 旧内置引用：profile 声明 "embed" 但只登记了外部 meta/default ⇒ 可见错误，不回退。
  const oldRef = { ...minimal, id: "old-ref", name: "旧内置引用", metadataTemplate: "embed" };
  writeJson("Profiles/old-ref.json", oldRef);
  await registerProfile("Profiles/old-ref.json");
  // 让弹窗默认选中这份 profile，且没有「按文件夹记住」的模板抢先覆盖它声明的旧引用。
  plugin.settings.folderProfiles[path.join(vaultPath, runtimeDir)] = "old-ref";
  delete plugin.settings.folderMetadataTemplates[path.join(vaultPath, runtimeDir)];
  modalsBefore = stub.registry.modals.length;
  submenuAction(runtimeDir, "生成元数据").callback();
  await settle();
  console.log(`  旧内置引用 embed → ${lastNotice().split("\n")[0]}`);
  assert(/旧内置 default\/embed 不再可用/.test(lastNotice()), "旧内置模板引用显示可见错误并引导登记/创建");
  assert(stub.registry.modals.length === modalsBefore, "旧内置引用不打开弹窗");
  await removeProfileAt("Profiles/old-ref.json");
  delete plugin.settings.folderProfiles[path.join(vaultPath, runtimeDir)];

  // 按文件夹记住的旧内置 id 无效 ⇒ 选择第一条已登记模板，而不是内置内容。
  plugin.settings.folderMetadataTemplates[path.join(vaultPath, runtimeDir)] = "embed";
  submenuAction(runtimeDir, "生成元数据").callback();
  await settle();
  modal = lastModal();
  selects = stub.walk(modal.contentEl).filter((el) => el.tagName === "SELECT");
  assert(selects[1].value === "meta", "无效的旧模板记忆自然失效，回落到第一条已登记外部模板");
  modal.close();

  // 空 metadata 列表：生成在弹窗前停下并引导登记。
  plugin.settings.metadataTemplates = [];
  await plugin.saveSettings();
  tab.display();
  modalsBefore = stub.registry.modals.length;
  submenuAction(runtimeDir, "生成元数据").callback();
  await settle();
  console.log(`  空 metadata 列表 → ${lastNotice().split("\n")[0]}`);
  assert(/还没有登记 metadata 模板/.test(lastNotice()), "空 metadata 列表明确引导去登记/从预设创建");
  assert(stub.registry.modals.length === modalsBefore, "空 metadata 列表不打开弹窗");

  // 恢复两条手工 profile 与 meta/default 模板。
  plugin.settings.profileFiles = savedProfiles;
  plugin.settings.metadataTemplates = [
    { id: "meta", name: "meta", path: "Templates/meta.md" },
    { id: "default", name: "默认（从预设）", path: "AnnexGalleryTemplates/default.md" },
  ];
  await plugin.saveSettings();
  tab.display();

  // 空的画廊模板列表：创建画廊在写盘前停下。
  const emptyBaseDir = "GalleryBroken/empty-base";
  fs.mkdirSync(rel(emptyBaseDir), { recursive: true });
  plugin.settings.baseTemplates = [];
  await plugin.saveSettings();
  tab.display();
  modalsBefore = stub.registry.modals.length;
  const galleryMenuFor = (folderPath) => {
    const menu = new stub.Menu();
    stub.registry.menus[0](menu, new stub.TFolder(folderPath), "file-explorer");
    return menu.items[0].submenu.items.find((item) => item.title === "创建画廊");
  };
  galleryMenuFor(emptyBaseDir).callback();
  await settle();
  console.log(`  空画廊模板列表 → ${lastNotice().split("\n")[0]}`);
  assert(/还没有登记任何画廊模板/.test(lastNotice()), "空画廊模板列表明确引导去登记/从预设创建");
  assert(stub.registry.modals.length === modalsBefore && !fs.existsSync(rel(`${emptyBaseDir}/empty-base.base`)), "空列表不弹窗、不写 .base");
  plugin.settings.baseTemplates = [
    { id: "base", name: "base", path: "Templates/base.base" },
    { id: "default", name: "默认（从预设）", path: "AnnexGalleryTemplates/default.base" },
  ];
  await plugin.saveSettings();
  tab.display();

  // ── 9. 创建画廊：外部模板 + 旧 sidecar + 已存在 + 坏模板 + 坏 profile ────
  const galleryFolder = "GallerySmoke";
  const galleryDir = rel(galleryFolder);
  const galleryBaseRel = `${galleryFolder}/${galleryFolder}.base`;
  const galleryBaseAbs = rel(galleryBaseRel);
  const brokenFolder = "GalleryBroken";
  const brokenBaseRel = `${brokenFolder}/${brokenFolder}.base`;
  const rmrf = (target) => fs.rmSync(target, { recursive: true, force: true });
  const modalButtons = (m) => stub.walk(m.contentEl).filter((el) => el.tagName === "BUTTON").map((el) => el.textContent);
  const clickLastModalButton = async (text) => {
    const button = stub.walk(lastModal().contentEl).find((el) => el.tagName === "BUTTON" && el.textContent === text);
    assert(button !== undefined, `弹窗里有「${text}」按钮`);
    button.click();
    await settle(12);
  };

  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(rel(brokenFolder), { recursive: true });
  writeText(`${galleryFolder}/tagged.tif`, "fake-tif");
  writeText(`${galleryFolder}/tagged.md`, "---\ntags:\n  - annex-gallery-metadata\nsample: A\n---\n\n缩略图：\n");
  writeText(`${galleryFolder}/old.tif`, "fake-tif");
  const oldSidecarBefore = "---\ntif: old.tif\nsample: B\n---\n\n旧版 sidecar\n";
  writeText(`${galleryFolder}/old.md`, oldSidecarBefore);
  writeText(`${galleryFolder}/README.md`, "# 说明\n");

  // 多份外部模板 ⇒ 先选；下拉只有登记的外部 id，没有内置 default。
  const openedBeforeGallery = stub.registry.opened.length;
  galleryMenuFor(galleryFolder).callback();
  await settle();
  let galleryModal = lastModal();
  console.log(`  首次创建画廊 → ${JSON.stringify(galleryModal.titleEl.textContent)}`);
  assert(/选画廊模板/.test(galleryModal.titleEl.textContent), "有 2 份已登记画廊模板时先弹模板选择");
  let picker = stub.walk(galleryModal.contentEl).find((el) => el.tagName === "SELECT");
  let pickerIds = stub.walk(picker).filter((el) => el.tagName === "OPTION").map((el) => el.getAttr("value"));
  assert(pickerIds.join(",") === "base,default", "画廊模板下拉只列已登记外部模板（base / default）");
  assert(picker.value === "base", "按文件夹无有效记忆时选第一条已登记模板");
  await clickLastModalButton("创建画廊");

  galleryModal = lastModal();
  console.log(`  选模板后 → ${JSON.stringify(galleryModal.titleEl.textContent)}`);
  assert(/没有标签/.test(galleryModal.titleEl.textContent), "旧 sidecar 没标签时先弹「补标签 / 跳过 / 取消」");
  assert(modalButtons(galleryModal).join(",") === "补标签,跳过,取消", "三个按钮依次 = 补标签 / 跳过 / 取消");
  await clickLastModalButton("补标签");

  const oldSidecarAfter = fs.readFileSync(rel(`${galleryFolder}/old.md`), "utf8");
  const expectedOldSidecar = oldSidecarBefore.replace(/^---\n/, "---\ntags:\n  - annex-gallery-metadata\n");
  assert(oldSidecarAfter === expectedOldSidecar, "「补标签」只加 tags 一项，其余逐字不变");
  assert(await waitFor(() => fs.existsSync(galleryBaseAbs)), `.base 写在 ${galleryBaseRel}`);
  const galleryBaseText = fs.readFileSync(galleryBaseAbs, "utf8");
  assert(galleryBaseText.includes('file.inFolder("GallerySmoke")'), "画廊作用域含 file.inFolder(\"GallerySmoke\")");
  assert(galleryBaseText.includes('file.hasTag("annex-gallery-metadata")'), "画廊作用域含 file.hasTag(\"annex-gallery-metadata\")");
  assert(galleryBaseText.includes("cardSize: 256"), ".base 里填进了设置里的 cardSize（256）");
  assert(galleryBaseText.includes("name: Smoke GallerySmoke"), "正文来自已登记的外部 .base 模板");
  assert(stub.registry.opened.slice(openedBeforeGallery).includes(galleryBaseRel), "写完后用 getLeaf().openFile() 打开了画廊");
  assert(stub.registry.notices.some((n) => /创建画廊完成/.test(n) && new RegExp(galleryBaseRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(n)), "完成后的 Notice 里点名画廊路径");

  const baseBeforeOpen = fs.readFileSync(galleryBaseAbs, "utf8");
  galleryMenuFor(galleryFolder).callback();
  await settle();
  galleryModal = lastModal();
  assert(/选画廊模板/.test(galleryModal.titleEl.textContent), "再次创建画廊仍先经过模板选择（有 2 份已登记模板）");
  await clickLastModalButton("创建画廊");
  galleryModal = lastModal();
  console.log(`  再次创建画廊 → ${JSON.stringify(galleryModal.titleEl.textContent)}`);
  assert(/已存在/.test(galleryModal.titleEl.textContent), "目标 .base 已存在时先弹确认");
  assert(modalButtons(galleryModal).join(",") === "覆盖,打开已有,取消", "三个按钮依次 = 覆盖 / 打开已有 / 取消");
  const openedBeforeExisting = stub.registry.opened.length;
  await clickLastModalButton("打开已有");
  assert(fs.readFileSync(galleryBaseAbs, "utf8") === baseBeforeOpen, "「打开已有」不改写 .base");
  assert(stub.registry.opened.slice(openedBeforeExisting).includes(galleryBaseRel), "「打开已有」打开了那份 .base");

  // 坏 .base 模板：登记后选它 ⇒ Notice 指名文件，且不写 .base。
  writeText("Templates/broken.base", "views: [\n");
  await registerTemplate("base", "Templates/broken.base");
  galleryMenuFor(brokenFolder).callback();
  await settle();
  galleryModal = lastModal();
  assert(/选画廊模板/.test(galleryModal.titleEl.textContent), "3 份模板时同样先选模板");
  picker = stub.walk(galleryModal.contentEl).find((el) => el.tagName === "SELECT");
  picker.value = "broken";
  picker.dispatchEvent({ type: "change" });
  await settle();
  noticesBefore = stub.registry.notices.length;
  await clickLastModalButton("创建画廊");
  const brokenNotices = stub.registry.notices.slice(noticesBefore).join("\n");
  console.log(`  坏画廊模板 → ${brokenNotices.split("\n")[0]}`);
  assert(new RegExp("Templates/broken\\.base").test(brokenNotices), "Notice 里带着坏模板的 vault 路径");
  assert(/不是合法 YAML/.test(brokenNotices), "Notice 说清是 YAML 不合法");
  assert(!fs.existsSync(rel(brokenBaseRel)), "坏模板不写 .base");
  await removeTemplateAt("base", "Templates/broken.base");

  // 坏外部 profile ⇒ 创建画廊在写 .base 之前停下（不覆盖已有文件）。
  const rereadFolder = "GalleryReRead";
  fs.mkdirSync(rel(rereadFolder), { recursive: true });
  writeText(`${rereadFolder}/x.tif`, "fake-tif");
  await registerProfile("Profiles/smoke.json");
  writeJson("Profiles/smoke.json", { ...minimal, regex: "(" });
  tab.display();
  const rereadBaseRel = `${rereadFolder}/${rereadFolder}.base`;
  modalsBefore = stub.registry.modals.length;
  noticesBefore = stub.registry.notices.length;
  galleryMenuFor(rereadFolder).callback();
  await settle();
  console.log(`  坏 profile + 创建画廊 → ${lastNotice().split("\n")[0]}`);
  assert(/(正则|regex) 无法编译/.test(lastNotice()), "创建画廊读取外部 profile 时看到坏正则");
  assert(stub.registry.modals.length === modalsBefore, "坏 profile 不打开选模板弹窗");
  assert(!fs.existsSync(rel(rereadBaseRel)), "坏 profile 在写 .base 前停下");
  writeJson("Profiles/smoke.json", minimal);
  await removeProfileAt("Profiles/smoke.json");

  // 按文件夹记住的旧内置画廊模板 id 无效 ⇒ 第一条已登记模板，而不是内置内容。
  plugin.settings.baseTemplates = [{ id: "base", name: "base", path: "Templates/base.base" }];
  plugin.settings.folderBaseTemplates[rel(rereadFolder)] = "default";
  await plugin.saveSettings();
  tab.display();
  modalsBefore = stub.registry.modals.length;
  galleryMenuFor(rereadFolder).callback();
  await settle(12);
  assert(stub.registry.modals.length === modalsBefore, "无效的旧画廊模板记忆被忽略（只有一份模板时直接用它）");
  assert(await waitFor(() => fs.existsSync(rel(rereadBaseRel))), "回落的第一条已登记模板仍能创建画廊");
  const rereadBaseText = fs.readFileSync(rel(rereadBaseRel), "utf8");
  assert(rereadBaseText.includes("name: Smoke GalleryReRead"), "创建用的是已登记外部模板，不是内置 default");

  // 收摊：本测试在 vault 里造的文件全部清掉。
  rmrf(galleryDir);
  rmrf(rel(brokenFolder));
  rmrf(rel(rereadFolder));
  rmrf(rel("AnnexGalleryTemplates"));

  // ── 10. 旧内联 profiles：只提示、不迁移、不参与运行时 ─────────────────────
  const mainSavedData = JSON.parse(JSON.stringify(stub.registry.savedData));
  const legacyVault = path.join(vaultPath, "LegacyVault");
  fs.mkdirSync(legacyVault, { recursive: true });
  stub.registry.savedData = {
    thumbnailEdge: 256,
    profiles: [JSON.parse(JSON.stringify(tec))],
    folderSamples: {},
    folderProfiles: { [legacyVault]: tec.id },
  };
  const legacyPlugin = new PluginClass(stub.makeApp(legacyVault), { id: "annex-gallery", version: "0.1.0" });
  await legacyPlugin.onload();
  instances += 1;
  const legacyTab = stub.registry.tabs[stub.registry.tabs.length - 1];
  legacyTab.display();
  const legacyWarning = one(legacyTab.containerEl, "annex-legacy-profiles-warning");
  console.log(`  旧内联 profiles 提示：${legacyWarning === undefined ? "(缺)" : legacyWarning.getAttr("data-count")}`);
  assert(legacyWarning !== undefined && legacyWarning.getAttr("data-count") === "1", "检测到旧内联 profiles 时显示提示");
  const legacyWarningBody = one(legacyWarning, "annex-legacy-profiles-warning-body");
  assert(legacyWarningBody !== undefined && /不会读取、不会自动迁移/.test(legacyWarningBody.textContent), "提示写明不读取、不自动迁移");
  assert(legacyWarningBody !== undefined && /分别保存成 vault 里的一个 \.json 文件/.test(legacyWarningBody.textContent), "提示引导手工登记外部 JSON");
  assert(legacyPlugin.settings.profileFiles.length === 0, "旧内联 profiles 没有变成 profileFiles（不迁移）");
  assert(byClass(legacyTab.containerEl, "annex-profile-row").length === 0, "旧内联 profiles 不渲染成外部模板行");
  modalsBefore = stub.registry.modals.length;
  const legacyMenu = new stub.Menu();
  stub.registry.menus[stub.registry.menus.length - 1](legacyMenu, new stub.TFolder("TEM/x"), "file-explorer");
  legacyMenu.items[0].submenu.items.find((item) => item.title === "生成元数据").callback();
  await settle();
  console.log(`  旧内联 profiles 生成 → ${lastNotice().split("\n")[0]}`);
  assert(/还没有登记任何文件名匹配模板/.test(lastNotice()), "旧内联 profiles 不参与运行时（不 fallback）");
  assert(stub.registry.modals.length === modalsBefore, "旧内联 profiles 不打开生成弹窗");
  assert(stub.registry.savedData.profiles.length === 1 && stub.registry.savedData.profileFiles === undefined, "旧 data.json 的 profiles 原样保留、没有被迁移成 profileFiles");
  stub.registry.savedData = mainSavedData;
  rmrf(legacyVault);

  // ── 11. 落盘后再开一次：外部路径 / 模板登记 / 记忆都写得进、读得回 ─────────
  const plugin2 = new PluginClass(stub.makeApp(vaultPath), { id: "annex-gallery", version: "0.1.0" });
  await plugin2.onload();
  instances += 1;
  assert(plugin2.settings.profileFiles.length === 2, "重开插件后读到 2 条外部 profile 路径");
  assert(plugin2.settings.profileFiles.every((entry) => entry.path !== undefined), "读回的是 path 列表（不是内联 profiles）");
  assert(plugin2.settings.metadataTemplates.length === 2 && plugin2.settings.metadataTemplates.every((entry) => entry.path !== undefined), "metadata 模板登记读回正确");
  assert(plugin2.settings.baseTemplates.length === 1 && plugin2.settings.baseTemplates[0].id === "base", "画廊模板登记读回正确");
  assert(plugin2.settings.folderSamples[path.join(vaultPath, runtimeDir)] === "smoke-sample", "folderSamples 读回正确");
  assert(plugin2.settings.folderMetadataTemplates[path.join(vaultPath, runtimeDir)] === "embed", "folderMetadataTemplates 读回正确（无效旧记忆原样保留，运行时忽略）");
  assert(plugin2.settings.folderBaseTemplates[rel(rereadFolder)] === "base", "folderBaseTemplates 读回正确（无效旧记忆已被有效选择替代）");
  assert(plugin2.settings.thumbnailEdge === 256, "缩略图边长默认值 256 读回正确");
  assert(plugin2.settings.remotes.length === 1 && plugin2.settings.remotes[0].name === "backup", "remote 设置读回正确");
  assert(plugin2.legacyInlineProfiles.present === false, "当前 data.json 没有旧内联 profiles 提示");

  // ── 12. Drop largefiles：非 annex 仓库时只给一条清楚的 Notice ─────────────
  const modalsBeforeDrop = stub.registry.modals.length;
  const noticesBeforeDrop = stub.registry.notices.length;
  dropItem.callback();
  await settle();
  const dropNotice = lastNotice();
  console.log(`  Drop largefiles（非仓库目录）→ ${dropNotice.split("\n")[0]}`);
  assert(stub.registry.notices.length === noticesBeforeDrop + 1, "只多了一条 Notice");
  assert(/不是 git 仓库/.test(dropNotice), "Notice 说清「不是 git 仓库」并让人先跑「初始化 gallery」");
  assert(stub.registry.modals.length === modalsBeforeDrop, "预览失败时不弹确认窗");

  // ── 13. 状态栏结构（逐项数字在 npm run verify:status）────────────────────
  const statusItem = stub.registry.statusBarItems[statusItemsAtStart];
  assert(statusItem !== undefined && statusItem.hasClass("annex-status-bar"), "onload 建了状态栏那一行（.annex-status-bar）");
  assert(statusItem.getAttr("data-level") !== undefined, "状态栏项带 data-level（配色用）");
  assert(stub.walk(statusItem).filter((el) => el.hasClass("annex-status-counts")).length === 1, "状态栏项里有文字 span（.annex-status-counts）");
  const statusIcon = stub.walk(statusItem).filter((el) => el.hasClass("annex-status-refresh"))[0];
  assert(statusIcon !== undefined && statusIcon.getAttr("data-icon") === "refresh-cw", "状态栏项里有 refresh-cw 刷新图标");
  assert(typeof plugin.refreshStatus === "function", "refreshStatus() 可被测试 await（确定性刷新）");
  assert(plugin.statusRefreshMs === 30000, "刷新间隔 = 30 秒（statusRefreshMs）");
  assert(stub.registry.windowIntervals.some((entry) => entry.ms === 30000), "window.setInterval 确实按 30000ms 注册");
  assert(stub.registry.intervals.length > 0, "registerInterval 收到 id（卸载时框架 clearInterval）");

  const orphanVault = path.join(vaultPath, ".annex-status-orphan");
  const orphan = new PluginClass(stub.makeApp(orphanVault), { id: "annex-gallery", version: "0.1.0" });
  await orphan.onload();
  instances += 1;
  await orphan.refreshStatus();
  const orphanItem = stub.registry.statusBarItems[stub.registry.statusBarItems.length - 1];
  const orphanText = (stub.walk(orphanItem).filter((el) => el.hasClass("annex-status-counts"))[0] ?? { textContent: "" }).textContent;
  console.log(`  未初始化的 vault → ${orphanText}`);
  assert(orphanText === "未初始化 · 点击初始化 gallery", "未初始化时写明「未初始化 · 点击初始化 gallery」");
  assert(orphanItem.getAttr("data-level") === "uninitialized", "未初始化时 data-level = uninitialized");
  assert(/不是 git 仓库|不是 git-annex 仓库/.test(String(orphanItem.getAttr("aria-label"))), "悬停提示写明原因");
  assert(/每 30 秒自动刷新/.test(String(orphanItem.getAttr("aria-label"))), "悬停提示写明刷新口径");
  assert(/\.annex-status-bar\[data-level="zero"\] \.annex-status-counts\s*\{[^}]*--text-faint/.test(css), "styles.css：三项全 0 时用 --text-faint");
  assert(/\.annex-status-bar\[data-level="uninitialized"\] \.annex-status-counts/.test(css), "styles.css：未初始化 / 不可统计时用 warning 色");
  assert(/\.annex-status-bar \{[\s\S]*?cursor: pointer/.test(css), "styles.css：整行可点（cursor: pointer）");
  assert(stub.registry.statusBarItems.length === statusItemsAtStart + instances, `每个插件实例只加 1 行状态栏项（本次建了 ${instances} 个实例）`);

  assert(plugin.vaultRoot() === vaultPath, `vaultRoot() = ${plugin.vaultRoot()}`);
  console.log(`\n断言全部通过 · NOTICES=${stub.registry.notices.length}`);
  console.log("SMOKE OK");
  process.exit(0);
})().catch((error) => {
  console.error("\nSMOKE FAILED:", error);
  process.exit(1);
});
