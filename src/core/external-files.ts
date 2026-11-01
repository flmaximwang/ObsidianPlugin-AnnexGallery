/**
 * 三类外部模板（元数据预设 `.json` / 正文 `.md` / 画廊 `.base`）共用的
 * vault 相对路径校验与同步读取。
 *
 * 硬规则（见 issue 774d7ee 的冻结 spec）：
 * - 只接受 vault 内的相对路径；绝对路径、盘符路径、任何 `..` 段一律拒绝。
 *   不同平台的分隔符（`\` / `/`）先统一成正斜杠再检查，不能靠写法绕过。
 * - 扩展名必须与模板类型匹配（大小写不敏感）。
 * - 每次真正使用前都重新做路径检查、存在性检查并重新读盘 —— 外部保存后的修改直接生效，
 *   也保证「打开」/生成时文件被删掉能立刻看到明确错误。
 *
 * 这里的函数不 import obsidian，CLI 与插件共用；读文件用 Node `fs`（桌面版插件有本地路径）。
 */
import * as fs from "fs";
import * as path from "path";

/** 外部模板文件的三种类型。 */
export type ExternalFileKind = "profile" | "metadata" | "base";

const KIND_LABEL: Record<ExternalFileKind, string> = {
  profile: "元数据预设",
  metadata: "正文模板",
  base: "画廊模板",
};

const KIND_EXTENSION: Record<ExternalFileKind, string> = {
  profile: ".json",
  metadata: ".md",
  base: ".base",
};

export interface ExternalTextFile {
  /** vault 相对路径，正斜杠、已规范化。 */
  relPath: string;
  /** 本地绝对路径（用于「用系统默认应用打开」）。 */
  absPath: string;
  /** 文件原文（不做 BOM 处理；JSON loader 自己剥 BOM）。 */
  text: string;
}

/** 模板类型对应的扩展名（含点号、小写），例如 `.json`。 */
export function externalFileExtension(kind: ExternalFileKind): string {
  return KIND_EXTENSION[kind];
}

/** 报错文案里用的中文类型名，例如「metadata 模板」。 */
export function externalFileKindLabel(kind: ExternalFileKind): string {
  return KIND_LABEL[kind];
}

/**
 * 把用户输入的路径规范化成 vault 相对路径（正斜杠）。
 * 不安全（绝对路径 / 盘符 / `..` 段）或为空 ⇒ 抛中文错误，错误里带原始输入。
 *
 * 这里**不看扩展名**，也不碰磁盘 —— 需要时用 `validateVaultRelPath` /
 * `resolveVaultFile` / `readVaultTextFile`。
 */
export function normalizeVaultRelPath(raw: string): string {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (input === "") throw new Error("模板路径不能为空");
  if (input.includes("\0")) throw new Error(`模板路径包含非法字符：${input}`);

  // Windows 用户会粘贴 `a\b` 或 `C:\a`；统一成正斜杠后再做全部检查。
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/")) {
    throw new Error(`模板路径必须是 vault 内的相对路径（不接受绝对路径）：${input}`);
  }
  if (/^[A-Za-z]:/.test(unified)) {
    throw new Error(`模板路径必须是 vault 内的相对路径（不接受盘符路径）：${input}`);
  }

  const parts = unified.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`模板路径不能包含 ..（会跑出 vault）：${input}`);
  }
  const cleaned = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (cleaned === "") throw new Error(`模板路径无效：${input}`);
  return cleaned;
}

/**
 * 规范化并检查扩展名；返回正斜杠的相对路径。
 * `kind` 决定允许的扩展名（profile 只能 `.json`，metadata 只能 `.md`，base 只能 `.base`）。
 */
export function validateVaultRelPath(raw: string, kind: ExternalFileKind): string {
  const relPath = normalizeVaultRelPath(raw);
  const ext = KIND_EXTENSION[kind];
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (base === ext || !base.endsWith(ext)) {
    throw new Error(`${KIND_LABEL[kind]}必须是 ${ext} 文件：${relPath}`);
  }
  return relPath;
}

/**
 * 路径校验 + 存在性检查（每次调用都重新检查磁盘）。返回用于打开/读取的绝对路径。
 * 目录或其它非普通文件也按「不存在」处理，避免把目录当模板读。
 */
export function resolveVaultFile(vaultRoot: string, raw: string, kind: ExternalFileKind): { relPath: string; absPath: string } {
  const relPath = validateVaultRelPath(raw, kind);
  const absPath = path.resolve(vaultRoot, relPath);
  // 再核一次没有跑出 vault（防御未来 normalize 逻辑改动 / 平台差异）。
  const back = path.relative(vaultRoot, absPath);
  if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`${KIND_LABEL[kind]}路径必须是 vault 内的相对路径：${raw}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new Error(`${KIND_LABEL[kind]}文件不存在：${relPath}`);
  }
  if (!stat.isFile()) throw new Error(`${KIND_LABEL[kind]}路径不是文件：${relPath}`);
  return { relPath, absPath };
}

/**
 * 校验路径与存在性并同步读入整份文本。每次操作都应该重新调用 —— 外部文件改了立即生效。
 * 读失败 ⇒ 抛中文错误，带相对路径与底层原因。
 */
export function readVaultTextFile(vaultRoot: string, raw: string, kind: ExternalFileKind): ExternalTextFile {
  const { relPath, absPath } = resolveVaultFile(vaultRoot, raw, kind);
  try {
    return { relPath, absPath, text: fs.readFileSync(absPath, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${KIND_LABEL[kind]}文件读不了：${relPath}（${message}）`);
  }
}
