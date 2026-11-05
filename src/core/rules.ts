import * as fs from "fs";
import attributesDefault from "../defaults/gitattributes";
import ignoreDefault from "../defaults/gitignore";
import { MergeResult } from "./types";

/** Bundled default `.gitattributes` (the Concepts vault's live file + the `*.thumbnail.png` rule). */
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
 *
 * When the target is missing / blank and `template` is given, the template is
 * written verbatim instead: line-merging would collapse its repeated comment
 * separators and drop its blank lines. `added` still lists every non-blank line.
 */
export function mergeRuleText(
  existing: string | null,
  required: string[],
  file: string,
  template?: string,
): { text: string; result: MergeResult } {
  const current = existing ?? "";
  if (template !== undefined && current.trim() === "" && required.length > 0) {
    const text = template.endsWith("\n") ? template : `${template}\n`;
    return { text, result: { path: file, added: [...required], present: [], changed: true } };
  }
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

export function ensureRulesFile(file: string, required: string[], template?: string): MergeResult {
  const { text, result } = mergeRuleText(readIfExists(file), required, file, template);
  if (result.changed) fs.writeFileSync(file, text, "utf8");
  return result;
}
