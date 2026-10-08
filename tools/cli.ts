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
 *                                        [--profile <id>] [--profiles-file <json>] [--verify] [--repo <root>] [--apply] [--force] [--json]
 *   node tools/annex-gallery.mjs profiles --list | --check | --parse <name> [--path <relpath>] [--profile <id>] [--profiles-file <json>]
 *   node tools/annex-gallery.mjs stems   <dir> [--json]
 *   node tools/annex-gallery.mjs defaults            # print the bundled .gitattributes
 */
import * as fs from "fs";
import * as path from "path";
import { initGallery } from "../src/core/init";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "../src/core/rules";
import { buildSidecarText, generateSidecars } from "../src/core/sidecar";
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
    const built = buildSidecarText(image, profile, { vaultRoot: opts.vaultRoot, ask: opts.ask, ...(opts.tag === undefined ? {} : { tag: opts.tag }) });
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
  init     <dir>                                       初始化 gallery（git init + git annex init + 合并 .gitattributes/.gitignore）
  thumbs   <dir> [--edge 256] [--dry-run] [--force]     为目录内所有图片生成 .thumbnail.png
  sidecar  <dir> --vault <root> [--sample <name>]       为目录内所有图片生成 <stem>.md（默认 dry-run，--apply 才写）
           [--profile <id>] [--profiles-file <json>] [--verify] [--repo <root>] [--apply] [--force]
  profiles --list                                      列出每条 profile 的 id/name/source/键顺序
  profiles --check                                     对全部 profile 跑 validateProfile（有 error 退 1）
  profiles --parse <名字> [--path <相对路径>] [--profile <id>]   打印解析出的键值、标出没命中的组
  stems    <dir>                                        统计重名 basename（跨会话重名）
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

      if (flag(flags, "verify")) {
        runSidecarVerify(dir, {
          vaultRoot: resolvedVault,
          profiles,
          ...(profile === undefined ? {} : { profile }),
          ask,
          ...(opt(flags, "tag") === undefined ? {} : { tag: opt(flags, "tag") }),
          json,
        });
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
