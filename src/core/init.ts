import { MergeResult, Progress } from "./types";

export interface InitOptions {
  progress?: Progress;
  /** Defaults to `<root>/.gitattributes`. */
  gitattributesPath?: string;
  /** Defaults to `<root>/.gitignore`. */
  gitignorePath?: string;
  dryRun?: boolean;
}

export interface InitResult {
  root: string;
  createdRepo: boolean;
  initedAnnex: boolean;
  gitattributes: MergeResult;
  gitignore: MergeResult;
  notes: string[];
}

/**
 * 「初始化 gallery」— the *core* of command #1 (no Obsidian imports here, so the
 * CLI can run it too).
 *
 * NOT IMPLEMENTED YET — implemented by the T-002#B-002 worker.
 */
export async function initGallery(root: string, _opts: InitOptions = {}): Promise<InitResult> {
  throw new Error(`initGallery(${root}) is not implemented yet`);
}
