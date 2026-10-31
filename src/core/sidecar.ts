import * as fs from "fs";
import * as path from "path";
import { Progress } from "./types";
import { git, magickBinary, run, statusPorcelain } from "./git";
import { collectImages, stemOf } from "./stems";
import {
  DEFAULT_PROFILES,
  parseWithProfile,
  pickProfile,
  type FieldType,
  type ParseContext,
  type ParseProfile,
} from "./profiles";
import {
  BUILTIN_METADATA_TEMPLATES,
  checkMetadataTemplate,
  fillPlaceholders,
  type ResolvedTemplate,
} from "./templates";

/**
 * 每份 sidecar 都带的标签：画廊（`.base`）只靠它认 sidecar，和文件夹里别的 `.md` 区分开。
 * 总是 `tags` 列表的第一项，**不受 profile.keyOrder 约束**（keyOrder 里没有 `tags` 也照写）——
 * 否则一条 profile 就能让它生成的 sidecar 悄悄从所有画廊里消失。
 */
export const GALLERY_TAG = "annex-gallery-metadata";

/** 内置默认 metadata 模板（与改造前硬编码的正文逐字节相同）。 */
export const DEFAULT_METADATA_TEMPLATE: ResolvedTemplate = {
  id: BUILTIN_METADATA_TEMPLATES[0].id,
  label: `内置模板 ${BUILTIN_METADATA_TEMPLATES[0].id}`,
  text: BUILTIN_METADATA_TEMPLATES[0].text,
};

/**
 * Legacy default frontmatter key order (TECNAI). Kept as an exported constant
 * because older callers/tests reference it; the authoritative order now lives
 * in each profile's `keyOrder`.
 */
export const SIDECAR_KEYS = [
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
] as const;

export interface BuildSidecarOptions {
  /** Vault root — links are written as full vault-relative paths. */
  vaultRoot: string;
  /** 现场询问得到的键值（profile 的 ask），例如 `{ sample: "…" }`。 */
  ask?: Record<string, string>;
  /** 覆盖 `tags`（默认取相对 vault 的第一段路径）。 */
  tag?: string;
  /** metadata 模板；不给用内置 default。 */
  template?: ResolvedTemplate;
}

export interface SidecarBuild {
  /** 完整文件内容（frontmatter + 正文），与落盘逐字节相同。 */
  text: string;
  detail?: string;
  /** 主正则是否命中该文件名。 */
  matched: boolean;
  /** 实际使用的 profile id。 */
  profileId: string;
}

export interface SingleSidecarOptions {
  /** Vault root — links are written as full vault-relative paths. */
  vaultRoot: string;
  /** Git repo the images live in (dirty-file guard). */
  repoRoot: string;
  /** ask 里 `sample` 的值（便捷写法；等价于 `ask: { sample }`）。 */
  sample?: string;
  /** ask 的其他键值。 */
  ask?: Record<string, string>;
  /** 指定 profile；不给就按 match 选，再不行用第一条。 */
  profile?: ParseProfile;
  /** 候选 profile；不给就用 DEFAULT_PROFILES。 */
  profiles?: ParseProfile[];
  /** 覆盖 `tags`（默认取相对 vault 的第一段路径）。 */
  tag?: string;
  /** metadata 模板；不给用内置 default。坏模板在第一张图之前就抛错，整批不动。 */
  template?: ResolvedTemplate;
  /** Write to disk. Default false = dry run. */
  apply?: boolean;
  /** Overwrite / touch files that git reports as dirty. */
  force?: boolean;
  /**
   * 「覆盖重算」：已存在的 sidecar（干净的、被改过的都算）按当前 profile 重写。
   *
   * 用户 2026-10-17 口径：改动模版（profile）后要能重跑并重算元数据，所以这条必须比 `force`
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
  /** 本次用到的 profile id（都相同给单值，混用给 "auto"）。 */
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
  return Object.prototype.hasOwnProperty.call(obj, key);
}

type RenderKind = "bare" | "quoted" | "list";

interface Resolved {
  value: string;
  kind: RenderKind;
  /** kind === "list" 时的各项。 */
  items?: string[];
}

/** `tags` 的最终列表：GALLERY_TAG 打头，其余值（去空、去重）跟在后面。 */
function tagList(value: string | undefined): string[] {
  const items = [GALLERY_TAG];
  if (value !== undefined && value !== "" && value !== GALLERY_TAG) items.push(value);
  return items;
}

/** Render one frontmatter key the way the pre-change generator did. */
function renderLine(key: string, r: Resolved): string {
  if (r.kind === "list") return `${key}:${(r.items ?? [r.value]).map((item) => `\n  - ${item}`).join("")}`;
  if (r.kind === "quoted") return `${key}: "${r.value}"`;
  return `${key}: ${r.value}`;
}

