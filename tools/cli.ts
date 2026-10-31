#!/usr/bin/env node
/**
 * Annex Gallery CLI — the same core modules the plugin uses, without Obsidian.
 *
 * It exists so every plan criterion can be executed and re-executed from a
 * terminal:
 *
 *   node tools/annex-gallery.mjs init    <dir> [--dry-run] [--json]
 *   node tools/annex-gallery.mjs thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
 *   node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> [--sample <name>]
 *                                        [--profile <id>] [--profiles-file <json>] [--template <id|file>]
 *                                        [--verify] [--repo <root>] [--apply] [--force] [--json]
 *   node tools/annex-gallery.mjs gallery <dir> --vault <root> [--template <id|file>] [--profiles-file <json>]
 *                                        [--edge 256] [--apply] [--overwrite] [--fix-tags] [--json]
 *   node tools/annex-gallery.mjs profiles --list | --check | --parse <name> [--path <relpath>] [--profile <id>] [--profiles-file <json>]
 *   node tools/annex-gallery.mjs stems   <dir> [--json]
 *   node tools/annex-gallery.mjs drop    <dir> [--dry-run] [--force] [--json]   # 丢本地 annex 内容
 *   node tools/annex-gallery.mjs annex   <add|unlock|lock|get|unannex|drop> <dir> [--json]
 *   node tools/annex-gallery.mjs defaults            # print the bundled .gitattributes
 */
import * as fs from "fs";
import * as path from "path";
import { initGallery } from "../src/core/init";
import { ANNEX_OP_TITLE, AnnexOp, dropLargefiles, runAnnexOp } from "../src/core/annex";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "../src/core/rules";
import { buildSidecarText, generateSidecars, planSidecarTargets } from "../src/core/sidecar";
import { addGalleryTag, buildGalleryBase, galleryFilePath, orderProperties, planGallery } from "../src/core/gallery";
import {
  readTemplateFile,
  resolveTemplate,
  type ResolvedTemplate,
  type TemplateKind,
} from "../src/core/templates";
import { collectImages, duplicateStems, stemOf } from "../src/core/stems";
import { generateThumbnails } from "../src/core/thumbnails";
import { progressPrefix } from "../src/core/types";
import {
  DEFAULT_PROFILES,
  parseWithProfile,
  pickProfile,
  validateProfile,
  type ParseContext,
  type ParseProfile,
} from "../src/core/profiles";

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function flag(flags: Args["flags"], name: string): boolean {
  return flags.get(name) === true || flags.get(name) === "true";
}

