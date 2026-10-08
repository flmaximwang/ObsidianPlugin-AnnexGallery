import * as fs from "fs";
import * as path from "path";
import { Progress } from "./types";
import { git, magickBinary, run } from "./git";
import { collectImages, stemOf } from "./stems";

/** Frontmatter keys, in the exact order the 218 existing sidecars use. */
export const SIDECAR_KEYS = [
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
] as const;

export interface SingleSidecarOptions {
  /** Vault root — links are written as full vault-relative paths. */
  vaultRoot: string;
  /** Git repo the images live in (dirty-file guard). */
  repoRoot: string;
  /** Sample name written into `sample`. */
  sample: string;
  /** Defaults to the first path component under the vault root (e.g. `TEM`). */
  tag?: string;
  /** Write to disk. Default false = dry run. */
  apply?: boolean;
  /** Overwrite / touch files that git reports as dirty. */
  force?: boolean;
  progress?: Progress;
}

export interface SidecarEntry {
  image: string;
  sidecar: string;
  action: "created" | "planned" | "skipped-dirty" | "skipped-existing" | "failed";
  detail?: string;
}

export interface SidecarReport {
  dir: string;
  dryRun: boolean;
  entries: SidecarEntry[];
  /** `stem` → number of images sharing it (only entries with collisions). */
  duplicateStems: Record<string, number>;
}

/** `<mag>X-<lens>-<index>` — the legacy microscope stem shape. */
const STEM_PATTERN = /^(\d+)X-(\d+)-(\d+)$/;
const YAML_EMPTY = '""';

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

interface SidecarFields {
  tag: string;
  sample: string;
  session: string;
  date: string;
  magnification: string;
  lens: string;
  index: string;
  width: string;
  height: string;
  size: string;
  btime: string;
  relThumb: string;
  relOrig: string;
}

/** Render the sidecar body byte-for-byte like the 218 existing files. */
function renderSidecar(f: SidecarFields): string {
  return (
    [
      "---",
      "tags:",
      `  - ${f.tag}`,
      `sample: "${f.sample}"`,
      `session: "${f.session}"`,
      `date: ${f.date}`,
      `magnification: ${f.magnification}`,
      `lens: ${f.lens}`,
      `index: ${f.index}`,
      `width: ${f.width}`,
      `height: ${f.height}`,
      `size: ${f.size}`,
      `eagleId: ""`,
      `btime: ${f.btime}`,
      `thumbnail: "[[${f.relThumb}]]"`,
      `tif: "[[${f.relOrig}]]"`,
      "---",
      "",
      `![[${f.relThumb}]]`,
      "",
      `原图（用系统默认程序打开）：[[${f.relOrig}]]`,
      "",
    ].join("\n")
  );
}

function buildSidecar(image: string, opts: SingleSidecarOptions): { text: string; detail?: string } {
  const stem = stemOf(image);
  const imageDir = path.dirname(image);
  const session = path.basename(imageDir);
  const tag = opts.tag ?? firstSegment(vaultRelative(opts.vaultRoot, imageDir));

  const match = STEM_PATTERN.exec(stem);
  let magnification: string;
  let lens: string;
  let index: string;
  let detail: string | undefined;
  if (match !== null) {
    magnification = String(Number.parseInt(match[1], 10));
    lens = String(Number.parseInt(match[2], 10));
    index = String(Number.parseInt(match[3], 10));
  } else {
    magnification = YAML_EMPTY;
    lens = YAML_EMPTY;
    index = YAML_EMPTY;
    detail = "stem 不符合 <mag>X-<lens>-<index>";
  }

  const { width, height } = identifyGeometry(image);
  const stat = fs.statSync(image);
  const relThumb = vaultRelative(opts.vaultRoot, path.join(imageDir, `${stem}.thumbnail.png`));
  const relOrig = vaultRelative(opts.vaultRoot, image);

  const text = renderSidecar({
    tag,
    sample: opts.sample,
    session,
    date: dateFromSession(session),
    magnification,
    lens,
    index,
    width,
    height,
    size: String(stat.size),
    btime: formatBtime(stat.birthtime),
    relThumb,
    relOrig,
  });
  return detail === undefined ? { text } : { text, detail };
}

/** Non-empty `git status --porcelain` for `target` ⇒ the file is dirty. */
function isDirty(repoRoot: string, target: string): boolean {
  const rel = toPosix(path.relative(repoRoot, target));
  const result = git(["status", "--porcelain", "--", rel], repoRoot);
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
 * Writes one `<stem>.md` per source image, with a frontmatter block whose key
 * set/order matches the 218 existing sidecars and full vault-path wikilinks.
 * Dry run by default; existing targets are only rewritten when git reports
 * them dirty *and* `force` is set.
 */
export async function generateSidecars(dir: string, opts: SingleSidecarOptions): Promise<SidecarReport> {
  const apply = opts.apply === true;
  const force = opts.force === true;
  const progress: Progress = opts.progress ?? ((): void => {});

  const images = collectImages(dir);
  progress(`开始生成 sidecar：${dir}（${images.length} 张，${apply ? "写入" : "dry-run"}）`);

  const entries: SidecarEntry[] = [];
  const stemCounts = new Map<string, number>();

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const stem = stemOf(image);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
    const sidecar = path.join(path.dirname(image), `${stem}.md`);
    const label = `[${i + 1}/${images.length}]`;
    try {
      const built = buildSidecar(image, opts);
      if (fs.existsSync(sidecar)) {
        const dirty = isDirty(opts.repoRoot, sidecar);
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

  return { dir, dryRun: !apply, entries, duplicateStems };
}
