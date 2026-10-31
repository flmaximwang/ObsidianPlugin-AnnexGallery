#!/usr/bin/env node
/**
 * 设置页布局回归检查（离屏量法，不需要人眼看截图，也不需要重启 Obsidian）。
 *
 *   node tools/layout-check.cjs            # 量现在的 styles.css，按 spec 断言
 *   node tools/layout-check.cjs --json     # 另把原始几何打出来
 *
 * 为什么能信：三样东西都是真的 ——
 *   ① 真实 app.css：从本机 `~/Library/Application Support/obsidian/obsidian-<ver>.asar` 里抽出来的
 *      官方样式表（规格里那些 `--size-4-*` / `.setting-item` / `.setting-group` 规则都来自它）；
 *   ② 真实 DOM：用 tools/obsidian-stub.cjs 跑构建产物 main.js，`tab.update()` 出来的那棵树；
 *   ③ 真实引擎：headless Chromium（本机 Chrome）算的几何。
 *
 * 验证的是声明式设置页里能变成数字的那些：没有 h1 / hr，顶层是三个 .setting-group
 * （remote → 文件名匹配模板与模板 → 常规）；remote 设置在最上方；
 * 文件名匹配模板工具条 = 路径输入 + 登记 + 从预设创建；每条已登记 JSON 一行（name/id/path/打开/删除）；
 * metadata / 画廊模板各一张卡片、一行一个外部文件；没有内置可用行、没有内联编辑器/预览/旧动作排；
 * 所有内容没有横向溢出。观感（配色、间距好不好看）仍要人眼在真机上看一眼。
 *
 * 依赖：本机有 Chrome / Chromium / Edge 之一（自动找）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CACHE = path.join(os.tmpdir(), "annex-gallery-layout");
const VAULT = path.join(os.tmpdir(), "annex-gallery-layout-vault");
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

let pass = 0;
let fail = 0;
function check(condition, message, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${message}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${message}${detail === undefined ? "" : `  —— ${detail}`}`);
  }
}

/** 本机 Obsidian 的 app.css（从 asar 里抽；已抽过就复用缓存）。 */
function ensureAppCss() {
  const cached = path.join(CACHE, "app.css");
  const asarDir = path.join(os.homedir(), "Library", "Application Support", "obsidian");
  const asars = fs.existsSync(asarDir)
    ? fs.readdirSync(asarDir).filter((f) => /^obsidian-.*\.asar$/.test(f)).sort()
    : [];
  if (asars.length === 0) throw new Error(`找不到 obsidian-*.asar（看了 ${asarDir}）`);
  const asar = path.join(asarDir, asars[asars.length - 1]);
  const stamp = path.join(CACHE, "app.css.from");
  if (fs.existsSync(cached) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === asar) return cached;

  // asar = pickle 头(4+4+4 字节) + JSON 目录表 + 文件数据
  const buffer = fs.readFileSync(asar);
  const headerSize = buffer.readUInt32LE(4);
  const headerJsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + headerJsonSize).toString("utf8"));
  const dataStart = 16 + Math.ceil(headerJsonSize / 4) * 4;
  const entry = header.files["app.css"];
  if (entry === undefined) throw new Error(`${asar} 里没有 app.css`);
  // 注意：asar 目录表里的 offset/size 是**字符串**，直接相加会变成字符串拼接。
  const offset = Number(entry.offset);
  const size = Number(entry.size);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buffer.subarray(dataStart + offset, dataStart + offset + size));
  fs.writeFileSync(stamp, asar);
  console.log(`从 ${path.basename(asar)} 抽出 app.css（${size} 字节）`);
  return cached;
}