function opt(flags: Args["flags"], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
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

/** profile 数据默认取 DEFAULT_PROFILES；`--profiles-file <json>` 可从文件读。 */
function loadProfiles(flags: Args["flags"]): ParseProfile[] {
  const file = opt(flags, "profiles-file");
  if (file === undefined) return DEFAULT_PROFILES;
  const raw = fs.readFileSync(path.resolve(file), "utf8");
  const data: unknown = JSON.parse(raw);
  const list = Array.isArray(data)
    ? data
    : data !== null && typeof data === "object" && Array.isArray((data as { profiles?: unknown }).profiles)
      ? (data as { profiles: unknown[] }).profiles
      : undefined;
  if (list === undefined) throw new Error("--profiles-file 的 JSON 必须是 profile 数组，或 { \"profiles\": [ … ] }");
  return list as ParseProfile[];
}

function profileById(profiles: ParseProfile[], id: string): ParseProfile {
  const found = profiles.find((profile) => profile.id === id);
  if (found === undefined) throw new Error(`找不到 profile：${id}（用 profiles --list 看有哪些）`);
  return found;
}

/**
 * `--template <id|file>`：值是一个存在的文件路径 ⇒ 直接读它；否则当模板 id 解析。
 *
 * CLI 没有设置页，所以自定义模板只能走文件路径；id 只认内置模板（`default` / metadata 的 `embed`）。
 * 没给 `--template` ⇒ `fallbackId`（metadata / base 都是内置 `default`）。
 */
function loadTemplate(
  flags: Args["flags"],
  kind: TemplateKind,
  vaultRoot: string,
  fallbackId = "default",
): ResolvedTemplate {
  const value = opt(flags, "template") ?? fallbackId;
  const abs = path.resolve(value);
  try {
    if (fs.statSync(abs).isFile()) return readTemplateFile(abs, abs);
  } catch {
    // 不是文件 ⇒ 下面按模板 id 解析（找不到会得到清楚的报错）。
  }
  return resolveTemplate(kind, value, [], vaultRoot);
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

function runProfilesList(profiles: ParseProfile[]): void {
  for (const profile of profiles) {
    console.log(`${profile.id}  ${profile.name}`);
    console.log(`  source=${profile.source ?? "stem"}  keys=${profile.keyOrder.join(",")}`);
    const match = profile.match;
    console.log(
      match === undefined
        ? "  match: -（不参与自动选择）"
        : `  match: relpath=${match.relpathRegex ?? "-"} filename=${match.filenameRegex ?? "-"}`,
    );
  }
  console.log(`profiles=${profiles.length}`);
}

function runProfilesCheck(profiles: ParseProfile[]): void {
  let errors = 0;
  let warns = 0;
  for (const profile of profiles) {
    const issues = validateProfile(profile);
    for (const issue of issues) {
      console.log(`[${issue.level}] ${profile.id}: ${issue.message}`);
      if (issue.level === "error") errors += 1;
      else warns += 1;
    }
    if (issues.length === 0) console.log(`OK ${profile.id}`);
  }
  console.log(`checked=${profiles.length} errors=${errors} warns=${warns}`);
  if (errors > 0) process.exitCode = 1;
}

function runProfilesParse(profiles: ParseProfile[], flags: Args["flags"], name: string, json: boolean): void {
  const ctx = contextFromName(name, opt(flags, "path"));
  const fixedId = opt(flags, "profile");
  const profile = fixedId !== undefined ? profileById(profiles, fixedId) : pickProfile(profiles, ctx) ?? profiles[0];
  if (profile === undefined) throw new Error("没有可用 profile");
  const parsed = parseWithProfile(profile, ctx);
  if (json) {
    console.log(JSON.stringify({ profileId: profile.id, source: profile.source ?? "stem", subject: ctx.stem, ...parsed }, null, 2));
    return;
  }
  console.log(`profile=${profile.id} source=${profile.source ?? "stem"} matched=${parsed.matched}`);
  for (const spec of profile.fields) {
    const key = spec.key ?? spec.group;
    const value = parsed.values[key] ?? "";
    const missing = parsed.missingGroups.includes(spec.group);
    console.log(`  ${key}=${value === "" ? '""' : value}${missing ? "（组没参与匹配，写 whenMissing）" : ""}`);
  }
  console.log(`missingGroups=${parsed.missingGroups.length === 0 ? "-" : parsed.missingGroups.join(",")}`);
  console.log(`extraGroups=${parsed.extraGroups.length === 0 ? "-" : parsed.extraGroups.join(",")}`);
}

interface VerifyOptions {
  vaultRoot: string;
  profiles: ParseProfile[];
  profile?: ParseProfile;
  ask: Record<string, string>;
  tag?: string;
  template?: ResolvedTemplate;
  json: boolean;
}

/** `sidecar --verify`：逐字节比对，绝不写盘。 */
function runSidecarVerify(dir: string, opts: VerifyOptions): void {
  const images = collectImages(dir);
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
    const profile = opts.profile ?? pickProfile(opts.profiles, ctx) ?? opts.profiles[0];
    if (profile === undefined) throw new Error("没有可用 profile");
    usedIds.add(profile.id);
    const built = buildSidecarText(image, profile, {
      vaultRoot: opts.vaultRoot,
      ask: opts.ask,
      ...(opts.tag === undefined ? {} : { tag: opts.tag }),
      ...(opts.template === undefined ? {} : { template: opts.template }),
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
  sidecar  <dir> --vault <root> [--sample <name>]       为目录内所有图片生成 <stem>.md（默认 dry-run，--apply 才写）
           [--profile <id>] [--profiles-file <json>] [--template <id|file>] [--verify] [--repo <root>] [--apply] [--force]
  gallery  <dir> --vault <root> [--template <id|file>]  盘点目录并生成 <文件夹>/<文件夹名>.base（默认 dry-run）
           [--profiles-file <json>] [--edge 256] [--apply] [--overwrite] [--fix-tags]
           --fix-tags（需 --apply）给旧 sidecar 只补 annex-gallery-metadata 标签
  profiles --list                                      列出每条 profile 的 id/name/source/键顺序
  profiles --check                                     对全部 profile 跑 validateProfile（有 error 退 1）
  profiles --parse <名字> [--path <相对路径>] [--profile <id>]   打印解析出的键值、标出没命中的组
  stems    <dir>                                        统计重名 basename（跨会话重名）
  drop     <dir> [--dry-run] [--force]                  丢掉目录内 annex 内容的本地副本（默认只丢别处有足够副本的）
  annex    <op> <dir>                                   largefiles 操作（插件右键菜单同款）：add | unlock | lock | get | unannex | drop
  defaults                                              打印插件内置的 .gitattributes 模板

common flags: --json   --dry-run   --force   --profile <id>   --profiles-file <json>`;

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
      const profiles = loadProfiles(flags);
      const fixedId = opt(flags, "profile");
      const profile = fixedId === undefined ? undefined : profileById(profiles, fixedId);
      const sample = opt(flags, "sample");
      const ask: Record<string, string> = {};
      if (sample !== undefined && sample !== "") ask.sample = sample;
      // 不给 --template 就不传（generate/build 内部用内置 default 模板，行为与改造前一致）。
      const template = opt(flags, "template") === undefined ? undefined : loadTemplate(flags, "metadata", resolvedVault);

      if (flag(flags, "verify")) {
        runSidecarVerify(dir, {
          vaultRoot: resolvedVault,
          profiles,
          ...(profile === undefined ? {} : { profile }),
          ask,
          ...(opt(flags, "tag") === undefined ? {} : { tag: opt(flags, "tag") }),
          ...(template === undefined ? {} : { template }),
          json,
        });
        return;
      }

      if (flag(flags, "plan")) {
        // 重跑前的只读预览：「生成元数据」里那个「是否覆盖」弹窗数出来的东西。
        const planned = planSidecarTargets(dir, resolvedVault);
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
        ...(template === undefined ? {} : { template }),
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

      const profiles = loadProfiles(flags);
      const template = loadTemplate(flags, "base", resolvedVault);
      const plan = planGallery(dir);
      const properties = orderProperties(plan.keys, profiles.map((profile) => profile.keyOrder));
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
      const profiles = loadProfiles(flags);
      const parseName = opt(flags, "parse");
      let didSomething = false;
      if (parseName !== undefined) {
        runProfilesParse(profiles, flags, parseName, json);
        didSomething = true;
      }
      if (flag(flags, "check")) {
        runProfilesCheck(profiles);
        didSomething = true;
      }
      if (flag(flags, "list") || !didSomething) runProfilesList(profiles);
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
          report.bytesFreed === undefined ? "" : ` bytesFreed=${report.bytesFreed}`
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
