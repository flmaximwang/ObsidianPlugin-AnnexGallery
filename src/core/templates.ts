/**
 * 画廊模板（`.base`）。元数据 sidecar 的正文由预设的 `template` 指向 vault `.md`，
 * 不在这里登记（见 src/core/profile-files.ts）。
 *
 * **运行时唯一事实来源是 vault 里的外部文件**：设置里登记 `{ id, name, path }`
 * （`path` 相对 vault）。`PRESET_*` / `BUILTIN_*` 只是「从预设创建」的素材，
 * 不是可用模板列表，也**不参与任何运行时 fallback** —— 找不到已登记模板就报错，
 * 让用户去设置页创建/登记外部文件。
 *
 * 占位符一律 `{{name}}`。取不到值的占位符替换成空串，并把名字交还给调用方记进报告 ——
 * 不让一个笔误（`{{fooo}}`）把整批生成弄失败。模板本身坏了（文件不存在、路径越界、
 * `.base` 填完占位符后 YAML 解析不了）才整体停下。
 */
import * as fs from "fs";
import baseDefault from "../defaults/base/default.base";
import { readVaultTextFile } from "./external-files";

export type TemplateKind = "base";

/** 设置里登记的一份自定义模板。 */
export interface TemplateRef {
  /** 稳定 id（folder 记忆用它当键）。 */
  id: string;
  /** 人读名字。 */
  name: string;
  /** 相对 vault 根的路径，正斜杠。 */
  path: string;
}

/** 预设素材：只用于「从预设创建」一份独立的外部模板文件。 */
export interface TemplatePreset {
  id: string;
  name: string;
  text: string;
}

/** @deprecated 旧名字；语义已是「预设素材」，不是可用内置模板。 */
export type BuiltinTemplate = TemplatePreset;

/** 解析出来、可以直接用的一份模板文本。 */
export interface ResolvedTemplate {
  id: string;
  /** 报错时用来指明是哪份模板（外部模板写 vault 相对路径）。 */
  label: string;
  text: string;
}

/** 已登记模板的下拉列表项。运行时没有内置条目，`builtin` 恒为 false。 */
export interface TemplateListEntry {
  id: string;
  name: string;
  path: string;
  /** 兼容旧调用点的字段；运行时不存在内置模板，所以恒为 false。 */
  builtin: false;
}

/** 预设 material 的 id（不是运行时默认值；运行时没有 fallback）。 */
export const DEFAULT_TEMPLATE_ID = "default";

/** 预设素材（画廊 `.base`）——只用于「从预设创建」。 */
export const PRESET_BASE_TEMPLATES: TemplatePreset[] = [
  { id: "default", name: "默认（卡片：文件名 + 缩略图）", text: baseDefault },
];

/** @deprecated 旧名字，转发到 `PRESET_BASE_TEMPLATES`。 */
export const BUILTIN_BASE_TEMPLATES: TemplatePreset[] = PRESET_BASE_TEMPLATES;

/** 某个 kind 的预设素材。 */
export function presetTemplates(_kind: TemplateKind): TemplatePreset[] {
  return PRESET_BASE_TEMPLATES;
}

/**
 * @deprecated 旧名字，转发到 `presetTemplates`。
 * 返回的是**预设素材**，不是运行时可用模板；设置页不应再把它列为可直接使用的模板。
 */
export function builtinTemplates(kind: TemplateKind): TemplatePreset[] {
  return presetTemplates(kind);
}

/**
 * 已登记外部模板的 id/名字列表（下拉框用）。
 * 只返回 `registered` 里的条目；不读文件、不检查路径 —— 列表要能显示坏条目让用户修复。
 * 运行时解析（`resolveTemplate`）才做路径/存在性/重复检查。
 */
export function listTemplates(_kind: TemplateKind, registered: readonly TemplateRef[]): TemplateListEntry[] {
  return registered.map((entry) => ({ id: entry.id, name: entry.name, path: entry.path, builtin: false }));
}

/**
 * 按 id 取一份**已登记外部模板**的文本：路径校验 + 文件存在 + 读盘，每次调用都重新做。
 *
 * 找不到 ⇒ 抛错并引导去设置页登记；id 重复登记、路径不安全、扩展名不对、文件不存在
 * ⇒ 抛错。**不会回退到预设/内置内容**。
 */
export function resolveTemplate(
  kind: TemplateKind,
  id: string,
  registered: readonly TemplateRef[],
  vaultRoot: string,
): ResolvedTemplate {
  const kindName = "画廊模板";
  const matches = registered.filter((entry) => entry.id === id);
  if (matches.length === 0) {
    throw new Error(`找不到 ${kindName}「${id}」（请在设置页「模板」里登记或从预设创建外部文件）`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${kindName} id「${id}」重复登记：${matches.map((entry) => entry.path).join("、")}（请删掉多余的一条）`,
    );
  }

  const ref = matches[0];
  const file = readVaultTextFile(vaultRoot, ref.path, kind);
  return { id: ref.id, label: file.relPath, text: file.text };
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

export { PLACEHOLDER, exactPlaceholder, fillPlaceholders, placeholdersOf } from "./placeholders";



