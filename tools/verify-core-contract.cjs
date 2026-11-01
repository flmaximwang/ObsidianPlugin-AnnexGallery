#!/usr/bin/env node
/**
 * 核心层契约判据（ticket qij）：预设 schema v3 + sidecar 渲染器 + 外部文件 loader。
 *
 * 这个脚本用 esbuild 把 `src/core/sidecar.ts` / `src/core/profiles.ts` /
 * `src/core/profile-files.ts` 现场打成 CommonJS 再 require —— 核心模块 import 了
 * `src/defaults/**` 的素材（构建时内联成文本/JSON），直接 require 不了 TS。
 *
 * 覆盖面（冻结口径）：
 *   A. 渲染：frontmatter **完全来自预设的字典**（键顺序 = 书写顺序）；没有 keyOrder / fields。
 *   B. 恰好一个占位符 ⇒ 按 `types` 输出带类型标量（number 裸数字、date 裸日期、text 双引号）。
 *   C. 与文字混合的占位符 ⇒ 整体当一个字符串（双引号），不做类型转换。
 *   D. 空值 / 取不到值 ⇒ 保留键、写 YAML null，并在 detail 里报告；列表里的空项整项丢弃。
 *   E. 正文：`opts.body` 原样追加到 frontmatter 之后；不给 body ⇒ 只有 frontmatter。
 *   F. `generateSidecars` 自己按预设的 `template` 读 vault 里的 `.md`；正文带 frontmatter ⇒ 写盘前抛错。
 *   G. `generateSidecars` 不给 profiles ⇒ 抛错（没有内置兜底）。
 *   H. 校验：`tags` 缺失 / 不是列表 / 没有字面量 `annex-gallery-metadata` ⇒ validator error。
 *   I. 旧格式 JSON（keyOrder / fields / constFields …）⇒ 明确拒绝 + legacy 提示，不迁移。
 *
 *   node tools/verify-core-contract.cjs
 *
 * 全部读写只在 `/tmp/annex-core-contract`，绝不碰真实 vault。
 */
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const TMP = "/tmp/annex-core-contract";

