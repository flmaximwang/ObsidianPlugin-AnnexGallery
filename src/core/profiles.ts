/**
 * 元数据预设（preset）：一条正则 + 具名捕获组 + **frontmatter 字典** + 可选正文模板（ticket qij）。
 *
 * ── 一个预设能给出哪些变量 ──────────────────────────────────────────────────
 *   ① 解析   regex 的具名组（组没参与匹配 ⇒ 空值，报告里记为空）
 *   ② 路径   pathRegex 的具名组，跑在相对 vault 的路径上，**同名覆盖①**
 *   ③ 询问   ask（右键时弹窗现场填，内置默认 ["sample"]）
 *   ④ 内置   stem / tags（相对 vault 的第一段路径）/ session（所在文件夹名）/
 *            date（session 前 8 位 → YYYY-MM-DD）/ width / height / size / btime /
 *            thumbnail / tif（`[[全 vault 路径]]`）
 *
 * ── 硬规则 ──────────────────────────────────────────────────────────────────
 *   - `frontmatter` 是**最终写到文件开头的字典**：键顺序 = JSON 里的书写顺序，
 *     值可以是任意 JSON（字符串 / 数字 / 布尔 / null / 列表 / 嵌套对象）。
 *   - 字符串**恰好是一个占位符**（`"{{magnification}}"`）时按 `types` 输出带类型的 YAML 标量；
 *     与其它文字混合（`"{{a}}X-{{b}}"`）时整体当一处文本。空值写成 YAML null 并记进报告。
 *   - `tags` 必须出现在 frontmatter 里，且是**列表**、含字面量 `annex-gallery-metadata` ——
 *     画廊靠它认 sidecar，不满足就整批不写。
 *   - `template` 是可选的正文字 `.md`（vault 相对路径）；`""` / 不写 ⇒ sidecar 只有 frontmatter。
 *     正文模板不能自带 frontmatter。正文里取不到值的占位符留空并记进报告。
 *   - 正则不命中时按 `onMismatch`：`empty`（照常生成，报告里标出来，默认）/ `skip`（跳过这张图）。
 */
import { placeholdersOf } from "./placeholders";

/**
 * 变量写进 YAML 的形态：`number` → 裸数字；`date` → 裸写的日期 / 日期时间；
 * `text` → 双引号字符串。默认 text。
 */
export type ValueType = "number" | "date" | "text";

export type PatternSource = "stem" | "filename" | "relpath";

export interface ParseProfile {
  /** 稳定机器 id（folder 记忆与「按 id 找一条」用它当键）。 */
  id: string;
  /** 人读名字，弹窗里显示。 */
  name: string;
  /** 自动选中用：对相对 vault 的路径 / 文件名各跑一条，都给了就都要命中。 */
  match?: { relpathRegex?: string; filenameRegex?: string };
  /** 主正则打在哪个串上，默认 "stem"（文件名去掉扩展名）。 */
  source?: PatternSource;
  regex: string;
  /** 正则 flags，默认 ""（``i`` 要自己写）。 */
  flags?: string;
  /** 可选：再对相对 vault 的路径跑一条，取 session / date 这类；同名组覆盖主正则的值。 */
  pathRegex?: string;
  /** 变量名 → 输出类型；没写的变量按 text 处理。 */
  types?: Record<string, ValueType>;
  /** 需要现场填的变量，默认 ["sample"]。 */
  ask?: string[];
  /** 正则不命中时：empty（照常生成）/ skip（跳过这张图）。默认 empty。 */
  onMismatch?: "empty" | "skip";
  /** 最终写进 sidecar 开头的 frontmatter：键顺序 = 书写顺序。 */
  frontmatter: Record<string, unknown>;
  /**
   * 正文模板：vault 相对路径的 `.md`；"" 或不写 ⇒ sidecar 只有 frontmatter。
   * 文件必须存在、在 vault 内、不能自带 frontmatter。
   */
  template?: string;
}

/** 每份 sidecar 都带的标签：画廊（`.base`）只靠它认 sidecar，和文件夹里别的 `.md` 区分开。 */
export const GALLERY_TAG = "annex-gallery-metadata";

/**
 * 由插件自己算的变量。`stem` 永远取文件名去扩展名；其余在报告里可能为空（例如 magick 失败）。
 */
export const BUILTIN_VARIABLES = [
  "stem",
  "tags",
  "session",
  "date",
  "width",
  "height",
  "size",
  "btime",
  "thumbnail",
  "tif",
] as const;

/** 不写 ask 时默认要问用户的变量。 */
export const DEFAULT_ASK = ["sample"];

/** 没有 `ask`（或为空）时真正要问的变量。 */
export function effectiveAsk(profile: ParseProfile): string[] {
  return Array.isArray(profile.ask) && profile.ask.length > 0 ? profile.ask : DEFAULT_ASK;
}

export interface ParseContext {
  /** 文件名去掉最后一个扩展名。 */
  stem: string;
  /** 文件名（含扩展名）。 */
  filename: string;
  /** 相对 vault 根的路径，正斜杠。 */
  relpath: string;
  /** 所在文件夹名。 */
  folderName: string;
}

