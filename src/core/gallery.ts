/**
 * 「创建画廊 / Create Gallery」的核心（不 import obsidian）：
 *
 *   1. `planGallery`     只读盘点：sidecar 数、没打标签的旧 sidecar、缺 sidecar 的图、缺缩略图的 sidecar、
 *                        sidecar 里实际出现过的 frontmatter 键；
 *   2. `addGalleryTag`   给旧 sidecar 只补一个 `annex-gallery-metadata` 标签（文本级最小改动，别的字节不动）；
 *   3. `buildGalleryBase` 画廊模板填占位符 → YAML 校验 → 把插件的作用域并进顶层 `filters`。
 *
 * 作用域（用户 2026-10-31 口径）：顶层 `filters` 永远是
 * `and: [file.inFolder(<文件夹>), file.hasTag("annex-gallery-metadata"), <模板自己的 filters>]` ——
 * 模板只能收窄、不能放宽。
 */
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from "yaml";
import { GALLERY_TAG } from "./sidecar";
import { collectImages, stemOf } from "./stems";
import { fillPlaceholders, type ResolvedTemplate } from "./templates";

export interface GalleryPlan {
  dir: string;
  /** 目录里（递归）的源图片数。 */
  images: number;
  /** 已带 GALLERY_TAG 的 sidecar 数（画廊里会出现的）。 */
  tagged: number;
  /** 有 `tif` 键、却没有 GALLERY_TAG 的旧 sidecar（绝对路径）。 */
  untagged: string[];
  /** 没有同名 `<stem>.md` 的图片数。 */
  missingSidecars: number;
  /** sidecar（带标签或旧的）旁边没有 `<stem>.thumbnail.png` 的份数。 */
  missingThumbnails: number;
  /** sidecar frontmatter 里出现过的键（首次出现顺序，未排序）。 */
  keys: string[];
}

/** 递归列 `.md`（跳过 `.git` / `.obsidian` 这类点目录；软链也算）。 */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out.sort();
}

/** 文件开头 `---` … `---` 之间的那段（没有 frontmatter ⇒ null）。 */
function frontmatterBlock(text: string): { body: string; start: number; end: number } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  if (m === null) return null;
  return { body: m[1], start: 4, end: 4 + m[1].length };
}

