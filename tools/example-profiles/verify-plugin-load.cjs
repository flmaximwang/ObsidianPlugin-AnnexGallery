#!/usr/bin/env node
/**
 * 插件加载路径校验（外部文件模型，spec-774d7ee）：
 * 用 `npm run smoke` 的同一个桩环境加载构建产物 main.js，验证真实运行时行为：
 *   - 文件名匹配模板只从设置登记的**外部 .json** 读取，每份顶层一条 ParseProfile；
 *   - 示例 profile（TECNAI + 多孔板）逐字读回，keyOrder / fields 不变；
 *   - 外部文件改了，下一次操作重新读取（无缓存）；
 *   - 跨文件 id 重复 / 坏 JSON / 文件丢失 ⇒ 整次操作抛错（不跳过、不 fallback）；
 *   - 旧 data.json 的内联 profiles 不迁移、不读取、不参与运行时；
 *   - 全新 data.json / 空登记列表 ⇒ 明确报错，绝不回退内置预设。
 *
 *   node tools/example-profiles/verify-plugin-load.cjs
 *
 * 全部读写只在 `/tmp/annex-example-profiles-vault`，绝不碰真实 vault。
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

const stub = require(path.join(__dirname, "..", "obsidian-stub.cjs"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};

const repo = path.resolve(__dirname, "..", "..");
const PluginClass = require(path.join(repo, "main.js")).default;
const VAULT = "/tmp/annex-example-profiles-vault";
const profiles = require(path.join(__dirname, "two-profiles.json"));
const plateOnly = require(path.join(__dirname, "plate-profile.json"));

fs.rmSync(VAULT, { recursive: true, force: true });
fs.mkdirSync(VAULT, { recursive: true });
const write = (rel, text) => {
  const abs = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return abs;
};
const writeJson = (rel, value) => write(rel, `${JSON.stringify(value, null, 2)}\n`);

let pass = 0;
let fail = 0;
const check = (cond, msg, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}${detail === undefined ? "" : `  —— ${detail}`}`);
  }
};
const failsWith = (fn, re) => {
  try {
    fn();
    return { ok: false, error: "(没有抛错)" };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: re.test(text), error: text };
  }
};

(async () => {
  // 示例文件是 CLI 的多 profile 数组；插件要求一条一个文件。这里拆成两份独立 JSON。
  const tec = profiles.find((entry) => entry.id === "tecnaitem");
  const plate = profiles.find((entry) => entry.id === "platewell");
  check(tec !== undefined && plate !== undefined, "two-profiles.json 里含 TECNAI + 多孔板两条示例");
  writeJson("Profiles/tecnaitem.json", tec);
  writeJson("Profiles/Other/platewell.json", plate);

  stub.registry.savedData = {
    thumbnailEdge: 256,
    folderSamples: {},
    folderProfiles: {},
    profileFiles: [{ path: "Profiles/tecnaitem.json" }, { path: "Profiles/Other/platewell.json" }],
  };
  const plugin = new PluginClass(stub.makeApp(VAULT), { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  console.log(`  插件读到的 profileFiles：${plugin.settings.profileFiles.map((entry) => entry.path).join(", ")}`);
  check(plugin.settings.profileFiles.length === 2, "loadSettings 读回两条外部路径");
  check(plugin.settings.profiles === undefined, "settings 里不再有内联 profiles 字段");

  const loaded = plugin.loadProfilesForOperation();
  console.log(`  运行时读到的 profile id：${loaded.map((entry) => `${entry.profile.id}@${entry.path}`).join(", ")}`);
  check(loaded.length === 2 && loaded[0].profile.id === "tecnaitem" && loaded[1].profile.id === "platewell", "两个外部文件按登记顺序读成两条 profile");
  check(JSON.stringify(loaded[0].profile) === JSON.stringify(tec), "TECNAI profile 逐字节读回（regex / fields / keyOrder 未变）");
  check(loaded[0].profile.keyOrder.length === 12, "TECNAI 是 12 键 keyOrder");
  check(JSON.stringify(loaded[1].profile) === JSON.stringify(plateOnly[0]), "多孔板 profile 逐字节读回");
  check(loaded[1].profile.fields.some((field) => field.group === "well" && field.type === "text"), "多孔板 profile 的 well 字段类型仍是 text");
  check(loaded[0].absPath === path.join(VAULT, "Profiles/tecnaitem.json"), "加载结果带打开用的绝对路径");

  // 外部改动 ⇒ 下次操作重新读（没有缓存）。
  const edited = JSON.parse(JSON.stringify(plate));
  edited.id = "plate-live";
  edited.name = "多孔板（外部改名）";
  writeJson("Profiles/Other/platewell.json", edited);
  const reread = plugin.loadProfilesForOperation();
  console.log(`  外部改名后：${reread.map((entry) => `${entry.profile.id} / ${entry.profile.name}`).join(" | ")}`);
  check(reread[1].profile.id === "plate-live" && reread[1].profile.name === "多孔板（外部改名）", "外部 JSON 改动后下一次操作立即读到新 id/name");
  writeJson("Profiles/Other/platewell.json", plate);

  // 跨文件 id 重复：整次操作失败，错误带两处路径。
  writeJson("Profiles/duplicate.json", { ...tec, name: "重复 id 的第二份" });
  plugin.settings.profileFiles.push({ path: "Profiles/duplicate.json" });
  const duplicate = failsWith(() => plugin.loadProfilesForOperation(), /id「tecnaitem」重复/);
  console.log(`  重复 id → ${duplicate.error}`);
  check(duplicate.ok && duplicate.error.includes("Profiles/tecnaitem.json") && duplicate.error.includes("Profiles/duplicate.json"), "跨文件 id 重复被拒绝，错误带两处路径");
  plugin.settings.profileFiles.pop();
  fs.rmSync(path.join(VAULT, "Profiles/duplicate.json"));

  // 坏 JSON。
  writeJson("Profiles/bad.json", { id: "broken" }); // 先写合法结构，下面再改成坏文本
  write("Profiles/bad.json", '{ "id": "broken", ');
  plugin.settings.profileFiles.push({ path: "Profiles/bad.json" });
  const badJson = failsWith(() => plugin.loadProfilesForOperation(), /不是合法 JSON/);
  console.log(`  坏 JSON → ${badJson.error}`);
  check(badJson.ok && badJson.error.includes("Profiles/bad.json"), "坏 JSON 被拒绝，错误带文件路径");
  plugin.settings.profileFiles.pop();

  // 数组 / { profiles: [...] } 包装（CLI 多 profile 格式）不属于插件设置。
  writeJson("Profiles/array.json", [plateOnly[0]]);
  plugin.settings.profileFiles.push({ path: "Profiles/array.json" });
  const arrayFile = failsWith(() => plugin.loadProfilesForOperation(), /顶层必须是单条 ParseProfile 对象/);
  check(arrayFile.ok, "数组格式的 profile 文件被拒绝（插件要求一条一个对象文件）", arrayFile.error);
  plugin.settings.profileFiles.pop();

  // 文件丢失。
  writeJson("Profiles/gone.json", { ...plateOnly[0], id: "gone" });
  plugin.settings.profileFiles.push({ path: "Profiles/gone.json" });
  fs.rmSync(path.join(VAULT, "Profiles/gone.json"));
  const missing = failsWith(() => plugin.loadProfilesForOperation(), /文件不存在/);
  console.log(`  文件丢失 → ${missing.error}`);
  check(missing.ok && missing.error.includes("Profiles/gone.json"), "登记后文件丢失 ⇒ 操作失败，错误带路径");
  plugin.settings.profileFiles.pop();

  // 旧 data.json 内联 profiles：不迁移、不读取、不 fallback。
  stub.registry.savedData = {
    thumbnailEdge: 256,
    profiles: [JSON.parse(JSON.stringify(tec))],
    folderSamples: {},
    folderProfiles: { "/tmp/legacy-folder": "tecnaitem" },
  };
  const legacy = new PluginClass(stub.makeApp(VAULT), { id: "annex-gallery", version: "0.1.0" });
  await legacy.onload();
  check(legacy.legacyInlineProfiles.present === true && legacy.legacyInlineProfiles.count === 1, "旧内联 profiles 被检测到（仅用于显示失效提示）");
  check(legacy.settings.profileFiles.length === 0, "旧内联 profiles 没有被迁移成 profileFiles");
  check(legacy.settings.profiles.length === 1 && legacy.settings.profiles[0].id === "tecnaitem", "旧 profiles 原样留在内存设置里（不删除、不迁移）");
  const legacyRun = failsWith(() => legacy.loadProfilesForOperation(), /还没有登记任何文件名匹配模板/);
  console.log(`  旧内联 profiles 运行时 → ${legacyRun.error}`);
  check(legacyRun.ok, "旧内联 profiles 不参与运行时：空登记列表直接报错，不回退旧值");
  check(stub.registry.savedData.profileFiles === undefined, "没有把任何迁移结果写回 data.json");

  // 全新 data.json：同样不回退内置 DEFAULT_PROFILES。
  stub.registry.savedData = null;
  const fresh = new PluginClass(stub.makeApp(VAULT), { id: "annex-gallery", version: "0.1.0" });
  await fresh.onload();
  check(fresh.settings.profileFiles.length === 0, "全新 data.json ⇒ profileFiles = []");
  const freshRun = failsWith(() => fresh.loadProfilesForOperation(), /还没有登记任何文件名匹配模板/);
  check(freshRun.ok, "全新 data.json 不回退内置 TECNAI / 预设，明确引导去登记外部 JSON", freshRun.error);

  fs.rmSync(VAULT, { recursive: true, force: true });
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
  console.log("VERIFY-PLUGIN-LOAD OK");
})().catch((error) => {
  fs.rmSync(VAULT, { recursive: true, force: true });
  console.error("FAILED:", error);
  process.exit(1);
});
