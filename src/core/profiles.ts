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
 *   - `fields` 里没列出的具名组 = 丢弃。这是为了能写分支：把两条路写进同一条正则、
 *     `(?:(?<lens>\d{1,2})|(?<lensToken>[0-9A-Za-z]+))` —— 短的走 lens，长的那个 token
 *     只用来把正则配平，不落进任何键。
 *   - `pathRegex` + `pathFields` 跑在相对 vault 的路径上，**同名的键覆盖派生值**。
 *   - 正则不命中时按 `onMismatch`：`empty`（字段写空值，报告里标出来，默认）/ `skip`（跳过这张图）。
 */

/**
 * 字段写进 YAML 的形态：`number` → 裸数字；`text` → 双引号字符串。
 * `string` 是 `text` 的**等价历史拼写**（用户既有 `data.json` 里在用，例如 TECNAI 的 marker 字段），
 * 渲染时和 `text` 走同一条路（sidecar 里只有 `number` 是特判）。
 */
export type FieldType = "number" | "text" | "string";

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
 * 内置 profile：TECNAI 电镜 —— **以用户 2026-10-17 给的原文 JSON 为准**
 * （原话「这才是 TECNAI 的正确预设」；随后把 marker 从 `.*` 收紧成 `.+`，
 * 并要求中间段带下划线/小数点的名字能命中，例：`12345X-5_1.4-0001`）。
 *
 * 注意 `constFields` 里有 `eagleId`、而 `keyOrder` 里没有 —— 按上面的硬规则「不在 keyOrder 里的键一律不写」，
 * 它当前**不会**落进 frontmatter（保留声明只为沿用用户配置原文）。
 */
export const TECNAI_TEM_PROFILE: ParseProfile = {
  id: "tecnaitem",
  name: "TECNAI 电镜（<放大倍数>X-<标记>-<序号>）",
  source: "stem",
  regex: "^(?<magnification>\\d+)X-(?<marker>.+)-(?<index>\\d+)$",
  fields: [
    { group: "magnification", type: "number" },
    { group: "marker", type: "string" },
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
    "index",
    "width",
    "height",
    "size",
    "btime",
    "thumbnail",
    "tif",
  ],
  onMismatch: "empty",
};

/**
 * 「新模版」按钮插入的那条 profile —— 只演示 schema 的基本写法：
 * 具名捕获组 → fields（含 type: number）、keyOrder 决定最终写哪些键、ask 现场填 sample、
 * onMismatch 决定正则不命中时怎么处理。照它改成自己的命名规则即可。
 *
 * 注意 `sample` 走 ask（现场填），不放进正则的具名组：解析出来的值优先级高于 ask，
 * 两处都给会让用户填的样品名被文件名里的那一份盖掉。
 */
