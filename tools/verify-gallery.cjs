#!/usr/bin/env node
/**
 * 「创建画廊 / Create Gallery」+ metadata 模板的端到端校验（用户 2026-10-31 口径）。
 *
 * 在一个临时 vault（也是 git 仓库）里造出图片与手写 sidecar，用构建好的 CLI 跑：
 *
 *   A. `sidecar`：tags 第一项恒为 annex-gallery-metadata（含 keyOrder 里没有 tags 的 profile）；
 *      默认模板正文与改造前逐字节一致；`--template embed`；自定义模板缺占位符 ⇒ 留空 + detail 提示；
 *      模板第一行不是 {{frontmatter}} ⇒ 非零退出、点名文件、不写任何 sidecar。
 *   B. `gallery` dry-run：图片 / 已打标签 / 旧 sidecar / 缺 sidecar / 缺缩略图的盘点口径，
 *      README.md 不算；properties 按 profile.keyOrder 排；不写盘。
 *   C. `--apply --fix-tags`：只给旧 sidecar 插入 tags 行，其余字节不动。
 *   D. 默认 .base：filters.and / cards 视图 / cardSize / order / 目标路径；重复 apply 的保护与 --overwrite。
 *   E. 自定义 .base：模板自己的 filters 并进 and（收窄），{{properties}} 按 profile.keyOrder 排。
 *   F. 坏 .base 模板（YAML 解析失败 / 没有 views）：非零退出并点名模板文件。
 *
 *   node tools/verify-gallery.cjs
 *
 * 默认 profile 的 width/height 要 ImageMagick（`magick`）；缺它时打印 SKIP 并以 0 退出
 * （与 verify-sidecar-overwrite.cjs 同口径）。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse: parseYaml } = require("yaml");

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

async function main() {
  if (!hasMagick()) {
    console.log("SKIP：这台机器上没有 ImageMagick（`magick`），默认 profile 的 width/height 生成不了，跳过。");
    return;
  }

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "verify-gallery-"));
  try {
    git(["init", "-q", "."], vault);
    console.log(`临时 vault ${vault}`);

    // ── A. sidecar：标签恒在第一位 ────────────────────────────────────────
    console.log("\n[sidecar] tags 恒为第一项");
    const src = path.join(vault, "src");
    write(path.join(src, "1000X-a-01.png"), PNG_1X1);
    const defaultRun = runCliJson(["sidecar", src, "--vault", vault, "--sample", "verify", "--apply", "--json"]);
    check(defaultRun.entries[0].action === "created", "--apply 写出了默认 profile 的 sidecar");
    const defaultText = read(path.join(src, "1000X-a-01.md"));
    check(
      /^---\ntags:\n {2}- annex-gallery-metadata\n {2}- src\n/.test(defaultText),
      "默认 profile：tags 第一项是 annex-gallery-metadata",
    );

    // keyOrder 里没有 tags 的 profile：仍然先写一行，且只有 GALLERY_TAG。
    const noTagsProfile = path.join(vault, "profiles-no-tags.json");
    write(
      noTagsProfile,
      JSON.stringify({ profiles: [{ id: "notags", name: "无 tags 顺序", regex: "^.+$", fields: [], keyOrder: ["session"] }] }, null, 2),
    );
    const src2 = path.join(vault, "src2");
    write(path.join(src2, "1000X-a-01.png"), PNG_1X1);
    runCliJson(["sidecar", src2, "--vault", vault, "--profiles-file", noTagsProfile, "--apply", "--json"]);
    const noTagsText = read(path.join(src2, "1000X-a-01.md"));
    check(
      /^---\ntags:\n {2}- annex-gallery-metadata\nsession: "src2"\n---\n/.test(noTagsText),
      "keyOrder 省略 tags 时仍先写 tags:，且只带 annex-gallery-metadata",
    );

    // ── A. 默认模板正文 = 改造前布局 ─────────────────────────────────────
    console.log("\n[sidecar] 默认 metadata 模板正文");
    const expectedBody =
      "\n缩略图：[[src/1000X-a-01.thumbnail.png]]\n\n原图（用系统默认程序打开）：[[src/1000X-a-01.png]]\n";
    check(bodyOf(defaultText) === expectedBody, "默认模板正文与改造前逐字节一致（缩略图链接 + 原图链接）");

    // ── A. --template embed ──────────────────────────────────────────────
    console.log("\n[sidecar] --template embed");
    const src3 = path.join(vault, "src3");
    write(path.join(src3, "1000X-a-01.png"), PNG_1X1);
    runCliJson(["sidecar", src3, "--vault", vault, "--sample", "verify", "--template", "embed", "--apply", "--json"]);
    const embedText = read(path.join(src3, "1000X-a-01.md"));
    check(
      bodyOf(embedText) ===
        "\n![[src3/1000X-a-01.thumbnail.png]]\n\n原图（用系统默认程序打开）：[[src3/1000X-a-01.png]]\n",
      "--template embed 给出 ![[…thumbnail.png]] 嵌入",
    );

    // ── A. 自定义模板缺占位符 ⇒ 留空 + detail 提示 ────────────────────────
    console.log("\n[sidecar] 自定义模板缺占位符");
    const notesTemplate = path.join(vault, "notes-template.md");
    write(notesTemplate, "{{frontmatter}}\n\n笔记：{{notes}}\n");
    const src4 = path.join(vault, "src4");
    write(path.join(src4, "1000X-a-01.png"), PNG_1X1);
    const notesRun = runCliJson(["sidecar", src4, "--vault", vault, "--sample", "verify", "--template", notesTemplate, "--apply", "--json"]);
    check(
      /模板里的 \{\{notes\}\} 取不到值，已留空/.test(notesRun.entries[0].detail ?? ""),
      "report detail 写明 {{notes}} 取不到值、已留空",
    );
    check(/\n笔记：\n$/.test(read(path.join(src4, "1000X-a-01.md"))), "文件里 {{notes}} 被替换成空串");

    // ── A. 坏模板（第一行不是 {{frontmatter}}）⇒ 退出 1、点名文件、不写盘 ──
    console.log("\n[sidecar] 坏 metadata 模板");
    const badTemplate = path.join(vault, "bad-first-line.md");
    write(badTemplate, "正文写在前面\n{{frontmatter}}\n");
    const src5 = path.join(vault, "src5");
    write(path.join(src5, "1000X-a-01.png"), PNG_1X1);
    const badRun = runCli(["sidecar", src5, "--vault", vault, "--sample", "verify", "--template", badTemplate, "--apply", "--json"]);
    check(badRun.status !== 0, "第一行不是 {{frontmatter}} ⇒ 非零退出");
    check(badRun.stderr.includes(badTemplate), "报错里点名模板文件");
    check(!fs.existsSync(path.join(src5, "1000X-a-01.md")), "坏模板下没有写出任何 sidecar");

    // ── B. gallery dry-run 盘点 ──────────────────────────────────────────
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
    const dry = runCliJson(["gallery", gal, "--vault", vault, "--json"]);
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
    check(deepEqual(dry.properties, ["tags", "sample", "tif"]), "properties 按默认 profile 的 keyOrder 排序");
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

    // ── C. --apply --fix-tags 只插标签行 ──────────────────────────────────
    console.log("\n[gallery] --apply --fix-tags");
    const oldBefore = read(oldMd);
    const applied = runCliJson(["gallery", gal, "--vault", vault, "--edge", "180", "--apply", "--fix-tags", "--json"]);
    check(applied.wrote === true, "--apply 写出了 .base");
    check(fs.existsSync(galBase), "画廊文件落在 <文件夹>/<文件夹名>.base");
    check(
      applied.fixedTags.length === 1 && applied.fixedTags[0] === "gal/old.md",
      "fixedTags 报告里是 gal/old.md",
    );
    const expectedOld = oldBefore.replace("---\n", "---\ntags:\n  - annex-gallery-metadata\n");
    check(read(oldMd) === expectedOld, "--fix-tags 只插入 tags 行，其余字节逐字一致");

    // ── D. 默认 .base 结构 + 覆盖保护 ─────────────────────────────────────
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
    const refused = runCli(["gallery", gal, "--vault", vault, "--apply", "--json"]);
    check(refused.status === 1, "第二次 --apply（无 --overwrite）退出码 1");
    check(/已存在/.test(refused.stderr) && /--overwrite/.test(refused.stderr), "拒绝信息写明已存在、要加 --overwrite");
    check(read(galBase) === baseBytes, "被拒绝时 .base 原样未动");

    const overwritten = runCliJson(["gallery", gal, "--vault", vault, "--edge", "180", "--apply", "--overwrite", "--json"]);
    check(overwritten.wrote === true, "--overwrite 时重新生成成功");
    check(read(galBase) === baseBytes, "同样的输入重新生成，内容逐字节相同");

    // ── E. 自定义 .base：自己的 filters 并进 and + {{properties}} ─────────
    console.log("\n[gallery] 自定义 .base 模板");
    const customBaseTemplate = path.join(vault, "custom.base");
    write(
      customBaseTemplate,
      "filters:\n  and:\n    - 'note.width > 10'\nviews:\n  - type: cards\n    order: {{properties}}\n    image: note.thumbnail\n    cardSize: {{cardSize}}\n",
    );
    const reorderProfiles = path.join(vault, "profiles-reorder.json");
    write(
      reorderProfiles,
      JSON.stringify({ profiles: [{ id: "reorder", name: "重排", regex: "^.+$", fields: [], keyOrder: ["sample", "tags"] }] }, null, 2),
    );
    const custom = runCliJson([
      "gallery",
      gal,
      "--vault",
      vault,
      "--template",
      customBaseTemplate,
      "--profiles-file",
      reorderProfiles,
      "--edge",
      "222",
      "--json",
    ]);
    check(deepEqual(custom.properties, ["sample", "tags", "tif"]), "自定义 profile 的 keyOrder 决定 properties 顺序");
    const customBase = parseYaml(custom.text);
    check(customBase.filters.and.length === 3, "模板自己的 filters 作为第三项并进顶层 and（收窄）");
    check(collectStrings(customBase.filters).includes("note.width > 10"), "模板自己的 filter 表达式保留在 and 树里");
    check(
      deepEqual(customBase.views[0].order, ["sample", "tags", "tif"]),
      "{{properties}} 落进 order，且按 keyOrder 排好",
    );
    check(customBase.views[0].cardSize === 222, "{{cardSize}} = --edge 222");

    // ── F. 坏 .base 模板 ⇒ 点名文件 ───────────────────────────────────────
    console.log("\n[gallery] 坏 .base 模板");
    const brokenYaml = path.join(vault, "broken-yaml.base");
    write(brokenYaml, "views: [\n");
    const brokenRun = runCli(["gallery", gal, "--vault", vault, "--template", brokenYaml, "--json"]);
    check(brokenRun.status !== 0, "填完占位符后不是合法 YAML ⇒ 非零退出");
    check(brokenRun.stderr.includes(brokenYaml), "报错里点名模板文件");

    const noViews = path.join(vault, "no-views.base");
    write(noViews, "filters:\n  and:\n    - 'note.width > 1'\n");
    const noViewsRun = runCli(["gallery", gal, "--vault", vault, "--template", noViews, "--json"]);
    check(noViewsRun.status !== 0, "没有 views 列表 ⇒ 非零退出");
    check(noViewsRun.stderr.includes(noViews), "报错里点名模板文件");

    console.log(`\nPASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    else console.log("VERIFY-GALLERY OK");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
