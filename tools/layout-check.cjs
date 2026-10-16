#!/usr/bin/env node
/**
 * 设置页布局回归检查（离屏量法，不需要人眼看截图，也不需要重启 Obsidian）。
 *
 *   node tools/layout-check.cjs            # 量现在的 styles.css，按 spec 断言
 *   node tools/layout-check.cjs --json     # 另把原始几何打出来
 *
 * 为什么能信：三样东西都是真的 ——
 *   ① 真实 app.css：从本机 `~/Library/Application Support/obsidian/obsidian-<ver>.asar` 里抽出来的
 *      官方样式表（规格里那些 `--size-4-*` / `.setting-item` / `.vertical-tab-content h1` 规则都来自它）；
 *   ② 真实 DOM：用 tools/obsidian-stub.cjs 跑构建产物 main.js，`tab.display()` 出来的那棵树；
 *   ③ 真实引擎：headless Chromium（本机 Chrome）算的几何。
 *
 * 它验证的是 spec（docs/setting-panel.md）里能变成数字的那几条：标题可见且与左侧对齐、解析结果带边框、
 * 示例文件名全宽、动作按钮右对齐且从右往左读是「保存、复制、打开、删除」、分割线在卡片与普通设置项之间。
 * 观感（配色、间距好不好看）仍然要人眼在真机上看一眼 —— 这个脚本只负责「结构塌了没有」。
 *
 * 依赖：本机有 Chrome / Chromium / Edge 之一（自动找）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CACHE = path.join(os.tmpdir(), "annex-gallery-layout");
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

/** 渲染真实设置页 DOM。 */
function renderFragment() {
  const Module = require("module");
  const stub = require(path.join(REPO, "tools", "obsidian-stub.cjs"));
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === "obsidian") return stub;
    return original.call(this, request, ...rest);
  };
  const PluginClass = require(path.join(REPO, "main.js")).default;
  const app = stub.makeApp("/tmp/layout-check-vault");
  const plugin = new PluginClass(app, { id: "annex-gallery", version: "0.0.0" });
  return (async () => {
    await plugin.onload();
    const tab = stub.registry.tabs[0];
    // 两行 remote：量「一个 item 装多条」时的行内布局
    plugin.settings.remotes = [
      { name: "origin", url: "ssh://nas.example/volume1/Data_lab_10" },
      { name: "backup", url: "/Volumes/Backup/Data_lab_10" },
    ];
    tab.display();
    const filename = stub.walk(tab.containerEl).filter((el) => el.hasClass("annex-preview-filename"))[0];
    filename.value = "12345X-5705-0015.tif";
    filename.dispatchEvent({ type: "input" });
    const out = [];
    for (const child of tab.containerEl.children) serialize(child, out);
    return out.join("\n");
  })();
}