export const TEMPLATE_PROFILE: ParseProfile = {
  id: "template",
  name: "新模板（示例：<放大倍数>x_<序号>）",
  source: "stem",
  regex: "^(?<magnification>\\d+)x_(?<index>\\d+)$",
  fields: [
    { group: "magnification", type: "number" },
    { group: "index", type: "number" },
  ],
  ask: ["sample"],
  keyOrder: [
    "tags",
    "sample",
    "session",
    "date",
    "magnification",
    "index",
    "width",
    "height",
    "size",
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

/** 编译一条正则；失败时抛出带 label（通常是 profile id）的错误。 */
function compileRegex(pattern: string, flags: string | undefined, label: string): RegExp {
  try {
    return new RegExp(pattern, flags ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}：正则无法编译（${message}）`);
  }
}

/** 扫出正则源码里的具名捕获组（`(?<name>`；`(?<=` / `(?<!` 不算）。 */
function namedGroups(pattern: string): string[] {
  const names: string[] = [];
  const scan = /\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(pattern)) !== null) names.push(m[1]);
  return names;
}

/** 把一个具名组的值按 FieldSpec 归位（missing ⇒ whenMissing；number ⇒ 裸数字字符串）。 */
function placeField(
  spec: FieldSpec,
  groups: Record<string, string | undefined>,
  values: Record<string, string>,
  missingGroups: string[],
): void {
  const key = spec.key ?? spec.group;
  const raw = groups[spec.group];
  if (raw === undefined) {
    values[key] = spec.whenMissing ?? "";
    missingGroups.push(spec.group);
    return;
  }
  values[key] = spec.type === "number" ? String(Number.parseInt(raw, 10)) : raw;
}

/** 按一条 profile 的规则解析一个名字（纯函数，不 import obsidian）。 */
export function parseWithProfile(profile: ParseProfile, ctx: ParseContext): ParsedFields {
  const source: PatternSource = profile.source ?? "stem";
  const subject = source === "relpath" ? ctx.relpath : source === "filename" ? ctx.filename : ctx.stem;

  const re = compileRegex(profile.regex, profile.flags, `profile ${profile.id}`);
  const match = re.exec(subject);
  const groups = (match?.groups ?? {}) as Record<string, string | undefined>;

  const values: Record<string, string> = {};
  const missingGroups: string[] = [];
  for (const spec of profile.fields) placeField(spec, groups, values, missingGroups);

  const declared = new Set(profile.fields.map((spec) => spec.group));
  const extraGroups = namedGroups(profile.regex).filter((name) => !declared.has(name));

  // pathFields 跑在相对 vault 的路径上，同名键覆盖上面的值。
  if (profile.pathRegex !== undefined) {
    const pathRe = compileRegex(profile.pathRegex, profile.flags, `profile ${profile.id} pathRegex`);
    const pathMatch = pathRe.exec(ctx.relpath);
    if (pathMatch !== null) {
      const pathGroups = (pathMatch.groups ?? {}) as Record<string, string | undefined>;
      for (const spec of profile.pathFields ?? []) placeField(spec, pathGroups, values, missingGroups);
    }
  }

  return { values, missingGroups, matched: match !== null, extraGroups };
}

/** 校验一条 profile 是否可用（供设置页与 CLI 共用）。 */
export function validateProfile(profile: ParseProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const add = (level: ProfileIssue["level"], message: string): void => {
    issues.push({ level, message });
  };

  if (typeof profile.id !== "string" || profile.id.trim() === "") add("error", "profile.id 不能为空");

  // 主正则能否编译；能编译才谈得上组名检查。
  let mainOk = false;
  try {
    new RegExp(profile.regex, profile.flags ?? "");
    mainOk = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    add("error", `regex 无法编译：${message}`);
  }
  if (mainOk) {
    const names = new Set(namedGroups(profile.regex));
    for (const spec of profile.fields) {
      if (!names.has(spec.group)) add("error", `fields 里的组 "${spec.group}" 在 regex 的具名组里不存在`);
    }
  }

  if (profile.pathRegex !== undefined) {
    let pathOk = false;
    try {
      new RegExp(profile.pathRegex, profile.flags ?? "");
      pathOk = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add("error", `pathRegex 无法编译：${message}`);
    }
    if (pathOk) {
      const names = new Set(namedGroups(profile.pathRegex));
      for (const spec of profile.pathFields ?? []) {
        if (!names.has(spec.group)) add("error", `pathFields 里的组 "${spec.group}" 在 pathRegex 的具名组里不存在`);
      }
    }
  }

  const order = Array.isArray(profile.keyOrder) ? profile.keyOrder : [];
  if (order.length === 0) {
    add("error", "keyOrder 不能为空");
  } else {
    const seen = new Set<string>();
    for (const key of order) {
      if (seen.has(key)) add("error", `keyOrder 里键 "${key}" 重复`);
      seen.add(key);
    }
  }

  const fieldKeys = new Set<string>();
  for (const spec of profile.fields) {
    const key = spec.key ?? spec.group;
    if (fieldKeys.has(key)) add("error", `fields 里的键 "${key}" 重复`);
    fieldKeys.add(key);
  }

  const known = new Set(order);
  for (const key of profile.ask ?? DEFAULT_ASK) {
    if (!known.has(key)) add("error", `ask 的键 "${key}" 不在 keyOrder 里`);
  }

  return issues;
}

/** 按 match 规则挑第一条命中的 profile；都不命中返回 null（由调用方让用户选）。 */
export function pickProfile(profiles: ParseProfile[], ctx: ParseContext): ParseProfile | null {
  for (const profile of profiles) {
    const match = profile.match;
    if (match === undefined) continue;
    if (match.relpathRegex === undefined && match.filenameRegex === undefined) continue;
    if (match.relpathRegex !== undefined) {
      const re = compileRegex(match.relpathRegex, "", `profile ${profile.id} match.relpathRegex`);
      if (!re.test(ctx.relpath)) continue;
    }
    if (match.filenameRegex !== undefined) {
      const re = compileRegex(match.filenameRegex, "", `profile ${profile.id} match.filenameRegex`);
      if (!re.test(ctx.filename)) continue;
    }
    return profile;
  }
  return null;
}
