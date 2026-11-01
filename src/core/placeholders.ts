/**
 * `{{name}}` 占位符的解析与替换 —— 元数据预设的 frontmatter / 正文模板与画廊 `.base` 共用。
 *
 * 取不到值的占位符替换成空串，并把名字交还给调用方记进报告 —— 不让一个笔误
 * （`{{fooo}}`）把整批生成弄失败。模板本身坏了（文件不存在、路径越界、
 * `.base` 填完占位符后 YAML 解析不了）才整体停下。
 */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** 整个字符串**恰好**是一个占位符（`{{x}}`）—— frontmatter 里按类型输出标量。 */
export const EXACT_PLACEHOLDER = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/;

/** 模板里出现过的占位符名（去重，按出现顺序）。 */
export function placeholdersOf(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) seen.add(match[1]);
  return [...seen];
}

/** 整个字符串是一个占位符时返回名字，否则 null。 */
export function exactPlaceholder(text: string): string | null {
  const match = EXACT_PLACEHOLDER.exec(text);
  return match === null ? null : match[1];
}

/**
 * 替换占位符。`lookup` 返回 `undefined` ⇒ 换成空串，名字进 `missing`（调用方记进报告）。
 */
export function fillPlaceholders(text: string, lookup: (name: string) => string | undefined): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = lookup(name);
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return value;
  });
  return { text: filled, missing };
}