let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}`);
  }
};
const eq = (actual, expected, msg) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(same, same ? msg : `${msg}\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`);
};

/** 与 esbuild.config.mjs 同一套 defaults-text 插件：把预设素材当文本内联。 */
const defaultsTextLoader = {
  name: "defaults-text",
  setup(build) {
    build.onLoad({ filter: /\/defaults\/(gitattributes|gitignore|presets\/[^/]+\.md|base\/[^/]+\.base)$/ }, async (args) => ({
      contents: await fs.promises.readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

async function loadCore() {
  const esbuild = require("esbuild");
  const outdir = path.join(TMP, "core");
  await esbuild.build({
    entryPoints: [
      path.join(repo, "src", "core", "sidecar.ts"),
      path.join(repo, "src", "core", "profiles.ts"),
      path.join(repo, "src", "core", "profile-files.ts"),
    ],
    outdir,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    logLevel: "error",
    plugins: [defaultsTextLoader],
  });
  return {
    sidecar: require(path.join(outdir, "sidecar.js")),
    profiles: require(path.join(outdir, "profiles.js")),
    files: require(path.join(outdir, "profile-files.js")),
  };
}

/** 一份最小的合法预设；用例按需覆盖字段。 */
function profileOf(overrides = {}) {
  return {
    id: "probe",
    name: "probe",
    source: "stem",
    regex: "^(?<idx>\\d+)-(?<tag>[a-z]+)$",
    ask: ["sample"],
    onMismatch: "empty",
    frontmatter: {
      tags: ["annex-gallery-metadata", "{{tags}}"],
      idx: "{{idx}}",
      tag: "{{tag}}",
    },
    ...overrides,
  };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const vault = path.join(TMP, "vault");
  const runDir = path.join(vault, "20260101-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "07-tag.tif"), "fake-tif", "utf8");
  const image = path.join(runDir, "07-tag.tif");

  const { sidecar, profiles, files } = await loadCore();

  // ── A/B/C. 字典顺序 + 类型 + 混合字符串 ────────────────────────────────
  console.log("\n[渲染] frontmatter 字典 / 类型 / 混合字符串");
  const typed = profileOf({
    types: { idx: "number", when: "date" },
    frontmatter: {
      tags: ["annex-gallery-metadata", "{{tags}}"],
      sample: "{{sample}}",
      when: "{{when}}",
      idx: "{{idx}}",
      tag: "{{tag}}",
      mixed: "{{idx}}/{{tag}}",
      literal: "hello",
      num: 7,
      flag: true,
    },
  });
  const built = sidecar.buildSidecarText(image, typed, { vaultRoot: vault, ask: { sample: "s1", when: "2026-05-06" } });
  eq(
    built.text,
    [
      "---",
      "tags:",
      '  - "annex-gallery-metadata"',
      '  - "20260101-run"',
      'sample: "s1"',
      "when: 2026-05-06",
      "idx: 7",
      'tag: "tag"',
      'mixed: "07/tag"',
      'literal: "hello"',
      "num: 7",
      "flag: true",
      "---",
      "",
    ].join("\n"),
    "frontmatter 逐字节 = 字典顺序 + number 裸值 + date 裸值 + text 双引号 + 混合串整体当文本",
  );
  check(/^---\n/.test(built.text) && built.text.trimEnd().endsWith("---"), "整份内容 = 一对 --- 包住 frontmatter");
  check(built.matched === true && built.detail === undefined, "命中的预设没有 detail");

  // ── D. 空值 ⇒ YAML null + 报告；列表空项丢弃 ──────────────────────────
  console.log("\n[渲染] 空值 / 空列表项");
  const empties = profileOf({
    regex: "^(?<idx>\\d+)(?:-(?<tag>[a-z]+))?$",
    frontmatter: {
      tags: ["annex-gallery-metadata", "{{tags}}"],
      sample: "{{sample}}",
      tag: "{{tag}}",
      blank: "",
      missingvar: "{{nope}}",
      nested: { inner: "{{tag}}" },
      list: ["{{idx}}", "", "{{tag}}", 3],
      emptyList: [],
    },
  });
  fs.writeFileSync(path.join(runDir, "08.tif"), "fake-tif", "utf8");
  const empty = sidecar.buildSidecarText(path.join(runDir, "08.tif"), empties, { vaultRoot: vault });
  check(/^tag:$/m.test(empty.text), "组没参与匹配 ⇒ 键保留、写 YAML null（`tag:`）");
  check(/^sample:$/m.test(empty.text), "ask 没给值 ⇒ `sample:` 写成 YAML null");
  check(/^blank:$/m.test(empty.text), "JSON 里的空字符串 ⇒ `blank:` 写成 YAML null");
  check(/^missingvar:$/m.test(empty.text), "没有来源的占位符 ⇒ 键保留、写 YAML null");
  check(/^  inner:$/m.test(empty.text), "嵌套对象里的空值同样写 YAML null");
  check(/^list:\n {2}- "08"\n {2}- 3$/m.test(empty.text), "列表里的空项整项丢弃，其余项照写（顺序不变）");
  check(/^emptyList: \[\]$/m.test(empty.text), "空列表写成 `[]`");
  check(/空值（写成 YAML null）：sample、tag、blank、missingvar、nested\.inner/.test(empty.detail ?? ""), "detail 报告写成 YAML null 的键路径");
  check(/列表里的空项已丢弃：list/.test(empty.detail ?? ""), "detail 报告丢弃过空项的列表");
  check(/没有来源的占位符：.*\{\{nope\}\}/.test(empty.detail ?? ""), "detail 报告没有来源的占位符");

  // ── E. 正文：给了就追加，不给只有 frontmatter ─────────────────────────
  console.log("\n[渲染] 正文");
  const withBody = sidecar.buildSidecarText(image, typed, {
    vaultRoot: vault,
    ask: { sample: "s1", when: "2026-05-06" },
    body: "\n缩略图：{{thumbnail}}\n未知：{{nope}}\n",
  });
  check(withBody.text.startsWith(built.text), "正文追加在 frontmatter 之后（frontmatter 部分逐字节不变）");
  check(withBody.text.endsWith("\n缩略图：[[20260101-run/07-tag.thumbnail.png]]\n未知：\n"), "正文里的占位符按同一套取值替换，取不到留空");
  check(/模板里的 \{\{nope\}\} 取不到值，已留空/.test(withBody.detail ?? ""), "detail 报告正文里取不到值的占位符");
  const noBody = sidecar.buildSidecarText(image, typed, { vaultRoot: vault, ask: { sample: "s1", when: "2026-05-06" } });
  check(noBody.text === built.text && noBody.text.endsWith("---\n"), "不给 body ⇒ 只有 frontmatter（末尾一行 ---）");

  // ── F. generateSidecars 读预设自己的 template ─────────────────────────
  console.log("\n[generateSidecars] 正文来自预设的 template");
  fs.mkdirSync(path.join(vault, "AnnexGalleryTemplates"), { recursive: true });
  fs.writeFileSync(path.join(vault, "AnnexGalleryTemplates", "probe.md"), "\n正文：{{idx}}\n", "utf8");
  const bodyProfile = profileOf({ template: "AnnexGalleryTemplates/probe.md" });
  const report = await sidecar.generateSidecars(runDir, { vaultRoot: vault, repoRoot: vault, profiles: [bodyProfile], apply: true });
  check(report.entries.length === 2 && report.entries.every((entry) => entry.action === "created"), "apply 写出两份 sidecar");
  const onDisk = fs.readFileSync(path.join(runDir, "07-tag.md"), "utf8");
  check(onDisk.includes("\n正文：07\n"), "预设 template 指向的 vault `.md` 被读入并追加为正文");
  check(report.dryRun === false, "apply 后 dryRun=false");

  fs.writeFileSync(path.join(vault, "AnnexGalleryTemplates", "bad.md"), "---\ntitle: x\n---\n正文\n", "utf8");
  fs.rmSync(path.join(runDir, "09-x.md"), { force: true });
  fs.writeFileSync(path.join(runDir, "09-x.tif"), "fake-tif", "utf8");
  let err = null;
  try {
    await sidecar.generateSidecars(runDir, {
      vaultRoot: vault,
      repoRoot: vault,
      profiles: [profileOf({ template: "AnnexGalleryTemplates/bad.md" })],
      apply: true,
    });
  } catch (error) {
    err = error;
  }
  check(err !== null && /不能自带 frontmatter/.test(String(err.message)), "正文模板自带 frontmatter ⇒ 抛错");
  check(!fs.existsSync(path.join(runDir, "09-x.md")), "坏正文模板在写盘前停下（一份 sidecar 都没写）");

  // ── G. 没有 profiles ⇒ 报错（没有内置兜底）─────────────────────────────
  console.log("\n[generateSidecars] 没有内置兜底");
  err = null;
  try {
    await sidecar.generateSidecars(runDir, { vaultRoot: vault, repoRoot: vault });
  } catch (error) {
    err = error;
  }
  check(err !== null, "不给 profiles ⇒ 抛错");
  check(err !== null && /没有可用的元数据预设/.test(String(err.message)), `错误说清缺什么（${err === null ? "无" : err.message}）`);

  // ── H. validateProfile：gallery 标签是硬要求 ──────────────────────────
  console.log("\n[validateProfile] tags 必须含 annex-gallery-metadata");
  const noTag = profiles.validateProfile(profileOf({ frontmatter: { idx: "{{idx}}" } }));
  check(
    noTag.some((issue) => issue.level === "error" && /必须包含 tags/.test(issue.message)),
    "frontmatter 没有 tags ⇒ error",
  );
  const stringTags = profiles.validateProfile(profileOf({ frontmatter: { tags: "annex-gallery-metadata", idx: "{{idx}}" } }));
  check(
    stringTags.some((issue) => issue.level === "error" && /必须是列表且含字面量/.test(issue.message)),
    "tags 不是列表 ⇒ error",
  );
  const wrongTag = profiles.validateProfile(profileOf({ frontmatter: { tags: ["other"], idx: "{{idx}}" } }));
  check(
    wrongTag.some((issue) => issue.level === "error" && /必须是列表且含字面量/.test(issue.message)),
    "tags 列表里没有 GALLERY_TAG ⇒ error",
  );
  eq(profiles.validateProfile(profileOf({ frontmatter: { tags: ["annex-gallery-metadata"], idx: "{{idx}}", tag: "{{tag}}" } })), [], "最小合法预设 ⇒ 没有任何 issue");
  check(/annex-gallery-metadata/.test(profiles.GALLERY_TAG), "GALLERY_TAG 仍是 annex-gallery-metadata");

  // ── I. 旧格式 JSON ⇒ 明确拒绝 ─────────────────────────────────────────
  console.log("\n[loader] 旧格式 / 多预设文件被拒绝");
  fs.mkdirSync(path.join(vault, "Profiles"), { recursive: true });
  const legacy = {
    id: "old",
    name: "旧格式",
    regex: "^.+$",
    fields: [{ group: "idx", type: "number" }],
    keyOrder: ["tags", "idx"],
    metadataTemplate: "old",
  };
  fs.writeFileSync(path.join(vault, "Profiles", "old.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  const legacyInspection = files.inspectProfileFile(vault, "Profiles/old.json");
  check(legacyInspection.legacyKeys.length === 3, `旧格式顶层键被认出来（${legacyInspection.legacyKeys.join(" / ")}）`);
  check(
    legacyInspection.issues.some((issue) => issue.level === "error" && /旧格式的元数据预设/.test(issue.message)),
    "旧格式报错带 legacy 提示",
  );
  check(
    legacyInspection.issues.some((issue) => /不会自动迁移/.test(issue.message)),
    "legacy 提示说明「不会自动迁移」",
  );
  err = null;
  try {
    files.loadProfileFile(vault, "Profiles/old.json");
  } catch (error) {
    err = error;
  }
  check(err !== null && /旧格式的元数据预设/.test(String(err.message)), "loadProfileFile 对旧格式抛错");

  const wrapper = { profiles: [profileOf()] };
  fs.writeFileSync(path.join(vault, "Profiles", "multi.json"), `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");
  const multi = files.inspectProfileFile(vault, "Profiles/multi.json");
  check(
    multi.issues.some((issue) => issue.level === "error" && /单条预设对象/.test(issue.message)),
    "`{ profiles: [...] }` 多预设文件被拒绝",
  );

  // 新格式单文件 ⇒ 读得回，正文一起带上。
  fs.writeFileSync(path.join(vault, "Profiles", "new.json"), `${JSON.stringify(bodyProfile, null, 2)}\n`, "utf8");
  const loaded = files.loadProfileFile(vault, "Profiles/new.json");
  check(loaded.profile.id === "probe" && loaded.profile.frontmatter !== undefined, "新格式单预设文件正常读回");
  check(loaded.body !== undefined && loaded.body.text.includes("正文：{{idx}}"), "正文模板随预设一起读入（body.text）");
  check(loaded.path === "Profiles/new.json" && loaded.absPath.endsWith("Profiles/new.json"), "加载结果带 vault 相对路径与绝对路径");

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log("VERIFY-CORE-CONTRACT FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("VERIFY-CORE-CONTRACT OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
