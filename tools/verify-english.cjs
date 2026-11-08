#!/usr/bin/env node
/**
 * verify-english — enforce the English-only UI policy for plugin-authored text.
 *
 * Parses `main.ts` and every TypeScript file under `src/` with the TypeScript compiler and
 * fails on any string literal / template-literal chunk containing CJK text. Code
 * comments and regular-expression literals are intentionally ignored: comments are
 * not user-facing, and the slug regex keeps its CJK range as a behavior detail.
 *
 * Every file under `src/defaults/` is shipped with the plugin, so it is scanned
 * verbatim (comments included): presets, the built-in `.base` template and the
 * default rule files must all be English too.
 *
 * The root `README.md` is the public plugin blurb the community directory pulls, so
 * its English region — everything before the intentional `## 中文说明` heading — is
 * scanned for CJK as well. The bilingual section from that heading onwards is
 * intentional content and is never flagged.
 *
 *   node tools/verify-english.cjs
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
// Ideographs plus CJK punctuation (U+3000-303F) and fullwidth forms (U+FF00-FFEF).
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
let pass = 0;
let fail = 0;

function check(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${message}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${message}`);
  }
}

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, predicate));
    else if (predicate(abs)) out.push(abs);
  }
  return out;
}

// The community directory excerpts the root README, so everything before the
// intentional `## 中文说明` heading must be English. The bilingual section from that
// heading onwards is by design and is never scanned.
const README_PATH = path.join(repoRoot, "README.md");
const README_CHINESE_HEADING = "## 中文说明";

function scanReadmeEnglishRegion(text) {
  const markerIndex = text.indexOf(README_CHINESE_HEADING);
  if (markerIndex === -1) return { hasMarker: false, hits: [], chineseSection: "" };
  const englishRegion = text.slice(0, markerIndex);
  const chineseSection = text.slice(markerIndex + README_CHINESE_HEADING.length);
  const hits = [];
  englishRegion.split(/\r?\n/).forEach((line, index) => {
    if (CJK.test(line)) hits.push(`README.md:${index + 1} ${line.trim()}`);
  });
  return { hasMarker: true, hits, chineseSection };
}

function scanTypeScriptText(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = [];
  const visit = (node) => {
    const isTextNode =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isTextNode && CJK.test(node.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      hits.push(`${path.relative(repoRoot, file)}:${line + 1} ${JSON.stringify(node.text)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function scanTypeScript(file) {
  return scanTypeScriptText(file, fs.readFileSync(file, "utf8"));
}

function scanShippedText(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!CJK.test(text)) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => CJK.test(line))
    .map(({ line, index }) => `${path.relative(repoRoot, file)}:${index + 1} ${line.trim()}`);
}

// Negative fixture: the scanner itself must see CJK punctuation and fullwidth forms,
// not just ideographs. Without this, a narrow class can silently let `：` / `；` through.
const NEGATIVE_FIXTURE = 'const separators = ["：", "；", "、", "「」", "（）"];';
const fixtureFile = path.join(repoRoot, "tools", "__negative_fixture__.ts");
const fixtureHits = scanTypeScriptText(fixtureFile, NEGATIVE_FIXTURE);
check(fixtureHits.length === 5, "negative fixture: CJK punctuation / fullwidth forms are detected (5 literals)");
if (fixtureHits.length !== 5) for (const hit of fixtureHits) console.log(`      ${hit}`);

// Negative fixture: a mechanical-translation leftover in the README English region
// must be rejected, while the same kind of text inside the intentional Chinese
// section must not produce a hit.
const README_NEGATIVE_FIXTURE = [
  "# Annex Gallery",
  "",
  "It reads the preset files you 登记 ed.",
  "",
  "## 中文说明",
  "",
  "这里是按设计保留的中文说明。",
].join("\n");
const readmeNegative = scanReadmeEnglishRegion(README_NEGATIVE_FIXTURE);
check(
  readmeNegative.hasMarker && readmeNegative.hits.length === 1,
  "negative fixture: CJK in the README English region is rejected (1 hit)",
);
if (readmeNegative.hits.length !== 1) for (const hit of readmeNegative.hits) console.log(`      ${hit}`);

// Positive fixture: the same content with the English region corrected must pass,
// proving the intentional Chinese section alone is accepted.
const README_POSITIVE_FIXTURE = [
  "# Annex Gallery",
  "",
  "It reads the preset files you registered.",
  "",
  "## 中文说明",
  "",
  "这里是按设计保留的中文说明。",
].join("\n");
const readmePositive = scanReadmeEnglishRegion(README_POSITIVE_FIXTURE);
check(
  readmePositive.hasMarker && readmePositive.hits.length === 0,
  "positive fixture: the intentional Chinese section is accepted (0 hits)",
);
if (readmePositive.hits.length !== 0) for (const hit of readmePositive.hits) console.log(`      ${hit}`);

console.log("English-only UI text check (main.ts + src/** + src/defaults/**)");

const tsFiles = [
  path.join(repoRoot, "main.ts"),
  ...walkFiles(path.join(repoRoot, "src"), (file) => file.endsWith(".ts") && !file.endsWith(".d.ts")),
];
let hits = [];
for (const file of tsFiles) hits.push(...scanTypeScript(file));
check(hits.length === 0, `no CJK/Chinese punctuation in user-facing string literals (${tsFiles.length} TS file(s))`);
if (hits.length > 0) for (const hit of hits.slice(0, 40)) console.log(`      ${hit}`);

const shippedFiles = walkFiles(path.join(repoRoot, "src", "defaults"), () => true);
let shippedHits = [];
for (const file of shippedFiles) shippedHits.push(...scanShippedText(file));
check(shippedHits.length === 0, `no CJK/Chinese punctuation in shipped defaults (${shippedFiles.length} file(s))`);
if (shippedHits.length > 0) for (const hit of shippedHits.slice(0, 40)) console.log(`      ${hit}`);

console.log(`README English region check (everything before ${README_CHINESE_HEADING})`);
const readme = scanReadmeEnglishRegion(fs.readFileSync(README_PATH, "utf8"));
check(readme.hasMarker, `README has the intentional Chinese section heading (${README_CHINESE_HEADING})`);
if (readme.hasMarker) {
  check(readme.hits.length === 0, "no CJK/Chinese punctuation in the README English region");
  if (readme.hits.length > 0) for (const hit of readme.hits.slice(0, 40)) console.log(`      ${hit}`);
  check(CJK.test(readme.chineseSection), "the intentional Chinese section is retained (non-empty)");
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) {
  console.log("VERIFY-ENGLISH FAILED");
  process.exit(1);
}
console.log("VERIFY-ENGLISH OK");