export interface ParsedFields {
  /** 所有具名组的值（`""` 表示组没参与匹配）。pathRegex 的同名组覆盖主正则。 */
  values: Record<string, string>;
  /** 没参与匹配的组名（键位仍在，值为空）。 */
  missingGroups: string[];
  /** 主正则是否命中。 */
  matched: boolean;
  /** 全部声明的组名（主正则 + pathRegex，去重、按出现顺序）。 */
  groups: string[];
}

export interface ProfileIssue {
  level: "error" | "warn";
  message: string;
}

/** 旧格式（2.0 及更早）里出现、新格式不再接受的顶层键。 */
export const LEGACY_PROFILE_KEYS = [
  "keyOrder",
  "fields",
  "constFields",
  "pathFields",
  "whenMissing",
  "metadataTemplate",
] as const;

/** 旧格式预设的人类可读提示（不改写、不迁移，引导用户从预设重建）。 */
export function legacyProfileMessage(keys: readonly string[]): string {
  const which = keys.length > 0 ? `（${keys.join(" / ")}）` : "";
  return (
    `旧格式的元数据预设${which}不再支持，也不会自动迁移：` +
    "请用「从预设创建」生成新格式 .json，再把 regex / ask / frontmatter 手工搬过去。"
  );
}

/** 数据里出现了哪些旧格式顶层键（空数组 ⇒ 不是旧格式）。 */
export function legacyProfileKeys(data: unknown): string[] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  return LEGACY_PROFILE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(data, key));
}

