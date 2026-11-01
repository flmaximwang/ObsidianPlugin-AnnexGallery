#!/usr/bin/env node
/**
 * 「创建画廊 / Create Gallery」+ 元数据预设的端到端校验（ticket qij 后的口径）。
 *
 * 在一个临时 vault（也是 git 仓库）里造出图片、元数据预设与手写 sidecar，用构建好的 CLI 跑：
 *
 *   A. `sidecar`：预设的 `frontmatter` 字典决定一切 —— 键顺序 = JSON 书写顺序、tags 是列表且
 *      第一项是 annex-gallery-metadata；正文来自预设 `template` 指向的 vault `.md`；
 *      正文里取不到值的占位符留空 + detail 提示；正文模板自带 frontmatter ⇒ 非零退出、点名文件、不写盘。
 *   B. 预设缺 tags ⇒ validator error，`sidecar` 在写盘前停下（不再隐式注入标签）。
 *   C. `gallery` dry-run：图片 / 已打标签 / 旧 sidecar / 缺 sidecar / 缺缩略图的盘点口径，
 *      README.md 不算；properties 按预设 frontmatter 的键顺序排；不写盘。
 *   D. `--apply --fix-tags`：只给旧 sidecar 插入 tags 行，其余字节不动。
 *   E. 默认 .base：filters.and / cards 视图 / cardSize / order / 目标路径；重复 apply 的保护与 --overwrite。
 *   F. 自定义 .base：模板自己的 filters 并进 and（收窄），{{properties}} 按预设 frontmatter 键顺序排。
 *   G. 坏 .base 模板（YAML 解析失败 / 没有 views）：非零退出并点名模板文件。
 *
 *   node tools/verify-gallery.cjs
 *
 * width/height 要 ImageMagick（`magick`）；缺它时打印 SKIP 并以 0 退出
 * （与 verify-sidecar-overwrite.cjs 同口径）。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse: parseYaml } = require("yaml");

const repo = path.resolve(__dirname, "..");
// 构建产物平时在 tools/annex-gallery.mjs；用 ANNEX_CLI 指向临时构建来冒烟测试（与 smoke-test 的 ANNEX_SMOKE_MAIN 同口径）。
const cli = process.env.ANNEX_CLI ?? path.join(repo, "tools", "annex-gallery.mjs");

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

/** 跑 CLI，返回 { status, stdout, stderr }（预期失败的用例自己看 status）。 */
function runCli(args) {
  return sh(process.execPath, [cli, ...args]);
}

