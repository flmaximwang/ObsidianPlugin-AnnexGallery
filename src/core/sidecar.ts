import * as fs from "fs";
import * as path from "path";
import { Progress } from "./types";
import { git, magickBinary, run, statusPorcelain } from "./git";
import { collectImages, stemOf } from "./stems";
import { readVaultTextFile } from "./external-files";
import { startsWithFrontmatter } from "./profile-files";
import {
  GALLERY_TAG,
  parseWithProfile,
  pickProfile,
  type ParseContext,
  type ParseProfile,
  type ValueType,
} from "./profiles";
import { exactPlaceholder, fillPlaceholders } from "./placeholders";

/**
 * 每份 sidecar 都带的标签：画廊（`.base`）只靠它认 sidecar，和文件夹里别的 `.md` 区分开。
 *
 * 新格式里它必须由预设的 `frontmatter.tags` **显式**写上（`validateProfile` 会检查），
 * 插件不再隐式注入 —— 否则用户删了一个键，sidecar 会悄悄从所有画廊里消失。
 */
export { GALLERY_TAG };

export interface BuildSidecarOptions {
  /** Vault root — links are written as full vault-relative paths. */
  vaultRoot: string;
  /** 现场询问得到的变量值（预设的 ask），例如 `{ sample: "…" }`。 */
  ask?: Record<string, string>;
  /** 覆盖 `{{tags}}`（默认取相对 vault 的第一段路径）。 */
  tag?: string;
  /**
   * 正文模板原文（预设 `template` 指向的 vault `.md`，由调用方读入）。
   * 不给 / 空 ⇒ sidecar 只有 frontmatter。
   */
  body?: string;
}

export interface SidecarBuild {
  /** 完整文件内容（frontmatter + 正文），与落盘逐字节相同。 */
  text: string;
  detail?: string;
  /** 主正则是否命中该文件名。 */
  matched: boolean;
  /** 实际使用的预设 id。 */
  profileId: string;
}

export interface SingleSidecarOptions {
  /** Vault root — links are written as full vault-relative paths. */
  vaultRoot: string;
  /** Git repo the images live in (dirty-file guard). */
  repoRoot: string;
  /** ask 里 `sample` 的值（便捷写法；等价于 `ask: { sample }`）。 */
  sample?: string;
  /** ask 的其他变量值。 */
  ask?: Record<string, string>;
  /** 指定预设；不给就按 match 选，再不行用第一条。 */
  profile?: ParseProfile;
  /** 候选预设；不给就是空（必须显式给，没有内置兜底）。 */
  profiles?: ParseProfile[];
  /** 覆盖 `{{tags}}`（默认取相对 vault 的第一段路径）。 */
  tag?: string;
  /** Write to disk. Default false = dry run. */
  apply?: boolean;
  /** Overwrite / touch files that git reports as dirty. */
  force?: boolean;
  /**
   * 「覆盖重算」：已存在的 sidecar（干净的、被改过的都算）按当前预设重写。
   *
   * 用户 2026-10-17 口径：改动模版（预设）后要能重跑并重算元数据，所以这条必须比 `force`
   * 更进一步 —— `force` 只覆盖「被 git 报脏」的那些，干净的一律 `skipped-existing`。
   */
  overwrite?: boolean;
  progress?: Progress;
}

export interface SidecarEntry {
  image: string;
  sidecar: string;
  action: "created" | "overwritten" | "planned" | "skipped-dirty" | "skipped-existing" | "skipped-mismatch" | "failed";
  detail?: string;
}

/** 「生成元数据」重跑前的只读预览（不写盘）。 */
export interface SidecarPlan {
  /** 这个目录里的图片数。 */
  images: number;
  /** 已经有 sidecar 的份数。 */
  existing: number;
  /** 其中被 git 报脏的份数（未跟踪的 sidecar 也算脏）。 */
  dirty: number;
}

/**
 * 数一下重跑会碰到什么：图片数 / 已存在的 sidecar 数 / 其中被改过的份数。
 *
 * 只读：`git status` 一次问完所有已存在的 sidecar（不逐个跑 git）。
 */