/** 编译一条正则；失败时抛出带 label（通常是预设 id）的错误。 */
function compileRegex(pattern: string, flags: string | undefined, label: string): RegExp {
  try {
    return new RegExp(pattern, flags ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}：正则无法编译（${message}）`);
  }
}

/** 扫出正则源码里的具名捕获组（`(?<name>`；`(?<=` / `(?<!` 不算）。 */
export function namedGroups(pattern: string): string[] {
  const names: string[] = [];
  const scan = /\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(pattern)) !== null) names.push(m[1]);
  return names;
}

/** 一条预设能提供的全部变量名（含内置与实际会问的 ask 键）。 */
export function variablesOf(profile: ParseProfile): Set<string> {
  const names = new Set<string>(BUILTIN_VARIABLES);
  const main = typeof profile.regex === "string" ? profile.regex : "";
  for (const name of namedGroups(main)) names.add(name);
  if (typeof profile.pathRegex === "string") {
    for (const name of namedGroups(profile.pathRegex)) names.add(name);
  }
  for (const key of effectiveAsk(profile)) names.add(key);
  return names;
}

/** 按一条预设的规则解析一个名字（纯函数，不 import obsidian）。 */
export function parseWithProfile(profile: ParseProfile, ctx: ParseContext): ParsedFields {
  const source: PatternSource = profile.source ?? "stem";
  const subject = source === "relpath" ? ctx.relpath : source === "filename" ? ctx.filename : ctx.stem;

  const re = compileRegex(profile.regex, profile.flags, `预设 ${profile.id}`);
  const match = re.exec(subject);
  const groups = (match?.groups ?? {}) as Record<string, string | undefined>;

  const values: Record<string, string> = {};
  const missingGroups: string[] = [];
  const mainNames = namedGroups(profile.regex);
  for (const name of mainNames) {
    const raw = groups[name];
    if (raw === undefined) missingGroups.push(name);
    values[name] = raw ?? "";
  }

  let pathNames: string[] = [];
  if (profile.pathRegex !== undefined) {
    const pathRe = compileRegex(profile.pathRegex, profile.flags, `预设 ${profile.id} pathRegex`);
    const pathMatch = pathRe.exec(ctx.relpath);
    const pathGroups = (pathMatch?.groups ?? {}) as Record<string, string | undefined>;
    pathNames = namedGroups(profile.pathRegex);
    for (const name of pathNames) {
      const raw = pathGroups[name];
      if (raw === undefined) {
        // pathRegex 没命中 / 这一组没参与：不覆盖主正则的值；主正则也没有才算缺失。
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
          values[name] = "";
          missingGroups.push(name);
        }
        continue;
      }
      values[name] = raw;
      const index = missingGroups.indexOf(name);
      if (index !== -1) missingGroups.splice(index, 1);
    }
  }

  return {
    values,
    missingGroups,
    matched: match !== null,
    groups: [...new Set([...mainNames, ...pathNames])],
  };
}

/** 递归收集 JSON 值里出现过的占位符名（frontmatter 字典可能嵌套）。 */
function collectPlaceholders(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const name of placeholdersOf(value)) out.add(name);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectPlaceholders(item, out);
  }
}

export interface ValidateProfileOptions {
  /** 正文模板原文；给了才会检查里面的占位符有没有来源。 */
  bodyText?: string;
}

/**
 * 校验一条预设是否可用（设置页、loader、CLI 共用；纯函数，不读盘）。
 *
 * 结构性问题（id / regex / frontmatter / tags）是 error；typo 类（占位符或 types 指向不存在的变量）
 * 只是 warn —— 允许用户先用再补，不阻塞生成。
 */
export function validateProfile(profile: ParseProfile, opts: ValidateProfileOptions = {}): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const add = (level: ProfileIssue["level"], message: string): void => {
    issues.push({ level, message });
  };

  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    add("error", "预设必须是 JSON 对象");
    return issues;
  }

  if (typeof profile.id !== "string" || profile.id.trim() === "") add("error", "id 不能为空");
  if (typeof profile.name !== "string" || profile.name.trim() === "") {
    add("warn", "name 为空：设置页与弹窗里会显示「（未命名）」");
  }

  let mainGroups: string[] = [];
  const flags = typeof profile.flags === "string" ? profile.flags : "";
  if (profile.flags !== undefined && typeof profile.flags !== "string") add("error", "flags 必须是字符串");
  if (typeof profile.regex !== "string" || profile.regex.trim() === "") {
    add("error", "regex 必须是非空字符串");
  } else {
    try {
      new RegExp(profile.regex, flags);
      mainGroups = namedGroups(profile.regex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add("error", `regex 无法编译：${message}`);
    }
  }

  let pathGroups: string[] = [];
  if (profile.pathRegex !== undefined) {
    if (typeof profile.pathRegex !== "string") {
      add("error", "pathRegex 必须是字符串");
    } else {
      try {
        new RegExp(profile.pathRegex, flags);
        pathGroups = namedGroups(profile.pathRegex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add("error", `pathRegex 无法编译：${message}`);
      }
    }
  }

  const known = new Set<string>([...BUILTIN_VARIABLES, ...mainGroups, ...pathGroups, ...effectiveAsk(profile)]);

  if (profile.types !== undefined) {
    if (profile.types === null || typeof profile.types !== "object" || Array.isArray(profile.types)) {
      add("error", "types 必须是对象（变量名 → \"number\" / \"date\" / \"text\"）");
    } else {
      for (const [key, value] of Object.entries(profile.types as Record<string, unknown>)) {
        if (value !== "number" && value !== "text" && value !== "date") {
          add("error", `types.${key} 只能是 "number" / "date" / "text"`);
        }
        if (!known.has(key)) add("warn", `types 里的 "${key}" 不是变量（名字写错了？）`);
      }
    }
  }

  if (profile.ask !== undefined) {
    if (!Array.isArray(profile.ask) || profile.ask.some((key) => typeof key !== "string" || key.trim() === "")) {
      add("error", "ask 必须是非空字符串数组");
    }
  }

  if (profile.onMismatch !== undefined && profile.onMismatch !== "empty" && profile.onMismatch !== "skip") {
    add("error", "onMismatch 只能是 \"empty\" 或 \"skip\"");
  }

  if (profile.template !== undefined && typeof profile.template !== "string") {
    add("error", "template 必须是字符串（vault 相对 .md 路径，可留空）");
  }

  const frontmatter = profile.frontmatter;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    add("error", "frontmatter 必须是对象（键顺序就是写出顺序；值可以是任意 JSON）");
  } else {
    const fm = frontmatter as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(fm, "tags")) {
      add("error", `frontmatter 必须包含 tags（列表，且含 "${GALLERY_TAG}"）`);
    } else {
      const tags = fm.tags;
      if (!Array.isArray(tags) || !tags.some((tag) => tag === GALLERY_TAG)) {
        add("error", `frontmatter.tags 必须是列表且含字面量 "${GALLERY_TAG}"（画廊靠它识别 sidecar）`);
      } else if (tags.some((tag) => typeof tag !== "string")) {
        add("error", "frontmatter.tags 的每一项都必须是字符串");
      }
    }

    const used = new Set<string>();
    collectPlaceholders(fm, used);
    for (const name of used) {
      if (!known.has(name)) add("warn", `frontmatter 里的 {{${name}}} 没有来源（不是具名捕获组 / ask / 内置变量）`);
    }
  }

  if (opts.bodyText !== undefined) {
    for (const name of placeholdersOf(opts.bodyText)) {
      if (!known.has(name)) add("warn", `正文模板里的 {{${name}}} 没有来源（不是具名捕获组 / ask / 内置变量）`);
    }
  }

  return issues;
}

/** 按 match 规则挑第一条命中的预设；都不命中返回 null（由调用方让用户选）。 */
export function pickProfile(profiles: ParseProfile[], ctx: ParseContext): ParseProfile | null {
  for (const profile of profiles) {
    const match = profile.match;
    if (match === undefined) continue;
    if (match.relpathRegex === undefined && match.filenameRegex === undefined) continue;
    if (match.relpathRegex !== undefined) {
      const re = compileRegex(match.relpathRegex, "", `预设 ${profile.id} match.relpathRegex`);
      if (!re.test(ctx.relpath)) continue;
    }
    if (match.filenameRegex !== undefined) {
      const re = compileRegex(match.filenameRegex, "", `预设 ${profile.id} match.filenameRegex`);
      if (!re.test(ctx.filename)) continue;
    }
    return profile;
  }
  return null;
}
