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

/**
 * 「生成缩略图」— the *core* of command #2 (no Obsidian imports).
 *
 * NOT IMPLEMENTED YET — implemented by the T-003#B-002 worker.
 */
export async function generateThumbnails(dir: string, _opts: ThumbnailOptions = {}): Promise<ThumbnailReport> {
  throw new Error(`generateThumbnails(${dir}) is not implemented yet`);
}