export function planSidecarTargets(dir: string, repoRoot?: string): SidecarPlan {
  const images = collectImages(dir);
  const targets: string[] = [];
  for (const image of images) {
    const sidecar = path.join(path.dirname(image), `${stemOf(image)}.md`);
    if (fs.existsSync(sidecar)) targets.push(sidecar);
  }
  let dirty = 0;
  if (repoRoot !== undefined && targets.length > 0) {
    const status = statusPorcelain(repoRoot, targets);
    dirty = status.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  }
  return { images: images.length, existing: targets.length, dirty };
}

export interface SidecarReport {
  dir: string;
  dryRun: boolean;
  entries: SidecarEntry[];
  /** `stem` → number of images sharing it (only entries with collisions). */
  duplicateStems: Record<string, number>;
  /** 本次用到的预设 id（都相同给单值，混用给 "auto"）。 */
  profileId: string;
  /** 主正则没命中的份数。 */
  mismatch: number;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Vault-relative, forward-slash path used inside `[[…]]` links. */
function vaultRelative(vaultRoot: string, abs: string): string {
  return toPosix(path.relative(vaultRoot, abs));
}

function firstSegment(p: string): string {
  const norm = toPosix(p);
  const slash = norm.indexOf("/");
  return slash === -1 ? norm : norm.slice(0, slash);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `btime` is the file's *birth* time (落盘时间), not the exposure time. */
function formatBtime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** `YYYYMMDD…` folder name → `YYYY-MM-DD`; anything else → empty string. */
function dateFromSession(session: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(session);
  return m === null ? "" : `${m[1]}-${m[2]}-${m[3]}`;
}

/** `magick identify -format "%w %h"` → pixel geometry (empty strings on failure). */
function identifyGeometry(image: string): { width: string; height: string } {
  const result = run(magickBinary(), ["identify", "-format", "%w %h", image]);
  if (result.code !== 0) return { width: "", height: "" };
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 2) return { width: "", height: "" };
  return { width: parts[0], height: parts[1] };
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) === true;
}

// ── frontmatter 渲染：把预设里的 JSON 字典写成 YAML ─────────────────────────

interface RenderContext {
  /** 变量名 → 值；取不到返回 undefined。 */
  resolve(name: string): string | undefined;
  /** 变量名 → 输出类型；没声明按 text。 */
  typeOf(name: string): ValueType;
}

interface RenderState {
  /** 写成 YAML null 的键路径（顶层键或 a.b）。 */
  emptyPaths: string[];
  /** 列表里有空项被整项丢弃的键路径。 */
  droppedListPaths: string[];
  /** 没有任何来源的占位符名。 */
  missingVars: string[];
}

/** 文本 → YAML 双引号标量（JSON 字符串本身是合法的 YAML 双引号标量）。 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * 按类型输出标量：number / date 且格式对 ⇒ 裸写；其余一律双引号。
 * number 走 `Number()` 归一（与旧版 parseInt 一致：`0001` ⇒ `1`），避免写出 `"0001"` 这种字符串。
 */
function yamlScalar(value: string, type: ValueType): string {
  if (type === "number" && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return String(num);
  }
  if (type === "date" && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(value)) return value;
  return quoted(value);
}

