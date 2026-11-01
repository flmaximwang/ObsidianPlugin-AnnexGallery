#!/usr/bin/env node
/**
 * T-008#B-007 程序化校验：合成语料产出的 sidecar frontmatter 是否符合预设。
 *
 *   node tools/example-profiles/verify-frontmatter.cjs [dir]
 *
 * 期望直接读自 plate-profile.json（`frontmatter` 字典 / `types`），逐份断言：
 *   - 顶层键序列 == Object.keys(frontmatter)（字典书写顺序就是输出顺序），一个不多一个不少
 *   - number 类型的键是裸数字；date 类型是裸日期；其余字符串占位符是双引号字符串
 *   - tags 是列表；取不到值的键（notes，以及这张图没有的 well）保留键、写 YAML null
 *   - 正文来自预设的 template：两条可点击链接，不含 ![[]] 嵌入
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "/tmp/annex-gallery-b007/vault/20260417-plate-run";
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, "plate-profile.json"), "utf8"));

const expectedKeys = Object.keys(profile.frontmatter);
const types = profile.types ?? {};
const numberKeys = Object.keys(types).filter((key) => types[key] === "number");
const dateKeys = Object.keys(types).filter((key) => types[key] === "date");
// 取不到值的键：`notes` 没有任何来源；`well` 只在文件名带 `_wellX1` 段时存在。
const NULLABLE = ["notes", "well"];
const textKeys = expectedKeys.filter((key) => !numberKeys.includes(key) && !dateKeys.includes(key) && key !== "tags" && !NULLABLE.includes(key));

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

console.log(`dir=${dir}\n期望键序列（frontmatter 字典）：${expectedKeys.join(", ")}\n`);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
check(files.length === 5, `找到 5 份 sidecar（实际 ${files.length}）`);

for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const lines = text.split("\n");
  check(lines[0] === "---", `${file}: 以 --- 开头`);
  const close = lines.indexOf("---", 1);
  const fm = lines.slice(1, close);
  // 只取顶层键（列表项、嵌套对象都以空格缩进）。
  const keys = fm.filter((l) => !l.startsWith(" ")).map((l) => l.slice(0, l.indexOf(":")));
  check(JSON.stringify(keys) === JSON.stringify(expectedKeys), `${file}: 键序列 == frontmatter 字典，顺序一致`);
  check(keys.every((k) => expectedKeys.includes(k)), `${file}: 没有 frontmatter 之外的键`);

  const lineOf = (k) => fm.find((l) => l.startsWith(`${k}:`)) || "";
  for (const k of numberKeys) check(new RegExp(`^${k}: -?\\d+$`).test(lineOf(k)), `${file}: ${k} 是裸数字（${lineOf(k)}）`);
  for (const k of textKeys) check(new RegExp(`^${k}: ".*"$`).test(lineOf(k)), `${file}: ${k} 是双引号字符串（${lineOf(k)}）`);
  // date 类型：裸日期；btime 是文件落盘时间，带时分秒。
  for (const k of dateKeys) check(new RegExp(`^${k}: \\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2}:\\d{2})?$`).test(lineOf(k)), `${file}: ${k} 是裸日期/时间（${lineOf(k)}）`);
  check(lineOf("tags") === "tags:", `${file}: tags 是列表头`);
  check(lineOf("notes") === "notes:", `${file}: 没有来源的 notes 写 YAML null（${lineOf("notes")}）`);
  check(!text.includes("![["), `${file}: 正文不含 ![[]] 嵌入`);
  check(text.includes("缩略图：[[") && text.includes("原图（用系统默认程序打开）：[["), `${file}: 正文是两条可点击链接`);
}

const noWell = fs.readFileSync(path.join(dir, "plate02_4000x_012.md"), "utf8");
check(noWell.includes("\nwell:\n"), "plate02_4000x_012（无 well 段）: well 保留键、写 YAML null");
const withWell = fs.readFileSync(path.join(dir, "plate01_wellA3_4000x_007.md"), "utf8");
check(withWell.includes('\nwell: "A3"\n'), "plate01_wellA3_4000x_007: well 是双引号字符串");

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
console.log("VERIFY-FRONTMATTER OK");