/**
 * 纯函数：算出一张图将要写入的 sidecar 文本（不落盘、不碰 git）。
 *
 * frontmatter 的键集合与顺序 = `profile.keyOrder` 里能取到值的键（取不到的省略，
 * 记进 detail）。取值优先级：解析/pathFields > constFields > ask > 派生 > 自动。
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
  const constFields = profile.constFields ?? {};
  const ask: Record<string, string> = { ...(opts.ask ?? {}) };

  const derived: Record<string, string> = {
    tags: opts.tag ?? firstSegment(vaultRelative(vaultRoot, imageDir)),
    session,
    date: dateFromSession(session),
  };

  // 自动值按需算（magick identify 只在 keyOrder 真要 width/height 时才跑）。
  let geom: { width: string; height: string } | undefined;
  let stat: fs.Stats | undefined;
  const geometry = (): { width: string; height: string } => (geom ??= identifyGeometry(image));
  const statOf = (): fs.Stats => (stat ??= fs.statSync(image));

  // key → 声明类型（fields 与 pathFields 都可能带类型）。
  const typeByKey = new Map<string, FieldType | undefined>();
  for (const spec of profile.fields) typeByKey.set(spec.key ?? spec.group, spec.type);
  for (const spec of profile.pathFields ?? []) typeByKey.set(spec.key ?? spec.group, spec.type);

  const resolve = (key: string): Resolved | undefined => {
    if (key === "tags") {
      // 任何来源给出的 tags 都排在 GALLERY_TAG 后面；没有来源也照样有 GALLERY_TAG。
      const own = hasOwn(parsed.values, key)
        ? parsed.values[key]
        : hasOwn(constFields, key)
          ? String(constFields[key])
          : hasOwn(ask, key)
            ? ask[key]
            : derived.tags;
      const items = tagList(own);
      return { value: items.join(", "), kind: "list", items };
    }
    if (hasOwn(parsed.values, key)) {
      const type = typeByKey.get(key);
      return { value: parsed.values[key], kind: type === "number" ? "bare" : "quoted" };
    }
    if (hasOwn(constFields, key)) {
      const value = constFields[key];
      return { value: String(value), kind: typeof value === "number" ? "bare" : "quoted" };
    }
    if (hasOwn(ask, key)) return { value: ask[key], kind: "quoted" };
    if (hasOwn(derived, key)) {
      if (key === "date") return { value: derived.date, kind: "bare" };
      return { value: derived[key], kind: "quoted" }; // session
    }
    switch (key) {
      case "width":
        return { value: geometry().width, kind: "bare" };
      case "height":
        return { value: geometry().height, kind: "bare" };
      case "size":
        return { value: String(statOf().size), kind: "bare" };
      case "btime":
        return { value: formatBtime(statOf().birthtime), kind: "bare" };
      case "thumbnail":
        return { value: `[[${relThumb}]]`, kind: "quoted" };
      case "tif":
        return { value: `[[${relOrig}]]`, kind: "quoted" };
      default:
        return undefined;
    }
  };

  const fmLines: string[] = [];
  const notes: string[] = [];
  // keyOrder 里没有 tags ⇒ 仍在最前面写一行，只带 GALLERY_TAG（画廊靠它认 sidecar）。
  if (!profile.keyOrder.includes("tags")) fmLines.push(renderLine("tags", { value: GALLERY_TAG, kind: "list", items: [GALLERY_TAG] }));
  for (const key of profile.keyOrder) {
    const resolved = resolve(key);
    if (resolved === undefined) {
      notes.push(`keyOrder 里的 "${key}" 取不到值，已省略`);
      continue;
    }
    fmLines.push(renderLine(key, resolved));
  }
  if (!parsed.matched) notes.push(`stem "${stem}" 不符合 profile ${profile.id} 的正则`);
  if (parsed.missingGroups.length > 0) notes.push(`组没参与匹配：${parsed.missingGroups.join(",")}`);

  // 正文 = metadata 模板填完占位符：{{frontmatter}} / {{stem}} 由这里给，其余 {{<键>}} 与
  // frontmatter 同一套取值（含不在 keyOrder 里的派生 / 自动值，例如 {{thumbnail}}、{{tif}}）。
  const template = opts.template ?? DEFAULT_METADATA_TEMPLATE;
  const frontmatter = ["---", fmLines.join("\n"), "---"].join("\n");
  const filled = fillPlaceholders(template.text, (name) => {
    if (name === "frontmatter") return frontmatter;
    if (name === "stem") return stem;
    return resolve(name)?.value;
  });
  for (const name of filled.missing) notes.push(`模板里的 {{${name}}} 取不到值，已留空`);
  const text = filled.text;

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
 * profile 驱动：值/顺序由所选 profile 的 fields/constFields/ask/keyOrder +
 * 内置的派生与自动值决定。不给 profile 就按 match 自动选，再不行用第一条。
 * Dry run by default; existing targets are only rewritten when git reports them
 * dirty *and* `force` is set.
 */
export async function generateSidecars(dir: string, opts: SingleSidecarOptions): Promise<SidecarReport> {
  const apply = opts.apply === true;
  const force = opts.force === true;
  const overwrite = opts.overwrite === true;
  const progress: Progress = opts.progress ?? ((): void => {});

  const profiles = opts.profiles !== undefined && opts.profiles.length > 0 ? opts.profiles : DEFAULT_PROFILES;
  const ask: Record<string, string> = { ...(opts.ask ?? {}) };
  if (opts.sample !== undefined && opts.sample !== "" && !hasOwn(ask, "sample")) ask.sample = opts.sample;

  const template = opts.template ?? DEFAULT_METADATA_TEMPLATE;
  checkMetadataTemplate(template);

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
      if (profile === undefined) throw new Error("没有可用 profile");
      usedIds.add(profile.id);
      const built = buildSidecarText(image, profile, {
        vaultRoot: opts.vaultRoot,
        ask,
        template,
        ...(opts.tag === undefined ? {} : { tag: opts.tag }),
      });
      if (!built.matched) mismatch += 1;

      if (!built.matched && (profile.onMismatch ?? "empty") === "skip") {
        entries.push({
          image,
          sidecar,
          action: "skipped-mismatch",
          detail: built.detail ?? `stem 不符合 profile ${profile.id} 的正则（onMismatch=skip，跳过）`,
        });
        progress(`${label} 跳过（正则没命中） ${stem}.md`);
        continue;
      }

      if (fs.existsSync(sidecar)) {
        const dirty = isDirty(opts.repoRoot, sidecar);
        if (overwrite) {
          // 「覆盖重算」：干净的和被改过的都按当前 profile 重写（改动模版后重跑的正是这条路）。
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