function readFrontmatter(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const block = frontmatterBlock(text);
  if (block === null) return null;
  try {
    const data: unknown = parseYaml(block.body);
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tagsOf(fm: Record<string, unknown>): string[] {
  const raw = fm.tags;
  if (Array.isArray(raw)) return raw.map((tag) => String(tag).replace(/^#/, ""));
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter((tag) => tag !== "").map((tag) => tag.replace(/^#/, ""));
  return [];
}

/** 只读盘点（不写盘）。 */
export function planGallery(dir: string): GalleryPlan {
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const untagged: string[] = [];
  const mdByStem = new Set<string>();
  let tagged = 0;
  let missingThumbnails = 0;

  for (const file of collectMarkdown(dir)) {
    mdByStem.add(path.join(path.dirname(file), path.basename(file, path.extname(file))));
    const fm = readFrontmatter(file);
    if (fm === null) continue;
    const isTagged = tagsOf(fm).includes(GALLERY_TAG);
    const isOld = !isTagged && Object.prototype.hasOwnProperty.call(fm, "tif");
    if (!isTagged && !isOld) continue;
    if (isTagged) tagged += 1;
    else untagged.push(file);
    for (const key of Object.keys(fm)) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        keys.push(key);
      }
    }
    const stem = path.basename(file, path.extname(file));
    if (!fs.existsSync(path.join(path.dirname(file), `${stem}.thumbnail.png`))) missingThumbnails += 1;
  }

  const images = collectImages(dir);
  const missingSidecars = images.filter((image) => !mdByStem.has(path.join(path.dirname(image), stemOf(image)))).length;
  return { dir, images: images.length, tagged, untagged, missingSidecars, missingThumbnails, keys };
}

/**
 * 键排序：按 profile 的 keyOrder 依次归位（先出现的 profile 优先），keyOrder 里都没有的键
 * 按首次出现顺序排在最后。
 */
export function orderProperties(keys: string[], keyOrders: string[][]): string[] {
  const found = new Set(keys);
  const out: string[] = [];
  for (const order of keyOrders) {
    for (const key of order) {
      if (found.has(key) && !out.includes(key)) out.push(key);
    }
  }
  for (const key of keys) if (!out.includes(key)) out.push(key);
  return out;
}

/**
 * 给一份 sidecar 只补 GALLERY_TAG（放在 tags 列表第一项）；已经有了 ⇒ 原样返回。
 *
 * 文本级改动，不经 YAML 重写 —— 别的键的引号、顺序、空行一个字节都不动。
 * 没有 frontmatter ⇒ 返回 null（不是 sidecar，不碰）。
 */
export function addGalleryTag(text: string): string | null {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const raw = bom === "" ? text : text.slice(1);
  const block = frontmatterBlock(raw);
  if (block === null) return null;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.body.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => /^tags\s*:/.test(line));
  const item = (indent: string): string => `${indent}- ${GALLERY_TAG}`;

  if (keyIndex === -1) {
    lines.unshift("tags:", item("  "));
  } else {
    const rest = lines[keyIndex].replace(/^tags\s*:/, "").trim();
    if (rest === "") {
      // 块列表：已有项照旧，GALLERY_TAG 插在最前面，缩进跟已有项一致。
      const next = lines[keyIndex + 1];
      const indentMatch = next === undefined ? null : /^(\s*)-\s/.exec(next);
      const existing: string[] = [];
      for (let i = keyIndex + 1; i < lines.length; i += 1) {
        const m = /^\s*-\s*(.*)$/.exec(lines[i]);
        if (m === null) break;
        existing.push(m[1].trim().replace(/^["']|["']$/g, "").replace(/^#/, ""));
      }
      if (existing.includes(GALLERY_TAG)) return text;
      lines.splice(keyIndex + 1, 0, item(indentMatch === null ? "  " : indentMatch[1]));
    } else {
      // 行内值（`tags: a` / `tags: [a, b]`）：改写成块列表，GALLERY_TAG 打头。
      let values: string[];
      try {
        const parsed: unknown = parseYaml(rest);
        values = Array.isArray(parsed) ? parsed.map(String) : parsed === null ? [] : [String(parsed)];
      } catch {
        values = [rest];
      }
      values = values.map((value) => value.replace(/^#/, ""));
      if (values.includes(GALLERY_TAG)) return text;
      lines.splice(keyIndex, 1, "tags:", item("  "), ...values.map((value) => `  - ${value}`));
    }
  }
  const before = raw.slice(0, block.start);
  const after = raw.slice(block.end);
  return `${bom}${before}${lines.join(eol)}${after}`;
}

/** 画廊文件的 vault 相对路径：`<文件夹>/<文件夹名>.base`；vault 根 ⇒ `<vaultName>.base`。 */
export function galleryFilePath(folderPath: string, vaultName: string): string {
  const folder = folderPath === "/" ? "" : folderPath.replace(/\/+$/, "");
  if (folder === "") return `${vaultName}.base`;
  return `${folder}/${folder.split("/").pop() ?? folder}.base`;
}

export interface GalleryBaseInput {
  /** 画廊所在文件夹（vault 相对，vault 根给 ""）。 */
  folder: string;
  /** = 设置里的缩略图边长。 */
  cardSize: number;
  /** 已排好序的元数据键（`{{properties}}`）。 */
  properties: string[];
}

export interface GalleryBaseBuild {
  text: string;
  /** 取不到值、被留空的占位符。 */
  missing: string[];
}

/**
 * 模板 → 最终 `.base` 文本。
 *
 * 占位符：`{{folder}}`（原样路径，要不要引号由模板决定）· `{{cardSize}}` ·
 * `{{properties}}`（JSON 数组 = YAML 流式列表，键名带逗号/括号也安全）。
 * 填完后 YAML 解析不了、顶层不是映射、没有 `views` 列表 ⇒ 抛错（带模板 label）。
 */
export function buildGalleryBase(template: ResolvedTemplate, input: GalleryBaseInput): GalleryBaseBuild {
  const filled = fillPlaceholders(template.text, (name) => {
    if (name === "folder") return input.folder;
    if (name === "cardSize") return String(input.cardSize);
    if (name === "properties") return JSON.stringify(input.properties);
    return undefined;
  });

  const doc = parseDocument(filled.text);
  if (doc.errors.length > 0) {
    throw new Error(`画廊模板 ${template.label} 填完占位符后不是合法 YAML：${doc.errors[0].message.split("\n")[0]}`);
  }
  if (!isMap(doc.contents)) throw new Error(`画廊模板 ${template.label} 的顶层必须是映射（filters / views …）`);
  const root = doc.contents as YAMLMap;
  if (!isSeq(root.get("views", true))) throw new Error(`画廊模板 ${template.label} 缺少 views 列表`);

  const scope: string[] = [];
  if (input.folder !== "") scope.push(`file.inFolder(${JSON.stringify(input.folder)})`);
  scope.push(`file.hasTag(${JSON.stringify(GALLERY_TAG)})`);
  const andSeq = new YAMLSeq();
  for (const expr of scope) andSeq.items.push(doc.createNode(expr));
  const own = root.get("filters", true);
  if (own !== undefined && own !== null) andSeq.items.push(own);
  const filters = new YAMLMap();
  filters.set("and", andSeq);

  root.delete("filters");
  // 模板开头的注释挂在第一个键上；插到 filters 前面之前先把它提到文档头，免得注释被夹在中间。
  const firstKey = root.items[0]?.key as { commentBefore?: string | null } | undefined;
  if (firstKey !== undefined && firstKey !== null && typeof firstKey.commentBefore === "string" && firstKey.commentBefore !== "") {
    doc.commentBefore = doc.commentBefore ? `${doc.commentBefore}\n${firstKey.commentBefore}` : firstKey.commentBefore;
    firstKey.commentBefore = null;
  }
  root.items.unshift(doc.createPair("filters", filters));
  return { text: doc.toString({ lineWidth: 0 }), missing: filled.missing };
}