/** 一个标量值；空值 / 无来源的占位符 ⇒ null（调用方写 YAML null 并记进报告）。 */
function renderScalar(
  value: unknown,
  pathKey: string,
  state: RenderState,
  ctx: RenderContext,
  inList = false,
): string | null {
  const empty = (): null => {
    // 列表里的空项整项丢弃，按「列表里有空项」记一次；键上的空值按 null 写出并记键路径。
    if (!inList && !state.emptyPaths.includes(pathKey)) state.emptyPaths.push(pathKey);
    return null;
  };

  if (value === null || value === undefined) return empty();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return empty();
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") {
    // JSON 里不会出现（对象 / 列表走别的分支）；防御一下，别写出非法 YAML。
    return empty();
  }

  const exact = exactPlaceholder(value);
  if (exact !== null) {
    const resolved = ctx.resolve(exact);
    if (resolved === undefined) {
      if (!state.missingVars.includes(exact)) state.missingVars.push(exact);
      return empty();
    }
    if (resolved === "") return empty();
    return yamlScalar(resolved, ctx.typeOf(exact));
  }

  const filled = fillPlaceholders(value, (name) => ctx.resolve(name));
  for (const name of filled.missing) {
    if (!state.missingVars.includes(name)) state.missingVars.push(name);
  }
  if (filled.text === "") return empty();
  return quoted(filled.text);
}

