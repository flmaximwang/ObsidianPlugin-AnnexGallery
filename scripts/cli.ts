#!/usr/bin/env node
/**
 * Annex Gallery CLI — the same core modules the plugin uses, without Obsidian.
 *
 * It exists so every plan criterion can be executed and re-executed from a
 * terminal:
 *
 *   node tools/annex-gallery.mjs init    <dir> [--dry-run] [--json]
 *   node tools/annex-gallery.mjs thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
 *   node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --preset <json> [--preset <json> ...]
 *                                        [--profile <id>] [--sample <name>] [--ask key=value]
 *                                        [--repo <root>] [--apply] [--force] [--overwrite] [--plan] [--verify] [--json]
 *   node tools/annex-gallery.mjs gallery <dir> --vault <root> --preset <json> [--preset <json> ...]
 *                                        [--template <file>] [--edge 256] [--apply] [--overwrite] [--fix-tags] [--json]
 *   node tools/annex-gallery.mjs profiles --list | --check | --parse <name> --preset <json> [--preset <json> ...]
 *                                        [--vault <root>] [--path <rel>] [--profile <id>] [--json]
 *   node tools/annex-gallery.mjs stems   <dir> [--json]
 *   node tools/annex-gallery.mjs drop    <dir> [--dry-run] [--force] [--json]   # 丢本地 annex 内容
 *   node tools/annex-gallery.mjs annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
 *   node tools/annex-gallery.mjs defaults            # print the bundled .gitattributes
 *
 * 元数据预设（metadata preset）：**一份 .json 一条预设**（顶层就是一条 `ParseProfile`），
 * 用 `--preset` 指定（可重复）。CLI **没有任何内置预设**：不给 `--preset` 直接报错。
 * 预设文件本身的路径按 **当前工作目录** 解析；预设里的 `template`（正文 `.md`）
 * 按 **--vault** 解析（core 用 `readVaultTextFile(..., "metadata")` 读）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initGallery } from "../src/core/init";
import { ANNEX_OP_TITLE, AnnexOp, dropLargefiles, runAnnexOp } from "../src/core/annex";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "../src/core/rules";
import { buildSidecarText, generateSidecars, planSidecarTargets } from "../src/core/sidecar";
import { addGalleryTag, buildGalleryBase, galleryFilePath, orderProperties, planGallery } from "../src/core/gallery";
import { presetTemplates, readTemplateFile, type ResolvedTemplate } from "../src/core/templates";
import { collectImages, duplicateStems, stemOf } from "../src/core/stems";
import { generateThumbnails } from "../src/core/thumbnails";
import { progressPrefix } from "../src/core/types";
import { readVaultTextFile } from "../src/core/external-files";
import { parseProfileDocument, startsWithFrontmatter } from "../src/core/profile-files";
import {
  parseWithProfile,
  pickProfile,
  validateProfile,
  type ParseContext,
  type ParseProfile,
  type ProfileIssue,
} from "../src/core/profiles";

type FlagValue = string | boolean;

interface Args {
  positional: string[];
  /** 同一个 flag 可以给多次（`--preset a --preset b`）：按出现顺序存。 */
  flags: Map<string, FlagValue[]>;
}