function chromeBinary() {
  for (const candidate of CHROME_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  throw new Error("找不到 Chrome/Chromium/Edge，无法离屏量几何");
}

/** 在 /tmp 造一个真实 vault：外部 profile JSON / .md / .base 都在盘上，设置里只登记路径。 */
function seedVault() {
  fs.rmSync(VAULT, { recursive: true, force: true });
  const write = (rel, text) => {
    const abs = path.join(VAULT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };
  const tec = JSON.parse(fs.readFileSync(path.join(REPO, "tools/example-profiles/two-profiles.json"), "utf8"))[0];
  const plate = JSON.parse(fs.readFileSync(path.join(REPO, "tools/example-profiles/plate-profile.json"), "utf8"))[0];
  write("Profiles/tecnaitem.json", `${JSON.stringify(tec, null, 2)}\n`);
  write("Profiles/Other/platewell.json", `${JSON.stringify(plate, null, 2)}\n`);
  write("Templates/meta.md", "{{frontmatter}}\n\n缩略图：{{thumbnail}}\n原图：{{tif}}\n");
  write("Templates/base.base", "views:\n  - type: cards\n    name: Layout {{folder}}\n    cardSize: {{cardSize}}\n");
  return {
    profileFiles: [{ path: "Profiles/tecnaitem.json" }, { path: "Profiles/Other/platewell.json" }],
    metadataTemplates: [{ id: "meta", name: "meta", path: "Templates/meta.md" }],
    baseTemplates: [{ id: "base", name: "base", path: "Templates/base.base" }],
  };
}

const VOID_TAGS = new Set(["INPUT", "BR", "HR", "IMG", "META", "LINK"]);
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FakeEl → HTML（option 的文字要留在标签里，否则下拉宽度量不准）。 */
function serialize(el, out) {
  const tag = el.tagName.toLowerCase();
  const cls = el.classes.length > 0 ? ` class="${esc(el.classes.join(" "))}"` : "";
  let attrs = "";
  for (const [key, value] of Object.entries(el.attributes)) attrs += ` ${key}="${esc(value)}"`;
  if (el.tagName === "TEXTAREA") attrs += ` rows="${el.rows ?? 0}"`;
  if (el.placeholder) attrs += ` placeholder="${esc(el.placeholder)}"`;
  out.push(`<${tag}${cls}${attrs}>`);
  if (VOID_TAGS.has(el.tagName)) return;
  if (el._text) out.push(esc(el._text));
  for (const child of el.children) serialize(child, out);
  out.push(`</${tag}>`);
}

/** 渲染真实设置页 DOM（外部文件模型）。 */
function renderFragment() {
  const Module = require("module");
  const stub = require(path.join(REPO, "tools", "obsidian-stub.cjs"));
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === "obsidian") return stub;
    return original.call(this, request, ...rest);
  };
  const PluginClass = require(path.join(REPO, "main.js")).default;
  const seeded = seedVault();
  const app = stub.makeApp(VAULT);
  const plugin = new PluginClass(app, { id: "annex-gallery", version: "0.0.0" });
  return (async () => {
    await plugin.onload();
    const tab = stub.registry.tabs[0];
    // 两条已登记外部 profile + 各一份外部 metadata / 画廊模板。
    Object.assign(plugin.settings, seeded);
    // 两行 remote：量「一个 item 装多条」时的行内布局
    plugin.settings.remotes = [
      { name: "origin", url: "ssh://nas.example/volume1/Data_lab_10" },
      { name: "backup", url: "/Volumes/Backup/Data_lab_10" },
    ];
    tab.update();
    const out = [];
    for (const child of tab.containerEl.children) serialize(child, out);
    return out.join("\n");
  })();
}