const MEASURE = String.raw`(function () {
  const num = (n) => Math.round(n * 100) / 100;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: num(b.left), right: num(b.right), top: num(b.top), width: num(b.width), height: num(b.height) }; };
  const cs = (el, props) => { if (!el) return null; const s = getComputedStyle(el); const o = {}; for (const p of props) o[p] = s[p]; return o; };
  const text = (el) => (el ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 30) : null);
  const pane = document.getElementById("pane");
  const h1 = document.querySelector(".annex-settings-title");
  const card = document.querySelector(".annex-profile-card");
  const row = document.querySelector(".setting-item");
  const actions = [...document.querySelectorAll(".annex-profile-actions button")];
  const result = document.querySelector(".annex-preview-result");
  document.getElementById("report").textContent = "REPORT_JSON_BEGIN" + JSON.stringify({
    contentLeft: num(pane.getBoundingClientRect().left + parseFloat(getComputedStyle(pane).paddingLeft)),
    paneScrollWidth: pane.scrollWidth,
    paneClientWidth: pane.clientWidth,
    h1: { box: box(h1), display: h1 ? getComputedStyle(h1).display : null, text: text(h1), pad: cs(h1, ["paddingLeft", "paddingRight"]), marginTop: h1 ? getComputedStyle(h1).marginTop : null, fontSize: h1 ? getComputedStyle(h1).fontSize : null },
    card: box(card),
    settingRow: { box: box(row), innerPadLeft: row ? getComputedStyle(row).paddingLeft : null },
    topLevel: [...pane.children].map((c) => ({ tag: c.tagName, cls: c.className, display: getComputedStyle(c).display, box: box(c), borderTopWidth: getComputedStyle(c).borderTopWidth })),
    toolbar: (() => { const t = document.querySelector(".annex-profiles-toolbar"); return t ? [...t.children].filter((c) => getComputedStyle(c).display !== "none").map((c) => ({ tag: c.tagName, label: c.tagName === "SELECT" ? (c.options[0] ? c.options[0].text.trim() : "") : text(c), cls: c.className, box: box(c) })) : null; })(),
    toolbarBox: (() => { const t = document.querySelector(".annex-profiles-toolbar"); return t ? { box: box(t), justify: getComputedStyle(t).justifyContent, wrap: getComputedStyle(t).flexWrap } : null; })(),
    filename: (() => { const i = document.querySelector(".annex-preview-filename"); return i ? { box: box(i), width: getComputedStyle(i).width } : null; })(),
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
        title: { text: title ? title.textContent.trim() : null, box: box(title), pad: title ? getComputedStyle(title).paddingLeft : null, fontSize: title ? getComputedStyle(title).fontSize : null },
        rows: rows.length,
        rowBoxes: rows.map((r) => ({ box: box(r), name: box(r.querySelector(".annex-remote-name")), url: box(r.querySelector(".annex-remote-url")), del: box(r.querySelector(".annex-remote-del")), note: r.querySelector(".annex-remote-note") ? r.querySelector(".annex-remote-note").textContent.trim() : "" })),
        addButton: { text: add ? add.textContent.trim() : null, box: box(add) },
      };
    })(),
    result: result ? { box: box(result), border: cs(result, ["borderTopWidth", "borderTopStyle", "paddingLeft"]), rows: [...result.querySelectorAll(".annex-preview-row")].map((r) => text(r)) } : null,
    actions: (() => { const a = document.querySelector(".annex-profile-actions"); return a ? { justify: getComputedStyle(a).justifyContent, box: box(a), cardInnerRight: num(card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight) - parseFloat(getComputedStyle(card).borderRightWidth)), buttons: actions.map((b) => ({ label: text(b), box: box(b) })) } : null; })(),
    status: cs(document.querySelector(".annex-profile-status"), ["display", "marginLeft"]),
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
  const h1Left = rep.h1.box === null ? null : rep.h1.box.left;
  const cardLeft = rep.card.left;
  const btns = rep.actions.buttons;

  console.log("\n设置页布局检查（真实 app.css + 真实 DOM + headless Chromium）");
  console.log(`  内容左边缘=${contentLeft}  标题左=${h1Left}  卡片左=${cardLeft}  「缩略图边长」行左=${rep.settingRow.box.left}（行内 padding ${rep.settingRow.innerPadLeft}）`);

  check(rep.h1.display !== "none" && rep.h1.box.height > 0, "标题 h1 真的可见（app.css 有 .vertical-tab-content h1{display:none}，必须被压掉）", `display=${rep.h1.display}`);
  check(rep.h1.text === "Annex Gallery Settings", "标题文本 = Annex Gallery Settings");
  check(h1Left !== null && Math.abs(h1Left - contentLeft) < 0.5, "标题与左侧内容左对齐（padding 0，不是 app 的 16px）", `标题 left=${h1Left} vs 内容左=${contentLeft}`);
  check(rep.h1.pad.paddingLeft === "0px" && rep.h1.pad.paddingRight === "0px", "标题左右 padding 都是 0");
  check(rep.h1.marginTop === "0px", "标题没有上边距（贴住内容区顶部的 padding）");
  check(rep.topLevel.map((t) => t.cls.split(" ")[0]).join(",") === "annex-settings-title,annex-remotes-section,annex-remotes-divider,annex-profiles-section,annex-settings-divider,setting-item", "顶层顺序 = 标题 → remote 设置 → 分割线 → 模版设置 → 分割线 → 缩略图边长", rep.topLevel.map((t) => t.cls).join(" | "));
  check(rep.topLevel[5].display === "flex", "最后一项是 app 的 .setting-item（缩略图边长）");
  const dividers = rep.topLevel.filter((t) => t.tag === "HR");
  check(dividers.length === 2, `两条分割线（remote/模版 之间 + 模版/普通设置项 之间）：${dividers.length} 条`);
  check(dividers.every((d) => d.display !== "none" && d.box.width > 100 && d.box.height > 0 && d.borderTopWidth === "1px"),
    "两条分割线都可见、撑满内容宽、1px 上边框", JSON.stringify(dividers.map((d) => ({ w: d.box.width, h: d.box.height, bt: d.borderTopWidth }))));
  check(rep.remotes.card.top + rep.remotes.card.height <= dividers[0].box.top && dividers[0].box.top + dividers[0].box.height <= rep.toolbarBox.box.top,
    "上面那条分割线真的夹在 remote 卡片与工具条之间", `card 底=${rep.remotes.card.top + rep.remotes.card.height} 线=${dividers[0].box.top} 工具条=${rep.toolbarBox.box.top}`);

  // 「remote 设置」：一个 item 装多条，逐条量行内布局
  const remotes = rep.remotes;
  check(remotes !== null && remotes.title.text === "remote 设置", "最上方那一项的标题 = remote 设置", remotes === null ? "(缺)" : remotes.title.text);
  check(remotes.rows === 2, "同一个 item 里装了 2 条 remote");
  check(remotes.title.pad === "0px", "remote 设置的标题自己不带 padding（不做无谓缩进）");
  const cardInnerLeft = remotes.card.left + parseFloat(remotes.cardBorderLeft) + parseFloat(remotes.cardPadLeft);
  check(Math.abs(remotes.title.box.left - cardInnerLeft) < 0.5, "remote 设置的标题与卡片内容左边缘对齐（缩进只来自卡片自己的 padding）", `标题 left=${remotes.title.box.left} vs 卡片内容左=${cardInnerLeft}`);
  check(Math.abs(remotes.card.left - contentLeft) < 0.5, "remote 设置整块与内容左边缘对齐");
  check(remotes.card.right <= contentLeft + remotes.card.width + 0.5 && remotes.card.width > 0, "remote 设置整块有宽度（是卡片，不是塌成 0）");
  const [row0, row1] = remotes.rowBoxes;
  check(row1.box.top > row0.box.top, "两行 remote 上下排列（第 2 行在第 1 行下面）");
  check(row0.name.left < row0.url.left && row0.url.left < row0.del.left, "行内从左往右 = 名称 → 地址 → 删除", `${row0.name.left} / ${row0.url.left} / ${row0.del.left}`);
  check(row0.url.width > row0.name.width, "地址那一格比名称宽（地址更长）", `${row0.url.width} vs ${row0.name.width}`);
  check(row0.del.right <= remotes.card.right + 0.5, "「删除」没有溢出卡片");
  check(remotes.addButton.text === "添加 remote", "列表下方是「添加 remote」");
  check(Math.abs(remotes.addButton.box.left - remotes.title.box.left) < 0.5, "「添加 remote」与标题左对齐");
  check(remotes.addButton.box.top > row1.box.top, "「添加 remote」在两行 remote 下面");
  check(
    rep.toolbar.map((c) => c.label).join(",") === "新模版,导入模版,添加预设…",
    "工具条从左往右 = 新模版、导入模版、添加预设（下拉）",
    rep.toolbar.map((c) => `${c.tag}:${c.label}`).join(" | "),
  );
  check(rep.toolbar[2].tag === "SELECT", "第三个控件是下拉选框（select）");
  check(rep.toolbar[0].box.left < rep.toolbar[1].box.left && rep.toolbar[1].box.left < rep.toolbar[2].box.left, "三个控件真的从左往右排");
  check(rep.toolbarBox.wrap === "nowrap", "工具条不换行（flex-wrap: nowrap）");
  check(rep.toolbarBox.justify === "flex-start", "工具条左对齐（justify-content: flex-start）");
  const toolTops = rep.toolbar.map((c) => c.box.top);
  check(Math.max(...toolTops) - Math.min(...toolTops) < 1, "三个控件在同一行（top 一致）", toolTops.join(" / "));
  check(Math.abs(rep.toolbar[0].box.left - rep.toolbarBox.box.left) < 1, "「新模版」贴住工具条左边缘（按钮靠左）", `${rep.toolbar[0].box.left} vs ${rep.toolbarBox.box.left}`);
  check(Math.abs(rep.toolbar[2].box.right - rep.toolbarBox.box.right) < 1, "「添加预设」下拉贴住工具条右边缘（下拉靠右）", `${rep.toolbar[2].box.right} vs ${rep.toolbarBox.box.right}`);
  check(rep.toolbar[1].box.right < rep.toolbar[2].box.left - 40, "按钮组与下拉之间留出空隙（左一组、右一个）", `${rep.toolbar[1].box.right} → ${rep.toolbar[2].box.left}`);
  check(Math.abs(rep.filename.width.replace("px", "") - (rep.card.right - rep.card.left - 2 * parseFloat(rep.result.border.paddingLeft) - 2)) < 40, "示例文件名占满卡片内宽", `输入框 ${rep.filename.width} vs 卡片内容宽`);
  check(rep.result.border.borderTopWidth === "1px" && rep.result.border.borderTopStyle === "solid", "解析结果是带边框的一块");
  check(rep.result.rows.length > 0, `解析结果每行一条解析：${rep.result.rows.join(" / ")}`);
  check(rep.actions.justify === "flex-end", "动作按钮整排贴右下角（justify-content: flex-end）");
  check(
    btns.map((b) => b.label).join(",") === "删除,打开,复制,保存",
    "动作按钮 DOM 顺序 删除→打开→复制→保存（从右往左读 = 保存、复制、打开、删除）",
    btns.map((b) => b.label).join(" | "),
  );
  check(btns[3].box.left > btns[2].box.left && btns[2].box.left > btns[1].box.left && btns[1].box.left > btns[0].box.left, "四个按钮真的从左往右排（保存最右）");
  check(Math.abs(btns[3].box.right - rep.actions.cardInnerRight) < 1.5, "最右的「保存」贴住卡片右下角", `保存右边缘=${btns[3].box.right} vs 卡片内容右=${rep.actions.cardInnerRight}`);
  check(Math.abs(cardLeft - contentLeft) < 0.5, "卡片与内容左边缘对齐");
  check(rep.paneScrollWidth <= rep.paneClientWidth, "没有横向溢出（内容放得下）");

  console.log(`\nLAYOUT PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("LAYOUT OK");
})().catch((error) => {
  console.error("LAYOUT CHECK FAILED:", error);
  process.exit(1);
});
