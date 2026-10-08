import * as fs from "fs";
import * as path from "path";

/** Image extensions the gallery understands (lower-case, leading dot). */
export const IMAGE_EXTENSIONS = [".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".webp"] as const;

/**
 * Derived cover images always end with this suffix. They are *never* treated
 * as source images — enumerating them would make a second run produce
 * `x.thumbnail.thumbnail.png`.
 */
export const THUMBNAIL_SUFFIX = ".thumbnail.png";

export interface StemCollision {
  stem: string;
  count: number;
  files: string[];
}

export interface StemReport {
  dir: string;
  total: number;
  /** Stems used by more than one image (cross-session collisions). */
  collisions: StemCollision[];
}

/** True for a *source* image file: known extension and not a `.thumbnail.png`. */
export function isSourceImage(name: string): boolean {
  if (name.endsWith(THUMBNAIL_SUFFIX)) return false;
  const ext = path.extname(name).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** `stem` of a file path — basename with the final extension removed. */
export function stemOf(file: string): string {
  return path.basename(file, path.extname(file));
}

/**
 * Recursively collect every source image under `dir`, sorted by path.
 * A missing / unreadable directory yields an empty list (never throws).
 */
export function collectImages(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectImages(full));
    else if (entry.isFile() && isSourceImage(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * Duplicate-basename audit (T-004#B-001). Links must be written as full
 * vault paths because microscope stems collide across sessions.
 *
 * Recursively enumerates images (excluding `*.thumbnail.png`), groups by
 * extension-less basename and reports every stem used more than once.
 */
export function duplicateStems(dir: string): StemReport {
  const files = collectImages(dir);
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const stem = stemOf(file);
    const bucket = groups.get(stem);
    if (bucket === undefined) groups.set(stem, [file]);
    else bucket.push(file);
  }
  const collisions: StemCollision[] = [];
  for (const [stem, list] of groups) {
    if (list.length > 1) collisions.push({ stem, count: list.length, files: list });
  }
  collisions.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
  return { dir, total: files.length, collisions };
}
