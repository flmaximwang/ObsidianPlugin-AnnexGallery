#!/usr/bin/env node
/**
 * Annex Gallery CLI — the same core modules the plugin uses, without Obsidian.
 *
 * It exists so every plan criterion can be executed and re-executed from a
 * terminal:
 *
 *   node tools/annex-gallery.mjs init    <dir> [--dry-run] [--json]
 *   node tools/annex-gallery.mjs thumbs  <dir> [--edge 256] [--dry-run] [--force] [--json]
 *   node tools/annex-gallery.mjs sidecar <dir> --vault <vaultRoot> --sample <name> [--repo <root>] [--apply] [--force] [--json]
 *   node tools/annex-gallery.mjs stems   <dir> [--json]
 *   node tools/annex-gallery.mjs defaults            # print the bundled .gitattributes
 */
import * as path from "path";
import { initGallery } from "../src/core/init";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "../src/core/rules";
import { generateSidecars } from "../src/core/sidecar";
import { duplicateStems } from "../src/core/stems";
import { generateThumbnails } from "../src/core/thumbnails";
import { progressPrefix } from "../src/core/types";

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

const HELP = `annex-gallery <command> [options]

commands
  init     <dir>                                       初始化 gallery（git init + git annex init + 合并 .gitattributes/.gitignore）
  thumbs   <dir> [--edge 256] [--dry-run] [--force]     为目录内所有图片生成 .thumbnail.png
  sidecar  <dir> --vault <root> --sample <name>         为目录内所有图片生成 <stem>.md（默认 dry-run，--apply 才写）
           [--repo <root>] [--apply] [--force]
  stems    <dir>                                        统计重名 basename（跨会话重名）
  defaults                                              打印插件内置的 .gitattributes 模板

common flags: --json   --dry-run   --force`;

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
      const sample = opt(flags, "sample");
      if (vaultRoot === undefined) throw new Error("sidecar 需要 --vault <vaultRoot>（链接写全 vault 路径）");
      if (sample === undefined || sample === "") throw new Error("sidecar 需要 --sample <样品名>（写进 frontmatter 的 sample）");
      const report = await generateSidecars(dir, {
        vaultRoot: path.resolve(vaultRoot),
        repoRoot: path.resolve(opt(flags, "repo") ?? vaultRoot),
        sample,
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
        `dir=${report.dir} dryRun=${report.dryRun} sample=${sample}`,
        `actions=${JSON.stringify(counts)}`,
        `duplicateStems=${JSON.stringify(report.duplicateStems)}`,
        ...report.entries.map((e) => `  ${e.action} ${path.basename(e.sidecar)}${e.detail === undefined ? "" : ` (${e.detail})`}`),
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
