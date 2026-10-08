import { Progress } from "./types";

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

/**
 * 「使用 Annex Gallery 管理」— the *core* of command #3 (no Obsidian imports).
 *
 * NOT IMPLEMENTED YET — implemented by the T-004#B-002 worker.
 */
export async function generateSidecars(dir: string, _opts: SingleSidecarOptions): Promise<SidecarReport> {
  throw new Error(`generateSidecars(${dir}) is not implemented yet`);
}