const MEASURE = String.raw`(function () {
  const num = (n) => Math.round(n * 100) / 100;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: num(b.left), right: num(b.right), top: num(b.top), bottom: num(b.bottom), width: num(b.width), height: num(b.height) }; };
  const text = (el) => (el ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 40) : null);
  const visible = (el) => el !== null && getComputedStyle(el).display !== "none";
  const pane = document.getElementById("pane");
  const settingRows = [...document.querySelectorAll(".setting-item:not(.setting-item-heading)")];
  const rowName = (row) => text(row.querySelector(":scope > .setting-item-info > .setting-item-name"));
  const settingRow = settingRows.find((row) => rowName(row) === "缩略图边长") ?? settingRows[0];
  const toolbar = document.querySelector(".annex-profiles-toolbar");
  const toolbarBox = box(toolbar);
  const profileRows = [...document.querySelectorAll(".annex-profile-row")];
  const templateCards = [...document.querySelectorAll(".annex-templates-card")];
  const templateInfo = templateCards.map((card) => {
    const rows = [...card.querySelectorAll(".annex-template-row")];
    const add = card.querySelector(".annex-template-add-row");
    return {
      kind: card.getAttribute("data-kind"),
      box: box(card),
      title: text(card.querySelector(".annex-templates-title")),
      hint: text(card.querySelector(".annex-templates-hint")),
      empty: card.querySelector(".annex-templates-empty") !== null,
      rows: rows.map((row) => ({
        box: box(row),
        state: row.getAttribute("data-state"),
        id: text(row.querySelector(".annex-template-id")),
        path: text(row.querySelector(".annex-template-path")),
        open: box(row.querySelector(".annex-template-open")),
        del: box(row.querySelector(".annex-template-del")),
        error: row.querySelector(".annex-template-error") !== null,
        wrap: getComputedStyle(row).flexWrap,
      })),
      add: add ? {
        box: box(add),
        wrap: getComputedStyle(add).flexWrap,
        input: box(add.querySelector(".annex-template-path-input")),
        button: box(add.querySelector(".annex-template-add")),
        select: box(add.querySelector(".annex-template-preset")),
      } : null,
    };
  });
  document.getElementById("report").textContent = "REPORT_JSON_BEGIN" + JSON.stringify({
    contentLeft: num(pane.getBoundingClientRect().left + parseFloat(getComputedStyle(pane).paddingLeft)),
    paneScrollWidth: pane.scrollWidth,
    paneClientWidth: pane.clientWidth,
    h1Count: document.querySelectorAll(".annex-settings-title").length,
    hrCount: pane.querySelectorAll("hr").length,
    settingRow: { name: settingRow ? rowName(settingRow) : null, box: box(settingRow), innerPadLeft: settingRow ? getComputedStyle(settingRow).paddingLeft : null },
    groups: [...pane.children].filter((c) => c.classList.contains("setting-group")).map((g) => {
      const header = g.querySelector(":scope > .setting-item-heading > .setting-item-name");
      const items = [...g.querySelectorAll(":scope > .setting-items > .setting-item")];
      return {
        cls: g.className,
        heading: text(header),
        display: getComputedStyle(g).display,
        box: box(g),
        items: items.map((s) => rowName(s)),
        renderRows: items.filter((s) => s.classList.contains("annex-editor-row")).length,
      };
    }),
    topLevel: [...pane.children].map((c) => ({ tag: c.tagName, cls: c.className, display: getComputedStyle(c).display, box: box(c), borderTopWidth: getComputedStyle(c).borderTopWidth })),
    toolbar: toolbar ? [...toolbar.children].filter(visible).map((c) => ({
      tag: c.tagName,
      cls: c.className,
      text: c.tagName === "SELECT" ? (c.options[0] ? c.options[0].text.trim() : "") : text(c),
      placeholder: c.getAttribute("placeholder"),
      box: box(c),
    })) : null,
    toolbarBox: toolbar ? { box: toolbarBox, justify: getComputedStyle(toolbar).justifyContent, wrap: getComputedStyle(toolbar).flexWrap } : null,
    profiles: {
      rows: profileRows.map((row) => ({
        box: box(row),
        state: row.getAttribute("data-state"),
        name: text(row.querySelector(".annex-profile-name")),
        id: text(row.querySelector(".annex-profile-id")),
        path: text(row.querySelector(".annex-profile-path")),
        nameBox: box(row.querySelector(".annex-profile-name")),
        pathBox: box(row.querySelector(".annex-profile-path")),
        open: box(row.querySelector(".annex-profile-open")),
        del: box(row.querySelector(".annex-profile-del")),
        error: row.querySelector(".annex-profile-error") !== null,
        wrap: getComputedStyle(row).flexWrap,
        borderTopWidth: getComputedStyle(row).borderTopWidth,
      })),
      oldCards: document.querySelectorAll(".annex-profile-card").length,
      oldActions: document.querySelectorAll(".annex-profile-actions").length,
      oldPreview: document.querySelectorAll(".annex-preview-filename").length + document.querySelectorAll(".annex-preview-result").length,
      oldJson: document.querySelectorAll(".annex-profile-json").length,
      oldStatus: document.querySelectorAll(".annex-profile-status").length,
    },
    templates: templateInfo,
    builtinRows: document.querySelectorAll(".annex-template-builtin").length,
    viewButtons: document.querySelectorAll(".annex-template-view-btn").length,
    copyButtons: document.querySelectorAll(".annex-template-copy").length,
    remotes: (() => {
      const card = document.querySelector(".annex-remotes-card");
      if (!card) return null;
      const title = card.querySelector(".annex-remotes-title");
      const rows = [...card.querySelectorAll(".annex-remote-row")];
      const add = card.querySelector(".annex-remote-add");
      return {
        card: box(card),
        cardPadLeft: getComputedStyle(card).paddingLeft,
        cardBorderLeft: getComputedStyle(card).borderLeftWidth,
        title: { text: text(title), box: box(title), pad: title ? getComputedStyle(title).paddingLeft : null },
        rows: rows.length,
        rowBoxes: rows.map((r) => ({ box: box(r), name: box(r.querySelector(".annex-remote-name")), url: box(r.querySelector(".annex-remote-url")), del: box(r.querySelector(".annex-remote-del")) })),
        addButton: { text: add ? add.textContent.trim() : null, box: box(add) },
      };
    })(),
  }, null, 1) + "REPORT_JSON_END";
})();`;

