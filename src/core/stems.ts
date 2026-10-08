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

/**
 * Duplicate-basename audit (T-004#B-001). Links must be written as full
 * vault paths because microscope stems collide across sessions.
 *
 * NOT IMPLEMENTED YET — implemented by the T-004#B-001 worker.
 */
export function duplicateStems(dir: string): StemReport {
  throw new Error(`duplicateStems(${dir}) is not implemented yet`);
}
