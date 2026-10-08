#!/usr/bin/env node
/**
 * T-008#B-007 程序化校验：合成语料产出的 sidecar frontmatter 是否符合 profile。
 *
 *   node tools/example-profiles/verify-frontmatter.cjs [dir]
 *
 * 期望直接读自 plate-profile.json（keyOrder / fields），逐份断言：
 *   - 顶层键序列 == keyOrder 里「能取到值」的键（此处 = keyOrder 去掉 "notes"），顺序一致
 *   - number 字段是裸数字；text 字段是双引号字符串；date 裸；tags 是列表
 *   - 没有 keyOrder 之外的键；"notes" 被省略
 *   - 正文是两条可点击链接，不含 ![[]] 嵌入
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "/tmp/annex-gallery-b007/vault/20260417-plate-run";
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, "plate-profile.json"), "utf8"))[0];

// 无任何来源（解析/派生/自动/常量/询问都取不到）⇒ keyOrder 里写了也会被省略。
const UNRESOLVABLE = ["notes"];
const expectedKeys = profile.keyOrder.filter((k) => !UNRESOLVABLE.includes(k));

const NUMBER_KEYS = new Set(profile.fields.filter((f) => f.type === "number").map((f) => f.key ?? f.group));
for (const k of ["width", "height", "size"]) NUMBER_KEYS.add(k);
const TEXT_KEYS = new Set(profile.fields.filter((f) => (f.type ?? "text") === "text").map((f) => f.key ?? f.group));
for (const k of ["thumbnail", "tif"]) TEXT_KEYS.add(k);

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

console.log(`dir=${dir}\n期望键序列（keyOrder 去掉 notes）：${expectedKeys.join(", ")}\n`);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
check(files.length === 5, `找到 5 份 sidecar（实际 ${files.length}）`);

for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const lines = text.split("\n");
  check(lines[0] === "---", `${file}: 以 --- 开头`);
  const close = lines.indexOf("---", 1);
  const fm = lines.slice(1, close);
  const keys = fm.filter((l) => !l.startsWith(" ")).map((l) => l.slice(0, l.indexOf(":")));
  check(JSON.stringify(keys) === JSON.stringify(expectedKeys), `${file}: 键序列 == keyOrder（去掉 notes），顺序一致`);
  check(!keys.includes("notes"), `${file}: "notes" 被省略`);
  check(keys.every((k) => profile.keyOrder.includes(k)), `${file}: 没有 keyOrder 之外的键`);

  const lineOf = (k) => fm.find((l) => l.startsWith(`${k}:`)) || "";
  for (const k of NUMBER_KEYS) check(new RegExp(`^${k}: -?\\d+$`).test(lineOf(k)), `${file}: ${k} 是裸数字（${lineOf(k)}）`);
  for (const k of TEXT_KEYS) check(new RegExp(`^${k}: ".*"$`).test(lineOf(k)), `${file}: ${k} 是双引号字符串（${lineOf(k)}）`);
  check(/^date: \d{4}-\d{2}-\d{2}$/.test(lineOf("date")), `${file}: date 是裸日期（${lineOf("date")}）`);
  check(lineOf("tags") === "tags:", `${file}: tags 是列表头`);
  check(!text.includes("![["), `${file}: 正文不含 ![[]] 嵌入`);
  check(text.includes("缩略图：[[") && text.includes("原图（用系统默认程序打开）：[["), `${file}: 正文是两条可点击链接`);
}

const noWell = fs.readFileSync(path.join(dir, "plate02_4000x_012.md"), "utf8");
check(noWell.includes('well: ""'), "plate02_4000x_012（无 well 段）: well 写空串 whenMissing");

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
console.log("VERIFY-FRONTMATTER OK");