function runCliJson(args) {
  const r = runCli(args);
  if (r.status !== 0) throw new Error(`CLI ${args.join(" ")} 退出码 ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  if (r.stdout.trim() === "") throw new Error(`CLI ${args.join(" ")} 没有输出\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `---` frontmatter 结束之后的那段（含结束行的换行）。 */
function bodyOf(text) {
  const idx = text.indexOf("\n---\n");
  return idx === -1 ? text : text.slice(idx + 5);
}

/** 递归收集 YAML 结构里的字符串（断言自定义 filter 被并进了 and 树）。 */
function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

// 1x1 PNG（ImageMagick 能 identify 的最小合法 PNG 之一）；不依赖 magick 造图。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function hasMagick() {
  return sh("magick", ["-version"]).status === 0 || sh("magick", ["--version"]).status === 0;
}

/** 一份最小的合法预设（frontmatter 字典 + 可选正文模板路径）。 */
function presetOf(overrides = {}) {
  return {
    id: "verify",
    name: "验证用（<放大倍数>X-<标记>-<序号>）",
    source: "stem",
    regex: "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
    types: { magnification: "number", index: "number" },
    ask: ["sample"],
    onMismatch: "empty",
    frontmatter: {
      tags: ["annex-gallery-metadata", "{{tags}}"],
      sample: "{{sample}}",
      magnification: "{{magnification}}",
      index: "{{index}}",
      thumbnail: "{{thumbnail}}",
      tif: "{{tif}}",
    },
    ...overrides,
  };
}

async function main() {
  if (!hasMagick()) {
    console.log("SKIP：这台机器上没有 ImageMagick（`magick`），width/height 生成不了，跳过。");
    return;
  }

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "verify-gallery-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-gallery-cwd-"));
  try {
    git(["init", "-q", "."], vault);
    console.log(`临时 vault ${vault}\n临时预设目录 ${cwd}`);

    // 预设与正文模板都放进 vault（template 是 vault 相对路径）。
    write(path.join(vault, "AnnexGalleryTemplates", "verify.md"), "\n缩略图：{{thumbnail}}\n\n原图（用系统默认程序打开）：{{tif}}\n");
    const preset = path.join(cwd, "verify.json");
    write(preset, `${JSON.stringify(presetOf({ template: "AnnexGalleryTemplates/verify.md" }), null, 2)}\n`);

    // ── A. sidecar：frontmatter 来自字典，tags 第一项是 gallery 标签 ──────
    console.log("\n[sidecar] frontmatter 字典 + tags");
    const src = path.join(vault, "src");
    write(path.join(src, "1000X-a-01.png"), PNG_1X1);
    const defaultRun = runCliJson(["sidecar", src, "--vault", vault, "--preset", preset, "--sample", "verify", "--apply", "--json"]);
    check(defaultRun.entries[0].action === "created", "--apply 写出了预设驱动的 sidecar");
    const defaultText = read(path.join(src, "1000X-a-01.md"));
    check(
      /^---\ntags:\n {2}- "annex-gallery-metadata"\n {2}- "src"\n/m.test(defaultText),
      "frontmatter 第一项是 tags，且第一项是 annex-gallery-metadata",
    );
    check(/^magnification: 1000$/m.test(defaultText), "magnification 按 types=number 写成裸数字");
    check(/^index: 1$/m.test(defaultText), "index 按 types=number 写成裸数字");
    check(/^sample: "verify"$/m.test(defaultText), "sample 是双引号字符串");
    check(/^thumbnail: "\[\[src\/1000X-a-01\.thumbnail\.png\]\]"$/m.test(defaultText), "thumbnail 写全 vault 路径");
    check(/^tif: "\[\[src\/1000X-a-01\.png\]\]"$/m.test(defaultText), "tif 写全 vault 路径");

    // ── A. 正文来自预设的 template ───────────────────────────────────────
    console.log("\n[sidecar] 正文来自预设的 template");
    const expectedBody = "\n缩略图：[[src/1000X-a-01.thumbnail.png]]\n\n原图（用系统默认程序打开）：[[src/1000X-a-01.png]]\n";
    check(bodyOf(defaultText) === expectedBody, "正文 = 预设 template 指向的 vault `.md`，逐字节一致");

    // 换一份正文模板 ⇒ 只重算正文（--overwrite）。
    const embedPreset = path.join(cwd, "embed.json");
    write(path.join(vault, "AnnexGalleryTemplates", "embed.md"), "\n![[src/1000X-a-01.thumbnail.png]]\n\n原图（用系统默认程序打开）：{{tif}}\n");
    write(embedPreset, `${JSON.stringify(presetOf({ id: "embed", template: "AnnexGalleryTemplates/embed.md" }), null, 2)}\n`);
    runCliJson(["sidecar", src, "--vault", vault, "--preset", embedPreset, "--sample", "verify", "--apply", "--overwrite", "--json"]);
    const embedText = read(path.join(src, "1000X-a-01.md"));
    check(
      bodyOf(embedText) === "\n![[src/1000X-a-01.thumbnail.png]]\n\n原图（用系统默认程序打开）：[[src/1000X-a-01.png]]\n",
      "换 preset 的 template ⇒ 正文换成 ![[…thumbnail.png]] 嵌入",
    );

    // ── A. 正文里取不到值的占位符 ⇒ 留空 + detail ────────────────────────
    console.log("\n[sidecar] 正文缺占位符");
    const notesPreset = path.join(cwd, "notes.json");
    const notesBody = path.join(vault, "AnnexGalleryTemplates", "notes.md");
    write(notesBody, "\n笔记：{{notes}}\n");
    write(notesPreset, `${JSON.stringify(presetOf({ id: "notes", template: "AnnexGalleryTemplates/notes.md" }), null, 2)}\n`);
    const src4 = path.join(vault, "src4");
    write(path.join(src4, "1000X-a-01.png"), PNG_1X1);
    const notesRun = runCliJson(["sidecar", src4, "--vault", vault, "--preset", notesPreset, "--sample", "verify", "--apply", "--json"]);
    check(
      /模板里的 \{\{notes\}\} 取不到值，已留空/.test(notesRun.entries[0].detail ?? ""),
      "report detail 写明 {{notes}} 取不到值、已留空",
    );
    check(/\n笔记：\n$/.test(read(path.join(src4, "1000X-a-01.md"))), "文件里 {{notes}} 被替换成空串");

    // ── A. 正文模板自带 frontmatter ⇒ 退出 1、点名文件、不写盘 ────────────
    console.log("\n[sidecar] 坏正文模板（自带 frontmatter）");
    write(path.join(vault, "AnnexGalleryTemplates", "bad.md"), "---\ntitle: x\n---\n正文\n");
    const badPreset = path.join(cwd, "bad-body.json");
    write(badPreset, `${JSON.stringify(presetOf({ id: "bad-body", template: "AnnexGalleryTemplates/bad.md" }), null, 2)}\n`);
    const src5 = path.join(vault, "src5");
    write(path.join(src5, "1000X-a-01.png"), PNG_1X1);
    const badRun = runCli(["sidecar", src5, "--vault", vault, "--preset", badPreset, "--sample", "verify", "--apply", "--json"]);
    check(badRun.status !== 0, "正文模板自带 frontmatter ⇒ 非零退出");
    check(badRun.stderr.includes("AnnexGalleryTemplates/bad.md"), "报错里点名正文模板文件");
    check(!fs.existsSync(path.join(src5, "1000X-a-01.md")), "坏正文模板下没有写出任何 sidecar");

    // ── B. 预设缺 tags ⇒ 写盘前停下 ───────────────────────────────────────
    console.log("\n[sidecar] 预设缺 tags");
    const noTagsPreset = path.join(cwd, "no-tags.json");
    write(noTagsPreset, `${JSON.stringify(presetOf({ id: "notags", frontmatter: { sample: "{{sample}}" } }), null, 2)}\n`);
    const src2 = path.join(vault, "src2");
    write(path.join(src2, "1000X-a-01.png"), PNG_1X1);
    const noTagsRun = runCli(["sidecar", src2, "--vault", vault, "--preset", noTagsPreset, "--apply", "--json"]);
    check(noTagsRun.status !== 0, "frontmatter 缺 tags ⇒ 非零退出");
    check(/必须包含 tags/.test(noTagsRun.stderr), "报错点名 tags 是硬要求");
    check(!fs.existsSync(path.join(src2, "1000X-a-01.md")), "缺 tags 的预设一份 sidecar 都不写");

    // ── B. 不给 --preset ⇒ 非零退出并给示例路径 ──────────────────────────
    console.log("\n[sidecar] 不给 --preset");
    const noPresetRun = runCli(["sidecar", src2, "--vault", vault, "--apply", "--json"]);
    check(noPresetRun.status !== 0, "没有 --preset ⇒ 非零退出（CLI 没有内置预设）");
    check(/tools\/example-profiles/.test(noPresetRun.stderr), "报错引导到 tools/example-profiles/*.json");

    // ── C. gallery dry-run 盘点 ──────────────────────────────────────────
    console.log("\n[gallery] dry-run 盘点");
    const gal = path.join(vault, "gal");
    write(path.join(gal, "tagged.png"), PNG_1X1);
    write(path.join(gal, "tagged.thumbnail.png"), PNG_1X1);
    write(path.join(gal, "tagged.md"), '---\ntags:\n  - annex-gallery-metadata\ntif: "[[gal/tagged.png]]"\n---\n');
    write(path.join(gal, "nothumb.png"), PNG_1X1);
    write(path.join(gal, "nothumb.md"), '---\ntags:\n  - annex-gallery-metadata\ntif: "[[gal/nothumb.png]]"\n---\n'); // 没有缩略图
    write(path.join(gal, "old.png"), PNG_1X1);
    write(path.join(gal, "old.thumbnail.png"), PNG_1X1);
    const oldMd = path.join(gal, "old.md");
    write(oldMd, '---\ntif: "[[gal/old.png]]"\nsample: "旧数据"\n---\n手写正文\n');
    write(path.join(gal, "orphan.png"), PNG_1X1); // 没有 sidecar
    write(path.join(gal, "README.md"), "---\ntags:\n  - notes\ntitle: README\n---\n说明\n"); // 非 sidecar

    const galBase = path.join(gal, "gal.base");
    const dry = runCliJson(["gallery", gal, "--vault", vault, "--preset", preset, "--json"]);
    console.log(
      `    plan → images=${dry.plan.images} tagged=${dry.plan.tagged} untagged=${dry.plan.untagged.length} ` +
        `missingSidecars=${dry.plan.missingSidecars} missingThumbnails=${dry.plan.missingThumbnails}`,
    );
    check(dry.plan.images === 4, "数出 4 张源图片（缩略图不算）");
    check(dry.plan.tagged === 2, "数出 2 份带 gallery 标签的 sidecar");
    check(
      dry.plan.untagged.length === 1 && dry.plan.untagged[0] === oldMd,
      "手写旧 sidecar（有 tif、无标签）被认成 untagged",
    );
    check(dry.plan.missingSidecars === 1, "没有同名 .md 的图片计入 missingSidecars");
    check(dry.plan.missingThumbnails === 1, "没有 <stem>.thumbnail.png 的 sidecar 计入 missingThumbnails");
    check(!dry.properties.includes("title"), "README.md 被忽略（它的键没有进 properties）");
    check(
      deepEqual(dry.properties, ["tags", "sample", "tif"]),
      "properties 只含 sidecar 里出现过的键，按预设 frontmatter 的键顺序排（magnification/index/thumbnail 没出现 ⇒ 不列）",
    );
    check(dry.target === "gal/gal.base", "目标是 <文件夹>/<文件夹名>.base");
    check(!fs.existsSync(galBase), "dry-run 没有写 .base");
    const dryBase = parseYaml(dry.text);
    check(
      deepEqual(dryBase.filters.and, ['file.inFolder("gal")', 'file.hasTag("annex-gallery-metadata")']),
      "默认 .base 顶层 filters.and = inFolder + hasTag",
    );
    check(
      Array.isArray(dryBase.views) &&
        dryBase.views.length === 1 &&
        dryBase.views[0].image === "note.thumbnail" &&
        dryBase.views[0].cardSize === 256 &&
        deepEqual(dryBase.views[0].order, ["file.name"]),
      "默认 .base 一个 cards 视图：note.thumbnail / cardSize=256 / order=[file.name]",
    );

    // ── D. --apply --fix-tags 只插标签行 ──────────────────────────────────
    console.log("\n[gallery] --apply --fix-tags");
    const oldBefore = read(oldMd);
    const applied = runCliJson(["gallery", gal, "--vault", vault, "--preset", preset, "--edge", "180", "--apply", "--fix-tags", "--json"]);
    check(applied.wrote === true, "--apply 写出了 .base");
    check(fs.existsSync(galBase), "画廊文件落在 <文件夹>/<文件夹名>.base");
    check(
      applied.fixedTags.length === 1 && applied.fixedTags[0] === "gal/old.md",
      "fixedTags 报告里是 gal/old.md",
    );
    const expectedOld = oldBefore.replace("---\n", "---\ntags:\n  - annex-gallery-metadata\n");
    check(read(oldMd) === expectedOld, "--fix-tags 只插入 tags 行，其余字节逐字一致");

    // ── E. 默认 .base 结构 + 覆盖保护 ─────────────────────────────────────
    console.log("\n[gallery] .base 结构 / 覆盖保护");
    const base = parseYaml(read(galBase));
    check(
      deepEqual(base.filters.and, ['file.inFolder("gal")', 'file.hasTag("annex-gallery-metadata")']),
      ".base filters.and 收口到文件夹 + gallery 标签",
    );
    check(
      Array.isArray(base.views) &&
        base.views.length === 1 &&
        base.views[0].type === "cards" &&
        base.views[0].image === "note.thumbnail" &&
        deepEqual(base.views[0].order, ["file.name"]) &&
        base.views[0].cardSize === 180,
      ".base cards 视图：image=note.thumbnail / order=[file.name] / cardSize=--edge 180",
    );

    const baseBytes = read(galBase);
    const refused = runCli(["gallery", gal, "--vault", vault, "--preset", preset, "--apply", "--json"]);
    check(refused.status === 1, "第二次 --apply（无 --overwrite）退出码 1");
    check(/已存在/.test(refused.stderr) && /--overwrite/.test(refused.stderr), "拒绝信息写明已存在、要加 --overwrite");
    check(read(galBase) === baseBytes, "被拒绝时 .base 原样未动");

    const overwritten = runCliJson(["gallery", gal, "--vault", vault, "--preset", preset, "--edge", "180", "--apply", "--overwrite", "--json"]);
    check(overwritten.wrote === true, "--overwrite 时重新生成成功");
    check(read(galBase) === baseBytes, "同样的输入重新生成，内容逐字节相同");

    // ── F. 自定义 .base：自己的 filters 并进 and + {{properties}} ─────────
    console.log("\n[gallery] 自定义 .base 模板");
    const customBaseTemplate = path.join(cwd, "custom.base");
    write(
      customBaseTemplate,
      "filters:\n  and:\n    - 'note.width > 10'\nviews:\n  - type: cards\n    order: {{properties}}\n    image: note.thumbnail\n    cardSize: {{cardSize}}\n",
    );
    const reorderPreset = path.join(cwd, "reorder.json");
    write(reorderPreset, `${JSON.stringify(presetOf({ id: "reorder", frontmatter: { sample: "{{sample}}", tags: ["annex-gallery-metadata"] }, template: "" }), null, 2)}\n`);
    const custom = runCliJson([
      "gallery",
      gal,
      "--vault",
      vault,
      "--template",
      customBaseTemplate,
      "--preset",
      reorderPreset,
      "--edge",
      "222",
      "--json",
    ]);
    check(deepEqual(custom.properties, ["sample", "tags", "tif"]), "另一份预设的 frontmatter 键顺序改变 properties 排序（sample 先于 tags）");
    const customBase = parseYaml(custom.text);
    check(customBase.filters.and.length === 3, "模板自己的 filters 作为第三项并进顶层 and（收窄）");
    check(collectStrings(customBase.filters).includes("note.width > 10"), "模板自己的 filter 表达式保留在 and 树里");
    check(
      deepEqual(customBase.views[0].order, ["sample", "tags", "tif"]),
      "{{properties}} 落进 order，且按预设 frontmatter 键顺序排好",
    );
    check(customBase.views[0].cardSize === 222, "{{cardSize}} = --edge 222");

    // ── G. 坏 .base 模板 ⇒ 点名文件 ───────────────────────────────────────
    console.log("\n[gallery] 坏 .base 模板");
    const brokenYaml = path.join(cwd, "broken-yaml.base");
    write(brokenYaml, "views: [\n");
    const brokenRun = runCli(["gallery", gal, "--vault", vault, "--preset", preset, "--template", brokenYaml, "--json"]);
    check(brokenRun.status !== 0, "填完占位符后不是合法 YAML ⇒ 非零退出");
    check(brokenRun.stderr.includes(brokenYaml), "报错里点名模板文件");

    const noViews = path.join(cwd, "no-views.base");
    write(noViews, "filters:\n  and:\n    - 'note.width > 1'\n");
    const noViewsRun = runCli(["gallery", gal, "--vault", vault, "--preset", preset, "--template", noViews, "--json"]);
    check(noViewsRun.status !== 0, "没有 views 列表 ⇒ 非零退出");
    check(noViewsRun.stderr.includes(noViews), "报错里点名模板文件");

    console.log(`\nPASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    else console.log("VERIFY-GALLERY OK");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
