/** Progress sink. The plugin passes a Notice/statusbar writer, the CLI a console writer. */
export type Progress = (message: string) => void;

export type ItemAction = "created" | "updated" | "skipped" | "planned" | "failed";

export interface ItemResult {
  /** Absolute path of the file this result is about. */
  path: string;
  action: ItemAction;
  detail?: string;
}

export interface MergeResult {
  path: string;
  /** Lines that were appended by this run. */
  added: string[];
  /** Required lines that were already present (normalized compare). */
  present: string[];
  /** True when the file on disk changed. */
  changed: boolean;
}

export function summarize(items: ItemResult[]): string {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.action] = (counts[item.action] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export function progressPrefix(message: string): string {
  return `[annex-gallery] ${message}`;
}