/** 写一个键（值可能是标量 / 列表 / 嵌套对象）。 */
function emitEntry(
  key: string,
  value: unknown,
  indent: string,
  out: string[],
  pathKey: string,
  state: RenderState,
  ctx: RenderContext,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${indent}${key}: []`);
      return;
    }
    const itemLines: string[] = [];
    emitList(value, `${indent}  `, pathKey, itemLines, state, ctx);
    if (itemLines.length === 0) {
      out.push(`${indent}${key}: []`);
      return;
    }
    out.push(`${indent}${key}:`);
    out.push(...itemLines);
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push(`${indent}${key}: {}`);
      return;
    }
    out.push(`${indent}${key}:`);
    emitMap(entries, `${indent}  `, out, pathKey, state, ctx);
    return;
  }
  const scalar = renderScalar(value, pathKey, state, ctx);
  out.push(scalar === null ? `${indent}${key}:` : `${indent}${key}: ${scalar}`);
}

function emitMap(
  entries: Array<[string, unknown]>,
  indent: string,
  out: string[],
  parentPath: string,
  state: RenderState,
  ctx: RenderContext,
): void {
  for (const [key, value] of entries) {
    const pathKey = parentPath === "" ? key : `${parentPath}.${key}`;
    emitEntry(key, value, indent, out, pathKey, state, ctx);
  }
}

/** 列表项：标量 / 嵌套对象 / 嵌套列表；空值（null）整项丢弃。 */
function emitList(
  items: unknown[],
  indent: string,
  pathKey: string,
  out: string[],
  state: RenderState,
  ctx: RenderContext,
): void {
  let dropped = false;
  for (const item of items) {
    if (Array.isArray(item)) {
      const nested: string[] = [];
      emitList(item, `${indent}  `, pathKey, nested, state, ctx);
      if (nested.length === 0) {
        dropped = true;
        continue;
      }
      out.push(`${indent}-`);
      out.push(...nested);
      continue;
    }
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) {
        out.push(`${indent}- {}`);
        continue;
      }
      const nested: string[] = [];
      emitMap(entries, `${indent}  `, nested, pathKey, state, ctx);
      if (nested.length === 0) {
        dropped = true;
        continue;
      }
      // 第一行提到 `- ` 后面，其余行保持次级缩进。
      nested[0] = `${indent}- ${nested[0].slice((indent + "  ").length)}`;
      out.push(...nested);
      continue;
    }
    const scalar = renderScalar(item, pathKey, state, ctx, true);
    if (scalar === null) dropped = true;
    else out.push(`${indent}- ${scalar}`);
  }
  if (dropped && !state.droppedListPaths.includes(pathKey)) state.droppedListPaths.push(pathKey);
}

/** 渲染整份 frontmatter 字典（键顺序 = JSON 书写顺序）。 */
function renderFrontmatter(
  frontmatter: Record<string, unknown>,
  ctx: RenderContext,
  state: RenderState,
): string[] {
  const lines: string[] = [];
  emitMap(Object.entries(frontmatter), "", lines, "", state, ctx);
  return lines;
}

/**
 * 纯函数：算出一张图将要写入的 sidecar 文本（不落盘、不碰 git）。
 *
 * frontmatter 完全来自 `profile.frontmatter` 字典；正文来自 `opts.body`（预设的 template）。
 * 字符串恰好是一个占位符 ⇒ 按 `types` 输出带类型标量；与文字混合 ⇒ 整体当一个字符串。
 * 空值 / 取不到值 ⇒ 保留键、写 YAML null，并记进 detail；列表里的空项整项丢弃。
 */
export function buildSidecarText(image: string, profile: ParseProfile, opts: BuildSidecarOptions): SidecarBuild {
  const vaultRoot = opts.vaultRoot;
  const stem = stemOf(image);
  const imageDir = path.dirname(image);
  const session = path.basename(imageDir);
  const relOrig = vaultRelative(vaultRoot, image);
  const relThumb = vaultRelative(vaultRoot, path.join(imageDir, `${stem}.thumbnail.png`));

  const ctx: ParseContext = {
    stem,
    filename: path.basename(image),
    relpath: relOrig,
    folderName: session,
  };

  const parsed = parseWithProfile(profile, ctx);
  const ask: Record<string, string> = { ...(opts.ask ?? {}) };

  const derived: Record<string, string> = {
    tags: opts.tag ?? firstSegment(vaultRelative(vaultRoot, imageDir)),
    session,
    date: dateFromSession(session),
  };

  // 自动值按需算（magick identify 只在真的引用 width/height 时才跑）。
  let geom: { width: string; height: string } | undefined;
  let stat: fs.Stats | undefined;
  const geometry = (): { width: string; height: string } => (geom ??= identifyGeometry(image));
  const statOf = (): fs.Stats => (stat ??= fs.statSync(image));

  const resolve = (name: string): string | undefined => {
    if (name === "stem") return stem;
    if (hasOwn(parsed.values, name)) return parsed.values[name];
    if (hasOwn(ask, name)) return ask[name];
    if (hasOwn(derived, name)) return derived[name];
    switch (name) {
      case "width":
        return geometry().width;
      case "height":
        return geometry().height;
      case "size":
        return String(statOf().size);
      case "btime":
        return formatBtime(statOf().birthtime);
      case "thumbnail":
        return `[[${relThumb}]]`;
      case "tif":
        return `[[${relOrig}]]`;
      default:
        return undefined;
    }
  };

  const renderCtx: RenderContext = {
    resolve,
    typeOf: (name) => profile.types?.[name] ?? "text",
  };
  const state: RenderState = { emptyPaths: [], droppedListPaths: [], missingVars: [] };

  const frontmatter = profile.frontmatter;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`预设 ${profile.id} 的 frontmatter 必须是对象`);
  }
  const fmLines = renderFrontmatter(frontmatter as Record<string, unknown>, renderCtx, state);

  const notes: string[] = [];
  if (!parsed.matched) notes.push(`stem "${stem}" 不符合预设 ${profile.id} 的正则`);
  if (parsed.missingGroups.length > 0) notes.push(`正则组没参与匹配：${parsed.missingGroups.join(",")}`);
  if (state.emptyPaths.length > 0) notes.push(`空值（写成 YAML null）：${state.emptyPaths.join("、")}`);
  if (state.droppedListPaths.length > 0) notes.push(`列表里的空项已丢弃：${state.droppedListPaths.join("、")}`);
  if (state.missingVars.length > 0) {
    notes.push(`没有来源的占位符：${state.missingVars.map((name) => `{{${name}}}`).join("、")}`);
  }

  let text = ["---", ...fmLines, "---"].join("\n") + "\n";

  // 正文 = 预设 template 指向的 .md（调用方读入）；占位符与 frontmatter 同一套取值。
  const body = opts.body ?? "";
  if (body.trim() !== "") {
    const filled = fillPlaceholders(body, (name) => resolve(name));
    if (filled.missing.length > 0) {
      notes.push(`模板里的 ${filled.missing.map((name) => `{{${name}}}`).join("、")} 取不到值，已留空`);
    }
    text += filled.text;
    if (!text.endsWith("\n")) text += "\n";
  }

  const detail = notes.length > 0 ? notes.join("；") : undefined;
  return detail === undefined
    ? { text, matched: parsed.matched, profileId: profile.id }
    : { text, detail, matched: parsed.matched, profileId: profile.id };
}

/** frontmatter 的 context（右键文件夹时用来 pickProfile）。 */
function contextFor(image: string, vaultRoot: string): ParseContext {
  const stem = stemOf(image);
  return {
    stem,
    filename: path.basename(image),
    relpath: vaultRelative(vaultRoot, image),
    folderName: path.basename(path.dirname(image)),
  };
}

/** Non-empty `git status --porcelain` for `target` ⇒ the file is dirty. */
function isDirty(repoRoot: string, target: string): boolean {
  // 直接把**绝对路径**当 pathspec 交给 git —— 实测 git 对 `/var/…` 与 `/private/var/…` 两种写法都认。
  // 别用 `path.relative(repoRoot, target)`：macOS 上仓库根若是 `/private/var/…` 而目录来自
  // `/var/…`，它会算出 `../../../../var/…`，git 直接 `fatal: … is outside repository`，
  // stdout 为空 ⇒ 这个「脏文件保护」会**静默失效**（同一类坑在 drop 里也踩过）。
  const result = git(["status", "--porcelain", "--", target], repoRoot);
  return result.stdout.trim().length > 0;
}

function mergeDetail(base: string | undefined, extra: string | undefined): string | undefined {
  if (base === undefined || base === "") return extra;
  if (extra === undefined || extra === "") return base;
  return `${base}；${extra}`;
}

/**
 * 「使用 Annex Gallery 管理」— the *core* of command #3 (no Obsidian imports).
 *
 * 预设驱动：frontmatter 字典 / 正文模板 / ask + 内置变量决定每份 sidecar。
 * 不给预设就按 match 自动选，再不行用第一条。
 * Dry run by default; existing targets are only rewritten when git reports them
 * dirty *and* `force` is set.
 */
export async function generateSidecars(dir: string, opts: SingleSidecarOptions): Promise<SidecarReport> {
  const apply = opts.apply === true;
  const force = opts.force === true;
  const overwrite = opts.overwrite === true;
  const progress: Progress = opts.progress ?? ((): void => {});

  // 没有候选预设 ⇒ 直接报错，没有内置兜底：
  // 预设必须由调用方显式给（插件给外部文件，CLI 给显式预设）。
  const profiles = opts.profiles ?? [];
  if (profiles.length === 0) throw new Error("没有可用的元数据预设：请显式传入 profiles");
  const ask: Record<string, string> = { ...(opts.ask ?? {}) };
  if (opts.sample !== undefined && opts.sample !== "" && !hasOwn(ask, "sample")) ask.sample = opts.sample;

  // 正文模板按路径缓存：同一个 template 只读一次盘。
  const bodyCache = new Map<string, string | undefined>();
  const bodyFor = (profile: ParseProfile): string | undefined => {
    const rel = typeof profile.template === "string" ? profile.template.trim() : "";
    if (rel === "") return undefined;
    if (bodyCache.has(rel)) return bodyCache.get(rel);
    const file = readVaultTextFile(opts.vaultRoot, rel, "metadata");
    if (startsWithFrontmatter(file.text)) {
      throw new Error(`正文模板 ${file.relPath} 不能自带 frontmatter（frontmatter 由预设的 frontmatter 字典生成）`);
    }
    bodyCache.set(rel, file.text);
    return file.text;
  };

  // 写盘之前先把所有候选预设的正文模板都读一遍：坏模板一份都不写。
  const candidates = opts.profile === undefined ? profiles : [...profiles, opts.profile];
  for (const profile of candidates) bodyFor(profile);

  const images = collectImages(dir);
  progress(`开始生成 sidecar：${dir}（${images.length} 张，${apply ? "写入" : "dry-run"}）`);

  const entries: SidecarEntry[] = [];
  const stemCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  let mismatch = 0;

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const stem = stemOf(image);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
    const sidecar = path.join(path.dirname(image), `${stem}.md`);
    const label = `[${i + 1}/${images.length}]`;
    try {
      const profile = opts.profile ?? pickProfile(profiles, contextFor(image, opts.vaultRoot)) ?? profiles[0];
      if (profile === undefined) throw new Error("没有可用预设");
      usedIds.add(profile.id);
      const body = bodyFor(profile);
      const built = buildSidecarText(image, profile, {
        vaultRoot: opts.vaultRoot,
        ask,
        ...(body === undefined ? {} : { body }),
        ...(opts.tag === undefined ? {} : { tag: opts.tag }),
      });
      if (!built.matched) mismatch += 1;

      if (!built.matched && (profile.onMismatch ?? "empty") === "skip") {
        entries.push({
          image,
          sidecar,
          action: "skipped-mismatch",
          detail: built.detail ?? `stem 不符合预设 ${profile.id} 的正则（onMismatch=skip，跳过）`,
        });
        progress(`${label} 跳过（正则没命中） ${stem}.md`);
        continue;
      }

      if (fs.existsSync(sidecar)) {
        const dirty = isDirty(opts.repoRoot, sidecar);
        if (overwrite) {
          // 「覆盖重算」：干净的和被改过的都按当前预设重写（改动模版后重跑的正是这条路）。
          if (!apply) {
            entries.push({
              image,
              sidecar,
              action: "planned",
              detail: mergeDetail("overwrite：将覆盖已存在的 .md", built.detail),
            });
            progress(`${label} 计划覆盖 ${stem}.md`);
            continue;
          }
          fs.writeFileSync(sidecar, built.text, "utf8");
          entries.push({
            image,
            sidecar,
            action: "overwritten",
            detail: mergeDetail(dirty ? "覆盖已存在的 .md（git 报脏）" : "覆盖已存在的 .md", built.detail),
          });
          progress(`${label} 覆盖 ${stem}.md`);
          continue;
        }
        if (dirty && !force) {
          entries.push({
            image,
            sidecar,
            action: "skipped-dirty",
            detail: mergeDetail("目标 .md 已被修改（git 报脏），未覆盖；需 --force", built.detail),
          });
          progress(`${label} 跳过（脏，未覆盖） ${stem}.md`);
          continue;
        }
        if (dirty && force) {
          fs.writeFileSync(sidecar, built.text, "utf8");
          entries.push({
            image,
            sidecar,
            action: "created",
            detail: mergeDetail("--force 覆盖脏文件", built.detail),
          });
          progress(`${label} 覆盖（--force） ${stem}.md`);
          continue;
        }
        entries.push({
          image,
          sidecar,
          action: "skipped-existing",
          detail: mergeDetail("目标 .md 已存在且干净，不重写", built.detail),
        });
        progress(`${label} 跳过（已存在） ${stem}.md`);
        continue;
      }
      if (apply) {
        fs.writeFileSync(sidecar, built.text, "utf8");
        entries.push({ image, sidecar, action: "created", ...(built.detail === undefined ? {} : { detail: built.detail }) });
        progress(`${label} 写入 ${stem}.md`);
      } else {
        entries.push({ image, sidecar, action: "planned", ...(built.detail === undefined ? {} : { detail: built.detail }) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ image, sidecar, action: "failed", detail: message });
      progress(`${label} 失败 ${stem}.md：${message}`);
    }
  }

  const duplicateStems: Record<string, number> = {};
  for (const [stem, count] of stemCounts) {
    if (count > 1) duplicateStems[stem] = count;
  }

  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  progress(`完成：${JSON.stringify(counts)}${Object.keys(duplicateStems).length > 0 ? ` 重名 stem=${JSON.stringify(duplicateStems)}` : ""}`);

  const ids = [...usedIds];
  const profileId = ids.length === 1 ? ids[0] : ids.length === 0 ? profiles[0]?.id ?? "?" : "auto";
  return { dir, dryRun: !apply, entries, duplicateStems, profileId, mismatch };
}