const PAGE = (fragment) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="plugin-styles.css">
</head>
<body class="theme-dark">
<div class="modal-container mod-dim">
  <div class="modal mod-settings" style="width:1000px;height:800px;display:flex;flex-direction:row;">
    <div class="vertical-tab-header" style="flex:0 0 250px;"></div>
    <div class="vertical-tab-content-container">
      <div class="vertical-tab-content" id="pane">
${fragment}
      </div>
    </div>
  </div>
</div>
<pre id="report">报告未生成</pre>
<script>${MEASURE}</script>
</body></html>
`;

(async () => {
  const showJson = process.argv.includes("--json");
  fs.mkdirSync(CACHE, { recursive: true });
  const appCss = ensureAppCss();
  const fragment = await renderFragment();

  // app.css 摆在量测台旁边（页面用相对路径引它）
  const pageDir = path.join(CACHE, "page");
  fs.mkdirSync(pageDir, { recursive: true });
  fs.copyFileSync(appCss, path.join(pageDir, "app.css"));
  fs.copyFileSync(path.join(REPO, "styles.css"), path.join(pageDir, "plugin-styles.css"));
  const page = path.join(pageDir, "layout.html");
  fs.writeFileSync(page, PAGE(fragment), "utf8");

  const dom = execFileSync(
    chromeBinary(),
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--window-size=1440,900", "--virtual-time-budget=4000", "--dump-dom", `file://${page}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const start = dom.indexOf("REPORT_JSON_BEGIN");
  const end = dom.indexOf("REPORT_JSON_END");
  if (start < 0) throw new Error("页面没产出几何报告（Chrome 没跑起来？）");
  const rep = JSON.parse(dom.slice(start + "REPORT_JSON_BEGIN".length, end));
  if (showJson) console.log(JSON.stringify(rep, null, 1));

  const contentLeft = rep.contentLeft;

  console.log("\n设置页布局检查（真实 app.css + 真实 DOM + headless Chromium）");
  console.log(`  内容左边缘=${contentLeft}  「缩略图边长」行左=${rep.settingRow.box.left}（行内 padding ${rep.settingRow.innerPadLeft}）  顶层 group=${rep.groups.length}`);

  // ── 声明式顶层：没有 h1 / hr，三个 group ───────────────────────────────────
  check(rep.h1Count === 0, "设置页没有旧的 h1 标题（声明式 API 不再渲染页面标题）");
  check(rep.hrCount === 0, "设置页没有 hr 分割线（改用 group heading）");
  check(rep.topLevel.length === 3 && rep.groups.length === 3, `顶层 = 3 个 .setting-group：${rep.topLevel.length}`, rep.topLevel.map((t) => t.cls).join(" | "));
  check(rep.groups.every((g) => g.display !== "none" && g.box.height > 0), "三个 group 都可见");
  check(rep.groups[0].heading === null || rep.groups[0].heading === "", "第一个 group 没有 heading（remote 卡片自带标题）", String(rep.groups[0].heading));
  check(rep.groups[1].heading === "文件名匹配模板与模板", "第二个 group 的 heading = 文件名匹配模板与模板", String(rep.groups[1].heading));
  check(rep.groups[2].heading === "常规", "第三个 group 的 heading = 常规", String(rep.groups[2].heading));
  check(rep.groups[2].items.join(",") === "缩略图边长,调试日志", "常规 group 里是两个普通设置项（缩略图边长 / 调试日志）", rep.groups[2].items.join(" | "));
  check(rep.groups[0].renderRows === 1 && rep.groups[1].renderRows === 2, "三个编辑器都挂在 render 行里（remote 1 + 模板 2）", JSON.stringify(rep.groups.map((g) => g.renderRows)));
  check(rep.settingRow.box !== null && Math.abs(rep.settingRow.box.left - rep.groups[2].box.left) < 2, "「缩略图边长」行贴住所属 group 的左边缘", `行=${rep.settingRow.box.left} group=${rep.groups[2].box.left}`);

  // ── remote 设置：一个 item 装多条 ─────────────────────────────────────────
  const remotes = rep.remotes;
  check(remotes !== null && remotes.title.text === "remote 设置", "最上方那一项的标题 = remote 设置", remotes === null ? "(缺)" : remotes.title.text);
  check(remotes !== null && Math.abs(remotes.card.left - rep.groups[0].box.left) < 2, "remote 卡片与第一个 group 左对齐", remotes === null ? "(缺)" : `卡片=${remotes.card.left} group=${rep.groups[0].box.left}`);
  check(remotes.rows === 2, "同一个 item 里装了 2 条 remote");
  check(remotes.title.pad === "0px", "remote 设置的标题自己不带 padding（不做无谓缩进）");
  const cardInnerLeft = remotes.card.left + parseFloat(remotes.cardBorderLeft) + parseFloat(remotes.cardPadLeft);
  check(Math.abs(remotes.title.box.left - cardInnerLeft) < 0.5, "remote 设置的标题与卡片内容左边缘对齐（缩进只来自卡片自己的 padding）", `标题 left=${remotes.title.box.left} vs 卡片内容左=${cardInnerLeft}`);
  check(Math.abs(remotes.card.left - contentLeft) < 0.5, "remote 设置整块与内容左边缘对齐");
  const [row0, row1] = remotes.rowBoxes;
  check(row1.box.top > row0.box.top, "两行 remote 上下排列（第 2 行在第 1 行下面）");
  check(row0.name.left < row0.url.left && row0.url.left < row0.del.left, "行内从左往右 = 名称 → 地址 → 删除", `${row0.name.left} / ${row0.url.left} / ${row0.del.left}`);
  check(row0.url.width > row0.name.width, "地址那一格比名称宽（地址更长）", `${row0.url.width} vs ${row0.name.width}`);
  check(row0.del.right <= remotes.card.right + 0.5, "「删除」没有溢出卡片");
  check(remotes.addButton.text === "添加 remote", "列表下方是「添加 remote」");
  check(Math.abs(remotes.addButton.box.left - remotes.title.box.left) < 0.5, "「添加 remote」与标题左对齐");
  check(remotes.addButton.box.top > row1.box.top, "「添加 remote」在两行 remote 下面");

  // ── 文件名匹配模板：外部 JSON 工具条 + 每文件一行 ─────────────────────────
  check(rep.toolbar.length === 3, "工具条只有 3 个控件（路径输入 / 登记 / 从预设创建）", `${rep.toolbar.length} 个`);
  check(rep.toolbar[0].tag === "INPUT" && /profile JSON 路径/.test(rep.toolbar[0].placeholder ?? ""), "第 1 格是 vault 相对路径输入框");
  check(rep.toolbar[1].tag === "BUTTON" && rep.toolbar[1].text === "登记", "第 2 格是「登记」按钮");
  check(rep.toolbar[2].tag === "SELECT" && rep.toolbar[2].text === "从预设创建…", "第 3 格是「从预设创建…」下拉");
  check(rep.toolbar[0].box.left < rep.toolbar[1].box.left && rep.toolbar[1].box.left < rep.toolbar[2].box.left, "三个控件真的从左往右排");
  check(rep.toolbarBox.wrap === "wrap", "工具条允许换行（flex-wrap: wrap，窄窗口不撑破）");
  check(["normal", "flex-start", "start"].includes(rep.toolbarBox.justify), "工具条左对齐（默认/显式 flex-start 均可）", rep.toolbarBox.justify);
  const toolCenters = rep.toolbar.map((c) => c.box.top + c.box.height / 2);
  check(Math.max(...toolCenters) - Math.min(...toolCenters) < 1, "三个控件垂直居中对齐（同一行）", toolCenters.join(" / "));
  check(Math.abs(rep.toolbar[0].box.left - rep.toolbarBox.box.left) < 1, "输入框贴住工具条左边缘");
  check(rep.toolbar[0].box.width > rep.toolbar[1].box.width + rep.toolbar[2].box.width, "输入框占据剩余宽度，是工具条里最宽的一格", `${rep.toolbar[0].box.width} vs ${rep.toolbar[1].box.width}+${rep.toolbar[2].box.width}`);
  check(Math.abs(rep.toolbar[2].box.right - rep.toolbarBox.box.right) < 1, "预设下拉贴住工具条右边缘", `${rep.toolbar[2].box.right} vs ${rep.toolbarBox.box.right}`);

  check(rep.profiles.rows.length === 2, "每条已登记外部 JSON 各一行（2 条）");
  check(rep.profiles.oldCards === 0 && rep.profiles.oldActions === 0 && rep.profiles.oldPreview === 0 && rep.profiles.oldJson === 0 && rep.profiles.oldStatus === 0,
    "没有旧的内联卡片 / 动作排 / 解析预览 / JSON textarea / 状态胶囊",
    JSON.stringify({ cards: rep.profiles.oldCards, actions: rep.profiles.oldActions, preview: rep.profiles.oldPreview, json: rep.profiles.oldJson, status: rep.profiles.oldStatus }));
  const [pr0, pr1] = rep.profiles.rows;
  check(pr0.state === "ok" && pr1.state === "ok", "两条已登记 profile 都成功读到（data-state=ok）");
  check(/^id: /.test(pr0.id) && pr0.id.includes("tecnaitem"), "行上显示外部 JSON 的 id", pr0.id);
  check(pr0.path === "Profiles/tecnaitem.json" && pr1.path === "Profiles/Other/platewell.json", "行上显示 vault 相对路径", `${pr0.path} / ${pr1.path}`);
  check(pr0.nameBox.left < pr0.pathBox.left && pr0.open.left > pr0.pathBox.right - 0.5, "行内先 name/id/path，再排「打开」「删除」", `${pr0.nameBox.left} / ${pr0.pathBox.left}..${pr0.pathBox.right} / ${pr0.open.left}`);
  check(pr0.del.top > pr0.open.top || pr0.del.left > pr0.open.left, "「删除」在「打开」之后（行内换行时落到下一行也算）", `open=${pr0.open.left}@${pr0.open.top} del=${pr0.del.left}@${pr0.del.top}`);
  check(pr0.wrap === "wrap", "profile 行允许换行（窄窗口不溢出）");
  check(pr0.borderTopWidth === "1px", "每行有可见边框（一行一份外部文件）");
  check(pr0.open.right <= pr0.box.right + 0.5 && pr0.del.right <= pr0.box.right + 0.5, "行内按钮没有溢出本行");
  check(pr1.box.top > pr0.box.top, "两行上下排列");
  check(Math.abs(pr0.box.left - contentLeft) < 0.5 && Math.abs(pr0.box.width - rep.toolbarBox.box.width) < 1, "profile 行与工具条同宽、同左边缘");

  // ── metadata / 画廊模板卡片：一行一个外部文件 ──────────────────────────────
  check(rep.templates.length === 2, "模板区有 2 张卡片");
  check(rep.templates.map((c) => c.kind).join(",") === "metadata,base", "卡片依次 = metadata / base");
  check(rep.templates[0].title === "metadata 模板" && rep.templates[1].title === "画廊模板", "两张卡片标题正确");
  check(rep.templates.every((c) => c.hint !== null && c.hint.length > 10), "两张卡片都有使用说明");
  check(rep.builtinRows === 0 && rep.viewButtons === 0 && rep.copyButtons === 0, "没有内置模板行 / 查看 / 复制为自定义", JSON.stringify({ builtin: rep.builtinRows, view: rep.viewButtons, copy: rep.copyButtons }));
  check(rep.templates.every((c) => !c.empty && c.rows.length === 1), "两张卡片各显示 1 行已登记外部文件");
  check(rep.templates[0].box.top < rep.templates[1].box.top, "metadata 卡片在画廊模板卡片上面");
  check(Math.abs(rep.templates[0].box.left - contentLeft) < 0.5 && Math.abs(rep.templates[0].box.width - rep.toolbarBox.box.width) < 1, "模板卡片与工具条同宽、同左边缘");
  for (const card of rep.templates) {
    const row = card.rows[0];
    check(row.state === "ok" && !row.error, `${card.kind} 行成功读到（data-state=ok）`);
    check(row.id === `id: ${card.kind === "metadata" ? "meta" : "base"}`, `${card.kind} 行显示 id`, row.id);
    check(row.oldPath === undefined && row.path === (card.kind === "metadata" ? "Templates/meta.md" : "Templates/base.base"), `${card.kind} 行显示 vault 相对路径`, row.path);
    check(row.open.left < row.del.left && row.del.right <= row.box.right + 0.5, `${card.kind} 行尾 = 打开 → 删除，且不溢出`);
    check(card.add !== null && card.add.input.left < card.add.button.left && card.add.button.left < card.add.select.left, `${card.kind} 登记行从左往右 = 路径输入 → 登记 → 从预设创建`);
    check(Math.abs(card.add.input.left - card.box.left - 16) < 1, `${card.kind} 登记行贴住卡片内容左边缘`);
    check(card.add.wrap === "wrap", `${card.kind} 登记行允许换行（窄窗口不溢出）`);
    check(card.add.box.bottom <= card.box.bottom + 0.5, `${card.kind} 登记行在卡片内`);
  }

  check(rep.paneScrollWidth <= rep.paneClientWidth, "没有横向溢出（内容放得下）", `${rep.paneScrollWidth} > ${rep.paneClientWidth}`);

  console.log(`\nLAYOUT PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("LAYOUT OK");
})().catch((error) => {
  console.error("LAYOUT CHECK FAILED:", error);
  process.exit(1);
});
