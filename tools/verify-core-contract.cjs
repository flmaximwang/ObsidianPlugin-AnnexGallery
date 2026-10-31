#!/usr/bin/env node
/**
 * 核心层契约判据（spec-774d7ee）：**没有内置兜底**。
 *
 * 插件运行时只认登记过的外部文件；CLI 显式选自带预设。两条路都把模板/profile 显式传进来，
 * 所以核心层 `generateSidecars()` / `buildSidecarText()` 拿不到它们时必须**报错**，
 * 而不是悄悄退回内置默认 —— 那样「调用方漏传参数」会表现成「结果正常但用的是另一套模板」，
 * 比报错难查得多。
 *
 * 这个脚本用 esbuild 把 `src/core/sidecar.ts` 现场打成一份 CommonJS 再 require：
 * 核心模块 import 了 `src/defaults/**` 的 .md/.base 预设素材（构建时内联），直接 require
 * 不了 TS，也没法直接读那些文件。
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

/** 与 esbuild.config.mjs 同一套 defaults-text 插件：把预设素材当文本内联。 */
const defaultsTextLoader = {
  name: "defaults-text",
  setup(build) {
    build.onLoad({ filter: /\/defaults\/(gitattributes|gitignore|metadata\/[^/]+\.md|base\/[^/]+\.base)$/ }, async (args) => ({
      contents: await fs.promises.readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

async function loadCore() {
  const esbuild = require("esbuild");
  const outfile = path.join(TMP, "core-sidecar.cjs");
  await esbuild.build({
    entryPoints: [path.join(repo, "src", "core", "sidecar.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    logLevel: "error",
    outfile,
    plugins: [defaultsTextLoader],
  });
  return require(outfile);
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const core = await loadCore();
  console.log("\n[core] 缺 template / profiles ⇒ 直接报错（不回退内置默认）");

  const profile = {
    id: "probe",
    name: "probe",
    regex: "^(?<stem>.*)$",
    fields: [],
    keyOrder: ["tags"],
  };

  const images = path.join(TMP, "images");
  fs.mkdirSync(images, { recursive: true });
  fs.writeFileSync(path.join(images, "001.tif"), "fake-tif", "utf8");

  const template = { id: "probe", label: "probe.md", text: "{{frontmatter}}\n" };

  // ── 1. generateSidecars：不给 template ────────────────────────────────
  let err = null;
  try {
    await core.generateSidecars(images, { vaultRoot: TMP, profiles: [profile] });
  } catch (error) {
    err = error;
  }
  check(err !== null, "generateSidecars 不给 template ⇒ 抛错");
  check(err !== null && /没有 metadata 模板/.test(String(err.message)), `错误说清缺什么（${err === null ? "无" : err.message}）`);

  // ── 2. generateSidecars：不给 profiles ────────────────────────────────
  err = null;
  try {
    await core.generateSidecars(images, { vaultRoot: TMP, template });
  } catch (error) {
    err = error;
  }
  check(err !== null, "generateSidecars 不给 profiles ⇒ 抛错");
  check(err !== null && /没有可用的 profile/.test(String(err.message)), `错误说清缺什么（${err === null ? "无" : err.message}）`);

  // ── 3. buildSidecarText：不给 template ───────────────────────────────
  err = null;
  try {
    core.buildSidecarText(path.join(images, "001.tif"), profile, { vaultRoot: TMP });
  } catch (error) {
    err = error;
  }
  check(err !== null, "buildSidecarText 不给 template ⇒ 抛错");
  check(err !== null && /没有 metadata 模板/.test(String(err.message)), `错误说清缺什么（${err === null ? "无" : err.message}）`);

  // ── 4. 显式给全 ⇒ 正常跑（dry-run，不写盘）──────────────────────────
  const report = await core.generateSidecars(images, { vaultRoot: TMP, profiles: [profile], template });
  check(report.entries.length === 1, "显式给 template + profiles ⇒ 正常生成一条报告");
  check(!fs.existsSync(path.join(images, "001.md")), "dry-run 不写盘");

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