/** 这些 flag 不吃值（后面跟的东西是位置参数，不是它的值）。 */
const BOOLEAN_FLAGS = new Set([
  "apply",
  "check",
  "dry-run",
  "fix-tags",
  "force",
  "help",
  "json",
  "list",
  "overwrite",
  "plan",
  "verify",
]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, FlagValue[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      const values = flags.get(name) ?? [];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        values.push(next);
        i += 1;
      } else {
        values.push(true);
      }
      flags.set(name, values);
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function flag(flags: Args["flags"], name: string): boolean {
  const values = flags.get(name);
  if (values === undefined) return false;
  return values.some((value) => value === true || value === "true");
}

/** 单值 flag：多次给时取最后一个。 */
function opt(flags: Args["flags"], name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** 多次给的 flag：按出现顺序返回全部值（`--preset a --preset b`）。 */
function opts(flags: Args["flags"], name: string): string[] {
  const values = flags.get(name);
  if (values === undefined) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function say(json: boolean, payload: unknown, human: string[]): void {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else for (const line of human) console.log(line);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function relPath(vaultRoot: string, abs: string): string {
  return toPosix(path.relative(vaultRoot, abs));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 没有 `--preset` 时的统一提示（CLI 不带任何内置预设）。 */
const NO_PRESET_HINT =
  "没有可用的元数据预设：CLI 不带任何内置预设，必须用 --preset <文件> 指定" +
  "（一条预设一个 .json，可以给多次）。示例预设见 tools/example-profiles/*.json。";

// ── 预设（preset）读取 ───────────────────────────────────────────────────────

/** 一份预设文件的读取结果（不抛错，坏文件也能显示原因）。 */
interface CliPresetFile {
  /** 命令行里给的原始路径（报错时用）。 */
  given: string;
  /** 本地绝对路径。 */
  absPath: string;
  /** 解析出来的预设（JSON 坏时没有）。 */
  profile?: ParseProfile;
  /** 正文模板原文（预设的 `template` 指向的 vault 内 `.md`）。 */
  body?: string;
  /** 正文模板的 vault 相对路径。 */
  bodyRelPath?: string;
  /** 旧格式顶层键名（空数组 ⇒ 不是旧格式）。 */
  legacyKeys: string[];
  issues: ProfileIssue[];
}

/**
 * 读一份预设文件（**不抛错**）。
 *
 * 与 core 的 `inspectProfileFile` 同一套语义，差别只有一处：**预设文件本身**按
 * 当前工作目录解析（CLI 的文件参数惯例），而预设里的 `template`（正文 `.md`）
 * 仍按 vault 相对路径解析（`readVaultTextFile(..., "metadata")`）。
 *
 * `readBody=false` 时**不碰正文模板**（gallery 只需要 frontmatter 的键顺序，
 * 不该因为 vault 里还没有那个 .md 就失败）。
 */
function inspectCliPreset(
  vaultRoot: string | undefined,
  given: string,
  readBody = true,
): CliPresetFile {
  const out: CliPresetFile = { given, absPath: path.resolve(given), legacyKeys: [], issues: [] };
  let text: string;
  try {
    text = fs.readFileSync(out.absPath, "utf8");
  } catch (error) {
    out.issues.push({ level: "error", message: `元数据预设 ${given} 读不了：${errText(error)}` });
    return out;
  }

  const doc = parseProfileDocument(text, given);
  out.legacyKeys = doc.legacyKeys;
  out.issues.push(...doc.issues);
  if (doc.profile === undefined) return out;

  const profile = doc.profile;
  out.profile = profile;

  // 正文模板：vault 相对路径（core 的 readVaultTextFile 同口径）。
  const templatePath = typeof profile.template === "string" ? profile.template.trim() : "";
  if (readBody && templatePath !== "") {
    if (vaultRoot === undefined) {
      out.issues.push({
        level: "warn",
        message: `元数据预设 ${given} 指向正文模板 ${templatePath}，但没有 --vault：跳过正文模板检查`,
      });
    } else {
      try {
        const file = readVaultTextFile(vaultRoot, templatePath, "metadata");
        out.bodyRelPath = file.relPath;
        if (startsWithFrontmatter(file.text)) {
          out.issues.push({
            level: "error",
            message: `正文模板 ${file.relPath} 不能自带 frontmatter（frontmatter 由预设的 frontmatter 字典生成）`,
          });
        } else {
          out.body = file.text;
        }
      } catch (error) {
        out.issues.push({ level: "error", message: errText(error) });
      }
    }
  }

  try {
    out.issues.push(...validateProfile(profile, out.body === undefined ? {} : { bodyText: out.body }));
  } catch (error) {
    out.issues.push({ level: "error", message: `校验失败：${errText(error)}` });
  }
  return out;
}

/**
 * 读全部预设文件并检查跨文件 id 重复（错误留在各自的 issues 里，不抛）。
 */
function inspectCliPresets(
  vaultRoot: string | undefined,
  givens: string[],
  readBody = true,
): CliPresetFile[] {
  const files = givens.map((given) => inspectCliPreset(vaultRoot, given, readBody));
  const firstById = new Map<string, string>();
  for (const file of files) {
    if (file.profile === undefined) continue;
    const id = file.profile.id;
    const previous = firstById.get(id);
    if (previous === undefined) {
      firstById.set(id, file.given);
      continue;
    }
    file.issues.push({ level: "error", message: `元数据预设 id「${id}」重复：${previous} 与 ${file.given}` });
  }
  return files;
}

/** 读全部预设文件；任何一份有 error ⇒ 抛错（错误里带文件路径）。 */
function loadCliPresets(vaultRoot: string | undefined, givens: string[], readBody = true): CliPresetFile[] {
  const files = inspectCliPresets(vaultRoot, givens, readBody);
  const errors = files.flatMap((file) =>
    file.issues
      .filter((issue) => issue.level === "error")
      // 读盘/JSON/legacy 一类的错误文案已经带上了文件路径，别重复加前缀。
      .map((issue) => (issue.message.includes(file.given) ? issue.message : `${file.given}: ${issue.message}`)),
  );
  if (errors.length > 0) throw new Error(errors.join("；"));
  return files;
}

/** 按 id 在已读到的预设里找一条。 */
function profileById(files: CliPresetFile[], id: string): ParseProfile {
  for (const file of files) {
    if (file.profile !== undefined && file.profile.id === id) return file.profile;
  }
  throw new Error(`找不到预设 id「${id}」（用 profiles --list 看有哪些）`);
}

/** `--ask key=value`（可给多次）⇒ ask 变量表。 */
function parseAsk(flags: Args["flags"]): Record<string, string> {
  const ask: Record<string, string> = {};
  for (const entry of opts(flags, "ask")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`--ask 需要 key=value 的写法：${entry}`);
    ask[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
  }
  return ask;
}

/**
 * 画廊模板（`.base`）：`--template <file>` 给文件路径；不给 ⇒ CLI 内置的 default 预设。
 * （CLI 不读插件设置里登记的外部模板 —— 没有设置页可点。）
 */
function loadGalleryTemplate(flags: Args["flags"]): ResolvedTemplate {
  const value = opt(flags, "template");
  if (value !== undefined) {
    const abs = path.resolve(value);
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new Error(`--template「${value}」不是文件路径（画廊模板请给 .base 文件）`);
    return readTemplateFile(abs, abs);
  }
  const presets = presetTemplates("base");
  const preset = presets.find((entry) => entry.id === "default") ?? presets[0];
  if (preset === undefined) throw new Error("没有可用的画廊模板预设");
  return { id: preset.id, label: `CLI 内置预设 ${preset.id}`, text: preset.text };
}

/**
 * 用给定的名字造一个解析 context。
 *
 * 名字带扩展名时按「文件名」处理（stem 去扩展名）；给了 `--path` 就以它的 basename 当文件名
 * —— 与插件里 `filename: path.basename(image)` 对齐，否则 `match.filenameRegex`（带扩展名锚的）
 * 在 CLI 上永远命中不了，自动选择就验不了。
 */
function contextFromName(name: string, relpath?: string): ParseContext {
  const rel = relpath ?? name;
  const filename = relpath !== undefined ? path.basename(relpath) : name;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const parts = rel.split("/");
  return {
    stem,
    filename,
    relpath: rel,
    folderName: parts.length >= 2 ? parts[parts.length - 2] : "",
  };
}

// ── profiles 子命令 ──────────────────────────────────────────────────────────

function runProfilesList(files: CliPresetFile[]): void {
  for (const file of files) {
    const profile = file.profile;
    if (profile === undefined) {
      console.log(`?  ${file.given}（读不出来：${file.issues[0]?.message ?? "未知错误"}）`);
      continue;
    }
    const keys = profile.frontmatter === undefined ? [] : Object.keys(profile.frontmatter);
    console.log(`${profile.id}  ${profile.name}`);
    console.log(`  file=${file.given}`);
    console.log(`  source=${profile.source ?? "stem"}  regex=${profile.regex}`);
    console.log(`  frontmatter=${keys.length === 0 ? "-" : keys.join(",")}`);
    console.log(`  body=${profile.template === undefined || profile.template.trim() === "" ? "-" : file.bodyRelPath ?? profile.template}`);
    const match = profile.match;
    console.log(
      match === undefined
        ? "  match: -（不参与自动选择）"
        : `  match: relpath=${match.relpathRegex ?? "-"} filename=${match.filenameRegex ?? "-"}`,
    );
  }
  console.log(`profiles=${files.length}`);
}

function runProfilesCheck(files: CliPresetFile[]): void {
  let errors = 0;
  let warns = 0;
  for (const file of files) {
    for (const issue of file.issues) {
      const label = file.profile?.id ?? file.given;
      console.log(`[${issue.level}] ${label}: ${issue.message}`);
      if (issue.level === "error") errors += 1;
      else warns += 1;
    }
    if (file.issues.length === 0) console.log(`OK ${file.profile?.id ?? file.given}`);
  }
  console.log(`checked=${files.length} errors=${errors} warns=${warns}`);
  if (errors > 0) process.exitCode = 1;
}

/**
 * 造一份「假的」sidecar 来预览 frontmatter。
 *
 * `buildSidecarText` 会 stat 图片（取 size / btime）、并跑 magick 取宽高 —— 所以
 * 图片文件得真的存在。这里在临时目录里摆一份**同相对路径**的替身：
 * 真实文件在 vault 里就复制过来（宽高/大小都是真的），否则放一个空占位文件。
 * 临时根目录用 vault 根的同名目录，这样 session / date / tags 与真跑一致。
 */
function drySidecar(
  vaultRoot: string,
  profile: ParseProfile,
  ctx: ParseContext,
  body: string | undefined,
  ask: Record<string, string>,
): { frontmatter: string; detail?: string; note?: string } {
  // 相对路径里的 ".." / 绝对路径都先压平，别让替身文件跑出临时目录。
  const safeRel = ctx.relpath
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
  const rel = safeRel === "" ? "preview" : safeRel;

  const realPath = path.join(vaultRoot, rel);
  const isRealFile = fs.existsSync(realPath) && fs.statSync(realPath).isFile();

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "annex-parse-"));
  const tmpRoot = path.join(tmpBase, path.basename(vaultRoot));
  fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
  const fakeImage = path.join(tmpRoot, rel);
  try {
    if (isRealFile) fs.copyFileSync(realPath, fakeImage);
    else fs.writeFileSync(fakeImage, "", "utf8");
    const built = buildSidecarText(fakeImage, profile, { vaultRoot: tmpRoot, ask, body });
    const lines = built.text.split("\n");
    const end = lines.indexOf("---", 1);
    return {
      frontmatter: lines.slice(1, end === -1 ? lines.length : end).join("\n"),
      detail: built.detail,
      ...(isRealFile ? {} : { note: "图片不在 vault 里，宽高/大小用的是占位值" }),
    };
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function runProfilesParse(
  files: CliPresetFile[],
  flags: Args["flags"],
  name: string,
  vaultRoot: string | undefined,
  json: boolean,
): void {
  const usable = files.filter((file): file is CliPresetFile & { profile: ParseProfile } => file.profile !== undefined);
  if (usable.length === 0) throw new Error("没有可用的预设");
  const ctx = contextFromName(name, opt(flags, "path"));
  const fixedId = opt(flags, "profile");
  const picked = fixedId !== undefined ? profileById(usable, fixedId) : undefined;
  const profile = picked ?? pickProfile(usable.map((file) => file.profile), ctx) ?? usable[0].profile;
  const parsed = parseWithProfile(profile, ctx);
  const ask = parseAsk(flags);
  // `--sample` 与 `sidecar` 同口径：等价于 `--ask sample=<值>`（显式 --ask 优先）。
  const sample = opt(flags, "sample");
  if (sample !== undefined && sample !== "" && ask.sample === undefined) ask.sample = sample;

  // 渲染一份「假的」sidecar，把 frontmatter 真正算出来给人看。
  const source = usable.find((file) => file.profile.id === profile.id);
  let rendered: { frontmatter: string; detail?: string; note?: string } | undefined;
  let renderError: string | undefined;
  if (vaultRoot !== undefined) {
    try {
      rendered = drySidecar(vaultRoot, profile, ctx, source?.body, ask);
    } catch (error) {
      renderError = errText(error);
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          profileId: profile.id,
          source: profile.source ?? "stem",
          subject: ctx.stem,
          matched: parsed.matched,
          groups: parsed.groups,
          values: parsed.values,
          missingGroups: parsed.missingGroups,
          frontmatter: rendered?.frontmatter ?? null,
          detail: rendered?.detail ?? null,
          note: rendered?.note ?? null,
          renderError: renderError ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`profile=${profile.id} source=${profile.source ?? "stem"} matched=${parsed.matched}`);
  for (const group of parsed.groups) {
    const value = parsed.values[group] ?? "";
    const missing = parsed.missingGroups.includes(group);
    console.log(`  ${group}=${value === "" ? '""' : value}${missing ? "（组没参与匹配 ⇒ 写 YAML null）" : ""}`);
  }
  console.log(`missingGroups=${parsed.missingGroups.length === 0 ? "-" : parsed.missingGroups.join(",")}`);
  if (rendered !== undefined) {
    console.log("--- frontmatter ---");
    console.log(rendered.frontmatter);
    if (rendered.detail !== undefined) console.log(`（${rendered.detail}）`);
    if (rendered.note !== undefined) console.log(`（${rendered.note}）`);
  } else {
    console.log(
      renderError === undefined
        ? "（没给 --vault：只列变量值，不渲染 frontmatter）"
        : `（渲染 frontmatter 失败：${renderError}）`,
    );
  }
}

// ── sidecar --verify ────────────────────────────────────────────────────────

interface VerifyOptions {
  vaultRoot: string;
  files: CliPresetFile[];
  profile?: ParseProfile;
  ask: Record<string, string>;
  tag?: string;
  json: boolean;
}

/** `sidecar --verify`：逐字节比对，绝不写盘。 */
function runSidecarVerify(dir: string, opts: VerifyOptions): void {
  const images = collectImages(dir);
  const usable = opts.files.filter((file): file is CliPresetFile & { profile: ParseProfile } => file.profile !== undefined);
  const usedIds = new Set<string>();
  const entries: Array<Record<string, unknown>> = [];
  let same = 0;
  let diff = 0;
  let missing = 0;

  for (const image of images) {
    const stem = stemOf(image);
    const ctx: ParseContext = {
      stem,
      filename: path.basename(image),
      relpath: relPath(opts.vaultRoot, image),
      folderName: path.basename(path.dirname(image)),
    };
    const profile = opts.profile ?? pickProfile(usable.map((file) => file.profile), ctx) ?? usable[0]?.profile;
    if (profile === undefined) throw new Error("没有可用预设");
    usedIds.add(profile.id);
    const source = usable.find((file) => file.profile.id === profile.id);
    const built = buildSidecarText(image, profile, {
      vaultRoot: opts.vaultRoot,
      ask: opts.ask,
      ...(opts.tag === undefined ? {} : { tag: opts.tag }),
      ...(source?.body === undefined ? {} : { body: source.body }),
    });
    const sidecar = path.join(path.dirname(image), `${stem}.md`);
    const rel = relPath(opts.vaultRoot, sidecar);

    let actual: string | null = null;
    try {
      actual = fs.readFileSync(sidecar, "utf8");
    } catch {
      actual = null;
    }

    if (actual === null) {
      missing += 1;
      entries.push({ sidecar: rel, status: "missing" });
      if (!opts.json) console.log(`缺失 ${rel}（盘上没有这份 .md）`);
      continue;
    }
    if (actual === built.text) {
      same += 1;
      entries.push({ sidecar: rel, status: "same" });
      continue;
    }

    diff += 1;
    const expected = built.text.split("\n");
    const got = actual.split("\n");
    const lines: string[] = [];
    const max = Math.max(expected.length, got.length);
    for (let i = 0; i < max && lines.length < 8; i += 1) {
      const e = expected[i] ?? "<缺行>";
      const g = got[i] ?? "<缺行>";
      if (e !== g) lines.push(`  第 ${i + 1} 行\n    - 盘上: ${JSON.stringify(g)}\n    + 期望: ${JSON.stringify(e)}`);
    }
    entries.push({ sidecar: rel, status: "diff", lines });
    if (!opts.json) {
      console.log(`差异 ${rel}（profile ${profile.id}）`);
      for (const line of lines) console.log(line);
    }
  }

  const profileIds = [...usedIds];
  if (opts.json) {
    console.log(JSON.stringify({ dir, images: images.length, same, diff, missing, profileIds, entries }, null, 2));
  } else {
    console.log(`verify dir=${dir} images=${images.length} same=${same} diff=${diff} missing=${missing} profile(s)=${profileIds.join(",")}`);
  }
  if (diff > 0 || missing > 0) process.exitCode = 1;
}

const HELP = `annex-gallery <command> [options]

commands
  init     <dir>                                       初始化 gallery（git init + git annex init + annex.addunlocked=true + 合并 .gitattributes/.gitignore）
  thumbs   <dir> [--edge 256] [--dry-run] [--force]     为目录内所有图片生成 .thumbnail.png
  sidecar  <dir> --vault <root> --preset <json>        为目录内所有图片生成 <stem>.md（默认 dry-run，--apply 才写）
           [--preset <json> ...] [--profile <id>] [--sample <name>] [--ask key=value] [--repo <root>]
           [--apply] [--force] [--overwrite] [--plan] [--verify] [--json]
  gallery  <dir> --vault <root> --preset <json>        盘点目录并生成 <文件夹>/<文件夹名>.base（默认 dry-run）
           [--preset <json> ...] [--template <file>] [--edge 256] [--apply] [--overwrite] [--fix-tags] [--json]
           --fix-tags（需 --apply）给旧 sidecar 只补 annex-gallery-metadata 标签
  profiles --list                                      列出每条预设的 id/name/source/frontmatter 键/正文路径
           --check                                     对全部预设跑 validateProfile（有 error 退 1）
           --parse <名字> [--path <相对路径>] [--profile <id>]   打印解析出的组值、缺失的组与算出来的 frontmatter
           两个子命令都需要 --preset <json>（可给多次）；--check 的正文模板检查需要 --vault
  stems    <dir>                                        统计重名 basename（跨会话重名）
  drop     <dir> [--dry-run] [--force]                  丢掉目录内 annex 内容的本地副本（默认只丢别处有足够副本的）
  annex    <op> <dir>                                   largefiles 操作（插件右键菜单同款）：add | unlock | lock | get | unannex | drop
  defaults                                              打印插件内置的 .gitattributes 模板

元数据预设：一份 .json 一条预设（顶层就是一条 ParseProfile），用 --preset 指定（可重复）。
CLI 不带任何内置预设：不给 --preset 会直接报错。预设文件路径按当前工作目录解析；
预设里的 template（正文 .md）按 --vault 解析。

common flags: --json   --dry-run   --force   --profile <id>   --preset <json>`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const json = flag(flags, "json");
  const dryRun = flag(flags, "dry-run");
  const progress = (message: string): void => {
    if (!json) console.log(progressPrefix(message));
  };

  switch (command) {
    case "init": {
      const dir = path.resolve(positional[1] ?? "");
      if (positional[1] === undefined) throw new Error("init 需要 <dir>");
      const result = await initGallery(dir, { dryRun, progress });
      say(json, result, [
        `root=${result.root}`,
        `createdRepo=${result.createdRepo} initedAnnex=${result.initedAnnex}`,
        `annex.addunlocked（分支）=${result.shape.addUnlocked.action}${
          result.shape.addUnlocked.action === "set" || result.shape.addUnlocked.action === "planned"
            ? `，原值 ${result.shape.addUnlocked.previous ?? "(无)"}`
            : ""
        } → 生效值 ${result.shape.effectiveAddUnlocked ?? "(无)"}`,
        ...(result.shape.localRepairs.length === 0
          ? ["本机设置：无偏离"]
          : result.shape.localRepairs.map(
              (entry) => `本机 ${entry.key}：${entry.previous ?? "(无)"} → ${entry.action}${entry.detail === undefined ? "" : `（${entry.detail}）`}`,
            )),
        `annex.thin 生效值 ${result.shape.effectiveThin ?? "(无)"}`,
        `.gitattributes +${result.gitattributes.added.length} (${result.gitattributes.added.join(" | ")})`,
        `.gitignore +${result.gitignore.added.length} (${result.gitignore.added.join(" | ")})`,
        ...result.notes,
      ]);
      return;
    }
    case "thumbs": {
      if (positional[1] === undefined) throw new Error("thumbs 需要 <dir>");
      const dir = path.resolve(positional[1]);
      const edgeRaw = opt(flags, "edge");
      const edge = edgeRaw === undefined ? undefined : Number.parseInt(edgeRaw, 10);
      const report = await generateThumbnails(dir, {
        edge,
        dryRun,
        force: flag(flags, "force"),
        progress,
      });
      say(json, report, [
        `dir=${report.dir} edge=${report.edge}`,
        `created=${report.created} skipped=${report.skipped} failed=${report.failed}`,
        ...report.entries
          .filter((e) => e.action !== "skipped")
          .map((e) => `  ${e.action} ${path.basename(e.thumbnail)}${e.detail === undefined ? "" : ` (${e.detail})`}`),
      ]);
      return;
    }
    case "sidecar": {
      if (positional[1] === undefined) throw new Error("sidecar 需要 <dir>");
      const dir = path.resolve(positional[1]);
      const vaultRoot = opt(flags, "vault");
      if (vaultRoot === undefined) throw new Error("sidecar 需要 --vault <vaultRoot>（链接写全 vault 路径）");
      const resolvedVault = path.resolve(vaultRoot);
      const presetPaths = opts(flags, "preset");
      if (presetPaths.length === 0) throw new Error(NO_PRESET_HINT);
      const files = loadCliPresets(resolvedVault, presetPaths);
      const profiles = files.map((file) => file.profile as ParseProfile);
      const fixedId = opt(flags, "profile");
      const profile = fixedId === undefined ? undefined : profileById(files, fixedId);
      const sample = opt(flags, "sample");
      const ask = parseAsk(flags);
      if (sample !== undefined && sample !== "" && ask.sample === undefined) ask.sample = sample;

      if (flag(flags, "verify")) {
        runSidecarVerify(dir, {
          vaultRoot: resolvedVault,
          files,
          ...(profile === undefined ? {} : { profile }),
          ask,
          ...(opt(flags, "tag") === undefined ? {} : { tag: opt(flags, "tag") }),
          json,
        });
        return;
      }

      if (flag(flags, "plan")) {
        // 重跑前的只读预览：「生成元数据」里那个「是否覆盖」弹窗数出来的东西。
        const planned = planSidecarTargets(dir, path.resolve(opt(flags, "repo") ?? vaultRoot));
        say(json, planned, [
          `dir=${dir}`,
          `images=${planned.images} existing=${planned.existing} dirty=${planned.dirty}`,
          planned.existing === 0
            ? "没有已存在的 sidecar（重跑不会覆盖任何东西）"
            : `已有 ${planned.existing} 份 sidecar${planned.dirty > 0 ? `（其中 ${planned.dirty} 份被改过）` : ""} —— 加 --overwrite 覆盖重算，不加就只补缺失`,
        ]);
        return;
      }

      const report = await generateSidecars(dir, {
        vaultRoot: resolvedVault,
        repoRoot: path.resolve(opt(flags, "repo") ?? vaultRoot),
        sample,
        ask,
        ...(profile === undefined ? {} : { profile }),
        profiles,
        tag: opt(flags, "tag"),
        apply: flag(flags, "apply"),
        force: flag(flags, "force"),
        overwrite: flag(flags, "overwrite"),
        progress,
      });
      const counts = report.entries.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.action] = (acc[entry.action] ?? 0) + 1;
        return acc;
      }, {});
      say(json, report, [
        `dir=${report.dir} dryRun=${report.dryRun} sample=${sample ?? ""} profile=${report.profileId} mismatch=${report.mismatch}`,
        `actions=${JSON.stringify(counts)}`,
        `duplicateStems=${JSON.stringify(report.duplicateStems)}`,
        ...report.entries.map((e) => `  ${e.action} ${path.basename(e.sidecar)}${e.detail === undefined ? "" : ` (${e.detail})`}`),
      ]);
      return;
    }
    case "gallery": {
      if (positional[1] === undefined) throw new Error("gallery 需要 <dir>");
      const dir = path.resolve(positional[1]);
      const vaultRoot = opt(flags, "vault");
      if (vaultRoot === undefined) throw new Error("gallery 需要 --vault <vaultRoot>（文件夹/画廊路径都相对 vault 算）");
      const resolvedVault = path.resolve(vaultRoot);
      const vaultName = path.basename(resolvedVault);
      const rel = toPosix(path.relative(resolvedVault, dir));
      if (rel === ".." || rel.startsWith("../")) {
        throw new Error(`gallery 的 <dir> 不在 --vault 里：${dir}（vault=${resolvedVault}）`);
      }
      const folder = rel === "" || rel === "." ? "" : rel;

      const edgeRaw = opt(flags, "edge");
      let edge = 256;
      if (edgeRaw !== undefined) {
        const parsed = Number.parseInt(edgeRaw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--edge 需要正整数：${edgeRaw}`);
        edge = parsed;
      }

      const apply = flag(flags, "apply");
      const overwrite = flag(flags, "overwrite");
      const fixTags = flag(flags, "fix-tags");
      if (fixTags && !apply) throw new Error("--fix-tags 只能和 --apply 一起用（dry-run 不写盘）");

      const presetPaths = opts(flags, "preset");
      if (presetPaths.length === 0) throw new Error(NO_PRESET_HINT);
      // gallery 只要 frontmatter 的键顺序，不读正文模板 —— vault 里还没有那个 .md 也不该失败。
      const files = loadCliPresets(resolvedVault, presetPaths, false);
      const template = loadGalleryTemplate(flags);
      const plan = planGallery(dir);
      // 属性顺序 = 各预设 frontmatter 字典的键顺序（不再有 keyOrder）。
      const properties = orderProperties(
        plan.keys,
        files.map((file) => Object.keys((file.profile as ParseProfile).frontmatter ?? {})),
      );
      const built = buildGalleryBase(template, { folder, cardSize: edge, properties });
      const targetRel = galleryFilePath(folder, vaultName);
      const targetAbs = path.join(resolvedVault, targetRel);

      const fixedTags: string[] = [];
      let wrote = false;
      if (apply) {
        // 先拦「已存在」再动手：不加 --overwrite 时连 --fix-tags 的改动都不该发生。
        if (fs.existsSync(targetAbs) && !overwrite) {
          throw new Error(`画廊文件已存在：${targetRel}（要重新生成请加 --overwrite）`);
        }
        if (fixTags) {
          for (const sidecar of plan.untagged) {
            const before = fs.readFileSync(sidecar, "utf8");
            const after = addGalleryTag(before);
            if (after === null || after === before) continue;
            fs.writeFileSync(sidecar, after, "utf8");
            fixedTags.push(relPath(resolvedVault, sidecar));
          }
        }
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, built.text, "utf8");
        wrote = true;
      }

      say(
        json,
        { plan, properties, target: targetRel, text: built.text, missing: built.missing, wrote, fixedTags },
        [
          `dir=${dir} vault=${resolvedVault} folder=${folder === "" ? "(vault 根)" : folder}`,
          `images=${plan.images} tagged=${plan.tagged} untagged=${plan.untagged.length} missingSidecars=${plan.missingSidecars} missingThumbnails=${plan.missingThumbnails}`,
          `properties=${JSON.stringify(properties)}`,
          `template=${template.label}`,
          `target=${targetRel}`,
          ...(built.missing.length === 0 ? [] : [`模板里取不到值的占位符：${built.missing.join(", ")}（已留空）`]),
          ...(apply
            ? [`wrote=${wrote}${fixTags ? ` fixedTags=${fixedTags.length === 0 ? "0" : fixedTags.join(", ")}` : ""}`]
            : ["dry-run：没有写任何文件（加 --apply 才写画廊）"]),
          "--- gallery 内容 ---",
          built.text,
        ],
      );
      return;
    }
    case "profiles": {
      const presetPaths = opts(flags, "preset");
      if (presetPaths.length === 0) throw new Error(NO_PRESET_HINT);
      const vaultRoot = opt(flags, "vault");
      const resolvedVault = vaultRoot === undefined ? undefined : path.resolve(vaultRoot);
      const files = inspectCliPresets(resolvedVault, presetPaths);
      const parseName = opt(flags, "parse");
      let didSomething = false;
      if (parseName !== undefined) {
        runProfilesParse(files, flags, parseName, resolvedVault, json);
        didSomething = true;
      }
      if (flag(flags, "check")) {
        runProfilesCheck(files);
        didSomething = true;
      }
      if (flag(flags, "list") || !didSomething) runProfilesList(files);
      return;
    }
    case "annex": {
      const ops: AnnexOp[] = ["add", "unlock", "lock", "get", "unannex", "drop"];
      const op = positional[1];
      const dirArg = positional[2];
      if (op === undefined) throw new Error(`annex 需要 <op>：${ops.join(" | ")}`);
      if (!(ops as string[]).includes(op)) throw new Error(`不认识的 annex 操作：${op}（可用：${ops.join(" | ")}）`);
      if (dirArg === undefined) throw new Error(`annex ${op} 需要 <dir>`);
      const report = await runAnnexOp(op as AnnexOp, path.resolve(dirArg), { progress });
      say(json, report, [
        `op=${report.op}（${ANNEX_OP_TITLE[report.op]}）dir=${report.dir}`,
        `repo=${report.repoRoot} subpath=${report.relpath === "" ? "." : report.relpath}`,
        `ok=${report.ok} skipped=${report.skipped} failed=${report.failed}${
          report.candidates === undefined ? "" : ` candidates=${report.candidates}`
        }${report.staged === undefined ? "" : ` staged=${report.staged}`}${
          report.bytesFreed === undefined ? "" : ` freed=${report.bytesFreed} B`
        }`,
        ...report.entries.map((entry) => `  ${entry.action} ${entry.file}${entry.detail === undefined ? "" : ` (${entry.detail})`}`),
      ]);
      return;
    }
    case "drop": {
      if (positional[1] === undefined) throw new Error("drop 需要 <dir>");
      const report = await dropLargefiles(path.resolve(positional[1]), {
        dryRun,
        force: flag(flags, "force"),
        progress,
      });
      say(json, report, [
        `dir=${report.dir} repo=${report.repoRoot} subpath=${report.relpath === "" ? "." : report.relpath}`,
        `present=${report.present} (${report.bytesPresent} B) dropped=${report.dropped} freed=${report.bytesFreed} B skipped=${report.skipped} failed=${report.failed}`,
        ...report.entries
          .filter((entry) => entry.action !== "planned")
          .map((entry) => `  ${entry.action} ${entry.file}${entry.detail === undefined ? "" : ` (${entry.detail})`}`),
      ]);
      return;
    }
    case "stems": {
      if (positional[1] === undefined) throw new Error("stems 需要 <dir>");
      const report = duplicateStems(path.resolve(positional[1]));
      say(json, report, [
        `dir=${report.dir} total=${report.total} collisions=${report.collisions.length}`,
        ...report.collisions.map((c) => `  ${c.stem} ×${c.count}`),
      ]);
      return;
    }
    case "defaults": {
      say(json, { gitattributes: GITATTRIBUTES_TEMPLATE, gitignore: GITIGNORE_TEMPLATE }, [
        GITATTRIBUTES_TEMPLATE,
        "--- .gitignore ---",
        GITIGNORE_TEMPLATE,
      ]);
      return;
    }
    default:
      console.log(HELP);
      if (command !== undefined && command !== "help" && command !== "--help") process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(`annex-gallery: ${String(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
