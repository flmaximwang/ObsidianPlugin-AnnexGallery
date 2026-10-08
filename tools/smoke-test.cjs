#!/usr/bin/env node
/**
 * Headless load smoke test: loads the *built* main.js against a stubbed
 * `obsidian` module, runs onload(), and exercises the right-click menu.
 *
 *   node tools/smoke-test.cjs [vaultPath]
 *
 * It answers "does the plugin load and does the folder menu appear", which the
 * real Obsidian answers only after a restart — i.e. it catches import errors,
 * wrong API use and menu-wiring mistakes before a restart cycle is spent.
 */
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
const PluginClass = require(path.join(repo, "main.js")).default;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

(async () => {
  const app = stub.makeApp(vaultPath);
  const plugin = new PluginClass(app, { id: "annex-gallery", version: "0.1.0" });
  await plugin.onload();
  console.log("onload() 完成");

  assert(stub.registry.commands.length === 1, `注册了 1 条命令：${stub.registry.commands.map((c) => `${c.id} / ${c.name}`).join(", ")}`);
  assert(stub.registry.tabs.length === 1, "注册了 1 个设置页");
  assert(stub.registry.menus.length === 1, "注册了 1 个 file-menu 处理器");

  const folder = new stub.TFolder("TEM/20261008-1495dd26-5705");
  const folderMenu = new stub.Menu();
  stub.registry.menus[0](folderMenu, folder, "file-explorer");
  const titles = folderMenu.items.map((item) => item.title);
  console.log(`右键文件夹 → ${titles.length} 项：${titles.join(" | ")}`);
  assert(titles.length === 2, "右键文件夹出现 2 个菜单项");
  assert(titles.some((t) => t.includes("生成缩略图")), "菜单项含「生成缩略图」");
  assert(titles.some((t) => t.includes("生成 metadata")), "菜单项含「使用 Annex Gallery 管理（生成 metadata）」");
  assert(folderMenu.items.every((item) => typeof item.callback === "function"), "两个菜单项都挂了回调");

  const fileMenu = new stub.Menu();
  stub.registry.menus[0](fileMenu, new stub.TFile("TEM/TEM 图库.md"), "file-explorer");
  assert(fileMenu.items.length === 0, "右键文件不出现任何菜单项（只对文件夹生效）");

  stub.registry.tabs[0].display();
  assert(true, "设置页 display() 不抛错");

  assert(plugin.vaultRoot() === vaultPath, `vaultRoot() = ${plugin.vaultRoot()}`);

  const clicked = folderMenu.items.find((item) => item.title.includes("生成 metadata"));
  clicked.callback();
  assert(stub.registry.notices.length === 0, "点「生成 metadata」不会立刻弹错误提示（先开弹窗填样品名）");
  console.log("\nSMOKE OK");
})().catch((error) => {
  console.error("\nSMOKE FAILED:", error);
  process.exit(1);
});
