/**
 * 模板：metadata 模板（sidecar `.md` 的整份文本）与画廊模板（`.base`）。
 *
 * - **内置模板**以普通文件放在 `src/defaults/metadata/*.md` 与 `src/defaults/base/*.base`，
 *   构建时由 esbuild 的 `defaults-text` 插件内联成字符串（和 `.gitattributes` 同一条路）——
 *   源码里只有这一份，设置页把它原样展示出来（只读，可「复制为自定义」）。
 * - **自定义模板**是 vault 里的文件，设置里只登记 `{ id, name, path }`（path 相对 vault）。
 *
 * 占位符一律 `{{name}}`。取不到值的占位符替换成空串，并把名字交还给调用方记进报告 ——
 * 不让一个笔误（`{{fooo}}`）把整批生成弄失败。模板本身坏了（文件不存在、metadata 模板没有
 * `{{frontmatter}}`、`.base` 填完占位符后 YAML 解析不了）才整体停下。
 */
import * as fs from "fs";
import * as path from "path";
import metadataDefault from "../defaults/metadata/default.md";
import metadataEmbed from "../defaults/metadata/embed.md";
import baseDefault from "../defaults/base/default.base";

export type TemplateKind = "metadata" | "base";

/** 设置里登记的一份自定义模板。 */
export interface TemplateRef {
  /** 稳定 id（folder 记忆与 profile.metadataTemplate 用它当键）。 */
  id: string;
  /** 人读名字。 */
  name: string;
  /** 相对 vault 根的路径，正斜杠。 */
  path: string;
}

export interface BuiltinTemplate {
  id: string;
  name: string;
  text: string;
}

/** 解析出来、可以直接用的一份模板文本。 */
export interface ResolvedTemplate {
  id: string;
  /** 报错时用来指明是哪份模板（内置写「内置模板 <id>」，自定义写 vault 路径）。 */
  label: string;
  text: string;
}

export const DEFAULT_TEMPLATE_ID = "default";

export const BUILTIN_METADATA_TEMPLATES: BuiltinTemplate[] = [
  { id: "default", name: "默认（缩略图链接 + 原图链接）", text: metadataDefault },
  { id: "embed", name: "嵌入缩略图（![[…]] + 原图链接）", text: metadataEmbed },
];

export const BUILTIN_BASE_TEMPLATES: BuiltinTemplate[] = [
  { id: "default", name: "默认（卡片：文件名 + 缩略图）", text: baseDefault },
];

export function builtinTemplates(kind: TemplateKind): BuiltinTemplate[] {
  return kind === "metadata" ? BUILTIN_METADATA_TEMPLATES : BUILTIN_BASE_TEMPLATES;
}

/** 内置 + 自定义的 id/名字列表（下拉框用）；自定义 id 与内置同名时内置优先。 */
export function listTemplates(kind: TemplateKind, custom: TemplateRef[]): Array<{ id: string; name: string; builtin: boolean }> {
  const builtins = builtinTemplates(kind);
  const taken = new Set(builtins.map((entry) => entry.id));
  return [
    ...builtins.map((entry) => ({ id: entry.id, name: entry.name, builtin: true })),
    ...custom.filter((entry) => !taken.has(entry.id)).map((entry) => ({ id: entry.id, name: entry.name, builtin: false })),
  ];
}

/**
 * 按 id 取一份模板的文本：先内置，再自定义（读 vault 里的文件）。
 * 找不到 / 读不了 ⇒ 抛错，错误里带模板名或文件路径（不静默回退到内置默认）。
 */
export function resolveTemplate(kind: TemplateKind, id: string, custom: TemplateRef[], vaultRoot: string): ResolvedTemplate {
  const builtin = builtinTemplates(kind).find((entry) => entry.id === id);
  if (builtin !== undefined) return { id, label: `内置模板 ${id}`, text: builtin.text };
  const ref = custom.find((entry) => entry.id === id);
  if (ref === undefined) throw new Error(`找不到${kind === "metadata" ? " metadata " : "画廊"}模板「${id}」（设置页「模板」里看有哪些）`);
  return readTemplateFile(path.join(vaultRoot, ref.path), ref.path, id);
}

/** 直接读一份模板文件（CLI 的 `--template <file>` 也走这里）。 */
export function readTemplateFile(abs: string, label: string, id = label): ResolvedTemplate {
  try {
    return { id, label, text: fs.readFileSync(abs, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`模板 ${label} 读不了：${message}`);
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** 模板里出现过的占位符名（去重，按出现顺序）。 */
export function placeholdersOf(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) seen.add(match[1]);
  return [...seen];
}

/**
 * 替换占位符。`lookup` 返回 `undefined` ⇒ 换成空串，名字进 `missing`（调用方记进报告）。
 */
export function fillPlaceholders(text: string, lookup: (name: string) => string | undefined): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = lookup(name);
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return value;
  });
  return { text: filled, missing };
}

/**
 * metadata 模板的硬约束：第一行必须是 `{{frontmatter}}`（frontmatter 由 profile 生成，
 * 只能在文件开头），且只出现一次。不满足 ⇒ 抛错（带 label）。
 */
export function checkMetadataTemplate(template: ResolvedTemplate): void {
  const first = template.text.replace(/^﻿/, "").split(/\r?\n/, 1)[0].trim();
  if (!/^\{\{\s*frontmatter\s*\}\}$/.test(first)) {
    throw new Error(`metadata 模板 ${template.label} 的第一行必须是 {{frontmatter}}（frontmatter 只能写在文件开头）`);
  }
  const count = [...template.text.matchAll(/\{\{\s*frontmatter\s*\}\}/g)].length;
  if (count !== 1) throw new Error(`metadata 模板 ${template.label} 里 {{frontmatter}} 出现了 ${count} 次（只能 1 次）`);
}
