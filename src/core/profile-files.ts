/**
 * 元数据预设（preset）的外部文件 loader。
 *
 * 冻结 spec（ticket qij）：
 * - 设置里只登记 vault 内的 `.json` 路径，**每条预设一个独立文件**，顶层必须是一条
 *   `ParseProfile` 对象（不接受数组、不接受 `{ profiles: [...] }` —— 后者是旧 CLI 的
 *   多 profile 文件格式，已废弃）。
 * - 预设的 `id` / `name` / frontmatter 等全部以 JSON 内容为准；登记项不保存 id，避免两处不一致。
 * - 预设的 `template` 指向 vault 里的正文 `.md`：必须存在、在 vault 内、不能自带 frontmatter；
 *   `""` / 不写 ⇒ sidecar 只有 frontmatter。
 * - 跨文件 id 重复、JSON 语法错误、`validateProfile` 的 error、文件缺失/越界、正文模板坏了，
 *   任何一项都是硬错误：整次操作停止，错误里带具体文件路径。不跳过坏条目、不静默回退。
 * - 旧格式（2.0 及更早：keyOrder / fields / constFields / metadataTemplate …）不迁移，
 *   加载时给出明确错误，设置页据此显示「从预设创建」的引导。
 * - 同步、无缓存：每次生成操作都重新调用 `loadProfileFiles`，外部保存后的修改立即生效。
 */
import { readVaultTextFile } from "./external-files";
import {
  legacyProfileKeys,
  legacyProfileMessage,
  validateProfile,
  type ParseProfile,
  type ProfileIssue,
} from "./profiles";

/** 设置里登记的一条外部预设。id/name 由 JSON 读取，所以这里只有路径。 */
export interface ProfileFileRef {
  /** vault 相对路径，正斜杠。文件必须存在且顶层是一条 `ParseProfile` 对象。 */
  path: string;
}

/** 一份外部预设的正文模板（已读入）。 */
export interface ProfileBody {
  /** vault 相对路径（正斜杠、规范化后）。 */
  relPath: string;
  /** 文件原文。 */
  text: string;
}

/** 一份成功读取并通过校验的外部预设。 */
export interface LoadedProfile {
  /** JSON 原文（authoritative id/name/regex/frontmatter …）。 */
  profile: ParseProfile;
  /** vault 相对路径（正斜杠、规范化后）。错误信息与 UI 用它定位文件。 */
  path: string;
  /** 本地绝对路径（「用系统默认应用打开」用）。 */
  absPath: string;
  /** `profile.template` 指向的正文模板（没有 template 时为 undefined）。 */
  body?: ProfileBody;
}

/** 设置页用的非抛错检查结果：结构、正文、告警都在这里，坏条目也能显示原因。 */
export interface ProfileInspection {
  /** 尽量规范化后的 vault 相对路径（路径本身非法时就是原样输入）。 */
  relPath: string;
  /** 本地绝对路径（读文件成功时才有）。 */
  absPath?: string;
  /** JSON 解析成功且是新格式时的预设对象（校验不过也尽量给出，便于显示 name/id）。 */
  profile?: ParseProfile;
  /** 正文模板（读入成功时才有）。 */
  body?: ProfileBody;
  /** 发现旧格式顶层键时为这些键名。 */
  legacyKeys: string[];
  issues: ProfileIssue[];
}

const LABEL = "元数据预设";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 正文模板不能自带 frontmatter（frontmatter 由预设的 frontmatter 字典生成）。 */
export function startsWithFrontmatter(text: string): boolean {
  return /^﻿?---[ \t]*(\r?\n|$)/.test(text);
}

/** 正文模板文件本身是否可读、且不带 frontmatter；返回问题或正文。 */
function readBody(vaultRoot: string, relPath: string): { body?: ProfileBody; issues: ProfileIssue[] } {
  const issues: ProfileIssue[] = [];
  try {
    const file = readVaultTextFile(vaultRoot, relPath, "metadata");
    if (startsWithFrontmatter(file.text)) {
      issues.push({
        level: "error",
        message: `正文模板 ${file.relPath} 不能自带 frontmatter（frontmatter 由预设的 frontmatter 字典生成）`,
      });
      return { issues };
    }
    return { body: { relPath: file.relPath, text: file.text }, issues };
  } catch (error) {
    issues.push({ level: "error", message: errText(error) });
    return { issues };
  }
}

/**
 * 把 data.json 里的 `profileFiles` 收敛成 `{ path }` 列表。
 * 只做结构清理（非法条目/空路径丢掉），**不检查路径安全性，也不读文件** ——
 * 真正的校验发生在 `loadProfileFiles` / `resolveVaultFile`，错误必须可见。
 */
export function profileFileRefs(value: unknown): ProfileFileRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({ path: typeof entry.path === "string" ? entry.path.trim() : "" }))
    .filter((entry) => entry.path !== "");
}

/** 一份预设 JSON 文本的解析结果（不含正文模板的读盘检查）。 */
export interface ProfileDocumentInspection {
  /** JSON 解析成功且是新格式时的预设对象。 */
  profile?: ParseProfile;
  /** 出现过的旧格式顶层键（空数组 ⇒ 不是旧格式）。 */
  legacyKeys: string[];
  issues: ProfileIssue[];
}

