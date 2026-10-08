import * as fs from "fs";
import attributesDefault from "../defaults/gitattributes";
import ignoreDefault from "../defaults/gitignore";
import { MergeResult } from "./types";

/** Bundled default `.gitattributes` (byte-identical to the lab repo's live file). */
export const GITATTRIBUTES_TEMPLATE: string = attributesDefault;
/** Bundled default `.gitignore` (only ignores `.obsidian`). */
export const GITIGNORE_TEMPLATE: string = ignoreDefault;

export function templateLines(template: string): string[] {
  return template
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

/** Whitespace-insensitive identity of one rule line. */
export function normalizeRule(line: string): string {
  return line.trim().replace(/[ \t]+/g, " ");
}

export function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Merge semantics: add the rules that are missing, never rewrite or reorder a
 * line the user already wrote. Idempotent — a second run changes no byte.
 */
export function mergeRuleText(
  existing: string | null,
  required: string[],
  file: string,
): { text: string; result: MergeResult } {
  const current = existing ?? "";
  const seen = new Set(current.split(/\r?\n/).map(normalizeRule));
  const added: string[] = [];
  const present: string[] = [];
  for (const rule of required) {
    const key = normalizeRule(rule);
    if (seen.has(key)) {
      present.push(rule);
      continue;
    }
    added.push(rule);
    seen.add(key);
  }
  if (added.length === 0) {
    return { text: current, result: { path: file, added, present, changed: false } };
  }
  let text = current;
  if (text !== "" && !text.endsWith("\n")) text += "\n";
  text += `${added.join("\n")}\n`;
  return { text, result: { path: file, added, present, changed: true } };
}

export function writeIfChanged(file: string, text: string): boolean {
  const before = readIfExists(file);
  if (before === text) return false;
  fs.writeFileSync(file, text, "utf8");
  return true;
}

export function ensureRulesFile(file: string, required: string[]): MergeResult {
  const { text, result } = mergeRuleText(readIfExists(file), required, file);
  if (result.changed) fs.writeFileSync(file, text, "utf8");
  return result;
}
