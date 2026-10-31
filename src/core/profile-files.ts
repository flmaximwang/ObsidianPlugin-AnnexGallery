/**
 * 文件名匹配模板（profile）的外部文件 loader。
 *
 * 冻结 spec（issue 774d7ee）：
 * - 设置里只登记 vault 内的 `.json` 路径，**每条模板一个独立文件**，顶层必须是一条
 *   `ParseProfile` 对象（不接受数组、不接受 `{ profiles: [...] }` —— 后者是 CLI 的
 *   多 profile 文件格式，不属于插件设置）。
 * - profile 的 `id` / `name` 等全部以 JSON 内容为准；登记项不保存 id，避免两处不一致。
 * - 跨文件 id 重复、JSON 语法错误、`validateProfile` 的 error、文件缺失/越界，任何一项
 *   都是硬错误：整次操作停止，错误里带具体文件路径。不跳过坏条目、不静默回退。
 * - 同步、无缓存：每次生成操作都重新调用 `loadProfileFiles`，外部保存后的修改立即生效。
 */
import { readVaultTextFile } from "./external-files";
import { validateProfile, type ParseProfile, type ProfileIssue } from "./profiles";

/** 设置里登记的一条外部文件名匹配模板。id/name 由 JSON 读取，所以这里只有路径。 */
export interface ProfileFileRef {
  /** vault 相对路径，正斜杠。文件必须存在且顶层是一条 `ParseProfile` 对象。 */
  path: string;
}

/** 一份成功读取并通过校验的外部 profile。 */
export interface LoadedProfile {
  /** JSON 原文（authoritative id/name/regex/keyOrder …）。 */
  profile: ParseProfile;
  /** vault 相对路径（正斜杠、规范化后）。错误信息与 UI 用它定位文件。 */
  path: string;
  /** 本地绝对路径（「用系统默认应用打开」用）。 */
  absPath: string;
}

const LABEL = "文件名匹配模板";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * 读取并校验单个 profile JSON 文件。
 * 路径越界 / 扩展名不对 / 文件不存在 / JSON 坏了 / profile 校验有 error ⇒ 抛错（带路径）。
 */
export function loadProfileFile(vaultRoot: string, rawPath: string): LoadedProfile {
  const file = readVaultTextFile(vaultRoot, rawPath, "profile");

  let data: unknown;
  try {
    // JSON 文件常带 UTF-8 BOM（Windows 编辑器）；先剥掉再 parse。
    data = JSON.parse(file.text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${LABEL} ${file.relPath} 不是合法 JSON：${errText(error)}`);
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${LABEL} ${file.relPath} 的顶层必须是单条 ParseProfile 对象（不能是数组或其它类型）`);
  }
  const maybeWrapper = data as { profiles?: unknown };
  if (Array.isArray(maybeWrapper.profiles) && !("regex" in data)) {
    throw new Error(
      `${LABEL} ${file.relPath} 的顶层必须是单条 ParseProfile 对象（不接受 { profiles: [...] } 多 profile 文件）`,
    );
  }

  const profile = data as ParseProfile;
  // 先挡住会让 validateProfile 自己抛 TypeError 的畸形结构，错误仍带文件路径。
  if (typeof profile.regex !== "string") {
    throw new Error(`${LABEL} ${file.relPath} 校验失败：regex 必须是非空字符串`);
  }
  if (!Array.isArray(profile.fields)) {
    throw new Error(`${LABEL} ${file.relPath} 校验失败：fields 必须是数组`);
  }

  let issues: ProfileIssue[];
  try {
    issues = validateProfile(profile);
  } catch (error) {
    throw new Error(`${LABEL} ${file.relPath} 校验失败：${errText(error)}`);
  }
  const errors = issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new Error(`${LABEL} ${file.relPath} 校验失败：${errors.map((issue) => issue.message).join("；")}`);
  }

  return { profile, path: file.relPath, absPath: file.absPath };
}

/**
 * 按登记顺序读取全部 profile 文件，并检查跨文件 id 重复。
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