/**
 * 解析一份预设 JSON 文本 —— 插件 loader 与 CLI 共用，避免两边各写一份结构检查。
 *
 * 只做文本 / 结构层：BOM、JSON 语法、顶层必须是单个对象、拒绝 `{ profiles: [...] }`、
 * 旧格式键。字段级校验由调用方接着跑 `validateProfile`（正文模板的读盘检查也由调用方做）。
 */
export function parseProfileDocument(text: string, label: string): ProfileDocumentInspection {
  let data: unknown;
  try {
    // JSON 文件常带 UTF-8 BOM（Windows 编辑器）；先剥掉再 parse。
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { legacyKeys: [], issues: [{ level: "error", message: `${LABEL} ${label} 不是合法 JSON：${errText(error)}` }] };
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      legacyKeys: [],
      issues: [{ level: "error", message: `${LABEL} ${label} 的顶层必须是单条预设对象（不能是数组或其它类型）` }],
    };
  }
  const maybeWrapper = data as { profiles?: unknown };
  if (Array.isArray(maybeWrapper.profiles) && !("regex" in data)) {
    return {
      legacyKeys: [],
      issues: [
        {
          level: "error",
          message: `${LABEL} ${label} 的顶层必须是单条预设对象（不接受 { profiles: [...] } 多预设文件）`,
        },
      ],
    };
  }

  const legacyKeys = legacyProfileKeys(data);
  if (legacyKeys.length > 0) {
    return {
      legacyKeys,
      issues: [{ level: "error", message: `${LABEL} ${label}：${legacyProfileMessage(legacyKeys)}` }],
    };
  }

  return { profile: data as ParseProfile, legacyKeys: [], issues: [] };
}

/**
 * 读取并检查一个预设文件，**不抛错**：设置页每行都用它显示错误 / 警告，
 * 坏条目也仍然能「打开」去修。
 */
export function inspectProfileFile(vaultRoot: string, rawPath: string): ProfileInspection {
  let file;
  try {
    file = readVaultTextFile(vaultRoot, rawPath, "profile");
  } catch (error) {
    return { relPath: rawPath, legacyKeys: [], issues: [{ level: "error", message: errText(error) }] };
  }

  const doc = parseProfileDocument(file.text, file.relPath);
  if (doc.profile === undefined) {
    return {
      relPath: file.relPath,
      absPath: file.absPath,
      legacyKeys: doc.legacyKeys,
      issues: doc.issues,
    };
  }

  const profile = doc.profile;
  const issues: ProfileIssue[] = [];

  // 先读正文（如果有 template），再带着正文一起校验占位符。
  let body: ProfileBody | undefined;
  const templatePath = typeof profile.template === "string" ? profile.template.trim() : "";
  if (templatePath !== "") {
    const read = readBody(vaultRoot, templatePath);
    issues.push(...read.issues);
    body = read.body;
  }

  try {
    issues.push(...validateProfile(profile, body === undefined ? {} : { bodyText: body.text }));
  } catch (error) {
    issues.push({ level: "error", message: `校验失败：${errText(error)}` });
  }

  return { relPath: file.relPath, absPath: file.absPath, profile, ...(body === undefined ? {} : { body }), legacyKeys: [], issues };
}

/**
 * 读取并校验单个预设文件。
 * 路径越界 / 扩展名不对 / 文件不存在 / JSON 坏了 / 旧格式 / 校验有 error / 正文模板坏了
 * ⇒ 抛错（带路径）。
 */
export function loadProfileFile(vaultRoot: string, rawPath: string): LoadedProfile {
  const inspected = inspectProfileFile(vaultRoot, rawPath);
  const errors = inspected.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0 || inspected.profile === undefined) {
    const detail = errors.length > 0 ? errors.map((issue) => issue.message).join("；") : `${LABEL} ${rawPath} 无法读取`;
    throw new Error(detail);
  }
  return {
    profile: inspected.profile,
    path: inspected.relPath,
    absPath: inspected.absPath ?? "",
    ...(inspected.body === undefined ? {} : { body: inspected.body }),
  };
}

/**
 * 按登记顺序读取全部预设文件，并检查跨文件 id 重复。
 *
 * 任何一份坏掉都立即抛错（错误包含该文件路径）；重复 id 的错误同时给出两处路径。
 * 空列表 ⇒ 返回空数组（由调用方给出「去设置页登记/从预设创建」的引导）。
 */
export function loadProfileFiles(vaultRoot: string, refs: readonly ProfileFileRef[]): LoadedProfile[] {
  const loaded: LoadedProfile[] = [];
  const firstPathById = new Map<string, string>();

  for (const ref of refs) {
    const entry = loadProfileFile(vaultRoot, ref.path);
    const id = entry.profile.id;
    const previous = firstPathById.get(id);
    if (previous !== undefined) {
      if (previous === entry.path) throw new Error(`${LABEL}文件重复登记：${entry.path}`);
      throw new Error(`${LABEL} id「${id}」重复：${previous} 与 ${entry.path}`);
    }
    firstPathById.set(id, entry.path);
    loaded.push(entry);
  }

  return loaded;
}

/** 在已加载列表里按 id 找一条；找不到返回 undefined（由调用方决定提示文案）。 */
export function findLoadedProfile(loaded: readonly LoadedProfile[], id: string): LoadedProfile | undefined {
  return loaded.find((entry) => entry.profile.id === id);
}
