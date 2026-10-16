#!/usr/bin/env node
/**
 * T-008#B-007 插件路径校验：把非 TECNAI profile 放进一份 data.json 的 profiles 数组，
 * 用 `npm run smoke` 的同一个桩环境加载构建产物 main.js，证明：
 *   - 插件的 loadSettings 能读回这条 profile（regex / fields / keyOrder 原样）
 *   - 内置 TECNAI profile 没被弄丢
 *
 *   node tools/example-profiles/verify-plugin-load.cjs
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const stub = require(path.join(__dirname, "..", "obsidian-stub.cjs"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};

const repo = path.resolve(__dirname, "..", "..");
const PluginClass = require(path.join(repo, "main.js")).default;
const plate = JSON.parse(fs.readFileSync(path.join(__dirname, "plate-profile.json"), "utf8"))[0];

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

(async () => {
  const { DEFAULT_PROFILES, TECNAI_TEM_PROFILE } = await import(pathToFileURL(path.join(repo, "src", "core", "profiles.ts")).href);
  check(DEFAULT_PROFILES.length === 1 && DEFAULT_PROFILES[0].id === "tecnaitem", `内置 DEFAULT_PROFILES = [${DEFAULT_PROFILES.map((p) => p.id).join(", ")}]`);

  // ── 场景 A：data.json 里是「内置 TECNAI + 新 plate profile」两条 ──────────
  const tec = JSON.parse(JSON.stringify(TECNAI_TEM_PROFILE));
  stub.registry.savedData = {
    thumbnailEdge: 256,
    gitattributesPath: "",
    gitignorePath: "",
    defaultSample: "plate-demo",
    folderSamples: {},
    profiles: [JSON.parse(JSON.stringify(tec)), JSON.parse(JSON.stringify(plate))],
    folderProfiles: { "/tmp/plate-run": "platewell" },
  };
  const plugin = new PluginClass(stub.makeApp("/tmp/example-profiles-vault"), { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  const ids = plugin.settings.profiles.map((p) => p.id);
  console.log(`  场景 A 读回的 profile id：${ids.join(", ")}`);
  check(ids.length === 2 && ids[0] === "tecnaitem" && ids[1] === "platewell", "两条 profile 都读回、顺序不变");
  check(JSON.stringify(plugin.settings.profiles[0]) === JSON.stringify(tec), "内置 TECNAI profile 逐字节没丢");
  check(plugin.settings.profiles[0].keyOrder.length === 12, "内置 TECNAI 是 12 键 keyOrder（用户 2026-10-17 给的正确预设）");
  check(JSON.stringify(plugin.settings.profiles[1]) === JSON.stringify(plate), "新 plate profile 原样读回（regex / fields / keyOrder 未变）");
  check(
    plugin.settings.profiles[1].fields.some((f) => f.group === "well" && f.type === "text"),
    "plate profile 的 well 字段类型仍是 text",
  );
  check(plugin.settings.folderProfiles["/tmp/plate-run"] === "platewell", "folderProfiles 读回正确");

  // ── 场景 B：全新 data.json（没有 profiles 键）→ 回落内置 DEFAULT_PROFILES ──
  stub.registry.savedData = { thumbnailEdge: 256, defaultSample: "", folderSamples: {}, folderProfiles: {} };
  const fresh = new PluginClass(stub.makeApp("/tmp/example-profiles-vault"), { id: "annex-gallery", version: "0.1.0" });
  await fresh.onload();
  check(
    fresh.settings.profiles.length === 1 && fresh.settings.profiles[0].id === "tecnaitem",
    "全新 data.json → 回落内置 TECNAI（未丢）",
  );

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("VERIFY-PLUGIN-LOAD OK");
})().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
