/**
 * 配置驱动的 metadata 解析（T-008）。
 *
 * 现在的生成器是给 TECNAI 电镜特化的（文件名永远 `<放大倍数>X-<视野号>-<序号>`）。
 * 这里把「怎么从文件名/路径拆字段」抽成**可配置的 profile**：一条正则 + 具名捕获组 +
 * 每个字段的键名与类型 + 最终写进 frontmatter 的键顺序。
 *
 * ── 一条 profile 能给出五类值 ────────────────────────────────────────────────
 *   ① 解析   regex 的具名组 → fields 里声明的键（组没参与匹配 ⇒ 写 whenMissing，默认空串）
 *   ② 派生   tags（相对 vault 的第一段路径）/ session（所在文件夹名）/ date（session 前 8 位 → YYYY-MM-DD）
 *   ③ 自动   width / height（magick identify）、size（字节）、btime（文件 birthtime）、
 *            thumbnail / tif（`"[[全 vault 路径]]"`）
 *   ④ 常量   constFields
 *   ⑤ 询问   ask（右键时弹窗现场填，内置默认 ["sample"]）
 *
 * ── 硬规则 ──────────────────────────────────────────────────────────────────
 *   - `keyOrder` 是**最终 frontmatter 的键顺序**；不在表里的键一律不写。想加字段就同时
 *     加进 keyOrder，否则它只是被算出来、不会落进文件。
 *   - `fields` 里没列出的具名组 = 丢弃。这是为了能写分支，例如 TECNAI 的新命名：
 *     `(?:(?<lens>\d{1,2})|(?<lensToken>[0-9A-Za-z]+))` —— 短的走 lens，长的那个 token
 *     只用来把正则配平，不落进任何键。
 *   - `pathRegex` + `pathFields` 跑在相对 vault 的路径上，**同名的键覆盖派生值**。
 *   - 正则不命中时按 `onMismatch`：`empty`（字段写空值，报告里标出来，默认）/ `skip`（跳过这张图）。
 */

/** 一个具名捕获组 → frontmatter 的一个键。 */
export type FieldType = "number" | "text";

export interface FieldSpec {
  /** 正则里的具名捕获组名。 */
  group: string;
  /** 写进 frontmatter 的键名，默认与 group 同名。 */
  key?: string;
  /** number → YAML 裸数字；text → 双引号字符串。默认 text。 */
  type?: FieldType;
  /** 该组没参与匹配（可选组未命中）时写什么，默认 `""`（键位保留）。 */
  whenMissing?: string;
}

export type PatternSource = "stem" | "filename" | "relpath";

export interface ParseProfile {
  /** 稳定机器 id（data.json 用它当键，改了等于换一条配置）。 */
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
  fields: FieldSpec[];
  /** 可选：再对相对 vault 的路径跑一条，取 session / date 这类。 */
  pathRegex?: string;
  pathFields?: FieldSpec[];
  constFields?: Record<string, string | number>;
  /** 需要现场填的键，默认 ["sample"]。 */
  ask?: string[];
  /** 最终 frontmatter 的键顺序（不在表里的键不写）。 */
  keyOrder: string[];
  onMismatch?: "empty" | "skip";
}

/** 由插件自己算的键：派生（可被 pathFields 同名覆盖）。 */
export const DERIVED_KEYS = ["tags", "session", "date"] as const;
/** 由插件自己算的键：自动（宽度/高度/字节/落盘时间/两条链接）。 */
export const COMPUTED_KEYS = ["width", "height", "size", "btime", "thumbnail", "tif"] as const;
/** 不写 ask 时默认要问用户的键。 */
export const DEFAULT_ASK = ["sample"];

/**
 * 内置 profile：TECNAI 电镜。必须**逐字节复现**改造前生成器的行为
 * （218 份存量 + 已生成的 46 份 sidecar 都不许变）。
 */
export const TECNAI_TEM_PROFILE: ParseProfile = {
  id: "tecnaitem",
  name: "TECNAI 电镜（<放大倍数>X-<视野号|会话后缀>-<序号>）",
  source: "stem",
  regex: "^(?<magnification>\\d+)X-(?:(?<lens>\\d{1,2})|(?<lensToken>[0-9A-Za-z]+))-(?<index>\\d+)$",
  fields: [
    { group: "magnification", type: "number" },
    { group: "lens", type: "number", whenMissing: '""' },
    { group: "index", type: "number" },
  ],
  constFields: { eagleId: "" },
  ask: ["sample"],
  keyOrder: [
    "tags",
    "sample",
    "session",
    "date",
    "magnification",
    "lens",
    "index",
    "width",
    "height",
    "size",
    "eagleId",
    "btime",
    "thumbnail",
    "tif",
  ],
  onMismatch: "empty",
};

export const DEFAULT_PROFILES: ParseProfile[] = [TECNAI_TEM_PROFILE];

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
  /** 已按 key 归位的值（`""` 表示空字符串值，尚未与派生/自动/常量值合并）。 */
  values: Record<string, string>;
  /** 声明了却没参与匹配的组（键位仍会写 whenMissing）。 */
  missingGroups: string[];
  /** 主正则是否命中。 */
  matched: boolean;
  /** 正则里有、但 fields 没用到的具名组（正常，用来写分支）。 */
  extraGroups: string[];
}

export interface ProfileIssue {
  level: "error" | "warn";
  message: string;
}

/** 按 one-of profile 的规则解析一个名字。 */
export function parseWithProfile(_profile: ParseProfile, _ctx: ParseContext): ParsedFields {
  throw new Error("parseWithProfile 还没实现（见计划块 T-008#B-002）");
}

/** 校验一条 profile 是否可用（供设置页与 CLI 共用）。 */
export function validateProfile(_profile: ParseProfile): ProfileIssue[] {
  throw new Error("validateProfile 还没实现（见计划块 T-008#B-002）");
}

/** 按 match 规则挑第一条命中的 profile；都不命中返回 null（由调用方让用户选）。 */
export function pickProfile(_profiles: ParseProfile[], _ctx: ParseContext): ParseProfile | null {
  throw new Error("pickProfile 还没实现（见计划块 T-008#B-002）");
}
