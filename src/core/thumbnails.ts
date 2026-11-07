import * as fs from "fs";
import * as path from "path";
import { run, magickBinary } from "./git";
import { Progress } from "./types";

export const IMAGE_EXTENSIONS = [".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".webp"] as const;
export const THUMBNAIL_SUFFIX = ".thumbnail.png";
/** Default edge in px — kept equal to `.base`'s `cardSize` (user decision, T-003#B-001). */
export const DEFAULT_THUMBNAIL_EDGE = 256;

export interface ThumbnailOptions {
  /** Edge length of the square thumbnail, px. Default 256. */
  edge?: number;
  progress?: Progress;
  dryRun?: boolean;
  /** Rewrite thumbnails that are not older than their source. */
  force?: boolean;
}

export interface ThumbnailEntry {
  source: string;
  thumbnail: string;
  action: "created" | "planned" | "skipped" | "failed";
  detail?: string;
}

export interface ThumbnailReport {
  dir: string;
  edge: number;
  entries: ThumbnailEntry[];
  created: number;
  skipped: number;
  failed: number;
}

/** True for files we treat as images: a known extension and *not* a generated thumbnail. */
function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  // Exclude at enumeration time so a second run can never build `x.thumbnail.thumbnail.png`.
  if (lower.endsWith(THUMBNAIL_SUFFIX)) return false;
  const ext = path.extname(lower);
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Recursively collect image paths under `dir`, sorted for deterministic output. */
function listImages(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isImageName(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

/** `a/x.tif` → `a/x.thumbnail.png` (same dir, same stem, extension replaced). */
function thumbnailPathFor(source: string): string {
  const dir = path.dirname(source);
  const base = path.basename(source);
  const stem = base.slice(0, base.length - path.extname(base).length);
  return path.join(dir, `${stem}${THUMBNAIL_SUFFIX}`);
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const line = trimmed.split(/\r?\n/)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.trim().split(/\r?\n/)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

const ACTION_LABEL: Record<ThumbnailEntry["action"], string> = {
  created: "Created",
  planned: "Planned",
  skipped: "Skipped",
  failed: "Failed",
};

function generateOne(
  source: string,
  thumbnail: string,
  edge: number,
  dryRun: boolean,
  force: boolean,
): ThumbnailEntry {
  const sourceMtime = mtimeMs(source);
  const thumbMtime = mtimeMs(thumbnail);

  // Skip rule first (it also holds under --dry-run so the plan is accurate).
  if (!force && thumbMtime !== null && sourceMtime !== null && thumbMtime >= sourceMtime) {
    return { source, thumbnail, action: "skipped", detail: "Thumbnail is not older than the source (mtime >= source)" };
  }

  if (dryRun) {
    return { source, thumbnail, action: "planned", detail: `dry-run: would run magick -resize ${edge}x${edge}` };
  }

  const result = run(magickBinary(), [
    source,
    "-resize",
    `${edge}x${edge}`,
    "-strip",
    "-define",
    "png:compression-level=9",
    thumbnail,
  ]);
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || "no output";
    return { source, thumbnail, action: "failed", detail: `magick exited with code ${result.code}: ${detail}` };
  }
  return { source, thumbnail, action: "created" };
}

/**
 * 「生成缩略图」— the *core* of command #2 (no Obsidian imports).
 *
 * Recursively generates `<stem>.thumbnail.png` next to every image under `dir`
 * with `magick <src> -resize <edge>x<edge> -strip … <dst>`. Existing thumbnails
 * that are not older than their source are skipped unless `force` is set. A
 * single failure never aborts the batch.
 */
export async function generateThumbnails(dir: string, opts: ThumbnailOptions = {}): Promise<ThumbnailReport> {
  const rawEdge = opts.edge;
  const edge =
    rawEdge !== undefined && Number.isFinite(rawEdge) && rawEdge > 0
      ? Math.floor(rawEdge)
      : DEFAULT_THUMBNAIL_EDGE;
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const progress = opts.progress;

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`generateThumbnails: not a directory: ${dir}`);
  }

  const sources = listImages(dir);
  const total = sources.length;
  const entries: ThumbnailEntry[] = [];
  let done = 0;

  for (const source of sources) {
    const thumbnail = thumbnailPathFor(source);
    let entry: ThumbnailEntry;
    try {
      entry = generateOne(source, thumbnail, edge, dryRun, force);
    } catch (error) {
      entry = { source, thumbnail, action: "failed", detail: errorSummary(error) };
    }
    entries.push(entry);
    done += 1;
    if (progress !== undefined) {
      progress(`Progress ${done}/${total}: ${path.basename(thumbnail)} ${ACTION_LABEL[entry.action]}`);
    }
  }

  const created = entries.filter((e) => e.action === "created").length;
  const skipped = entries.filter((e) => e.action === "skipped").length;
  const failed = entries.filter((e) => e.action === "failed").length;

  return { dir, edge, entries, created, skipped, failed };
}
