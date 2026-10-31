/**
 * 设置页的「模板」区：metadata 模板（sidecar `.md`）与画廊模板（`.base`）
 * —— spec-774d7ee / ticket 2133603。
 *
 * 冻结口径：
 * - 运行时唯一事实来源是 vault 里的外部文件；设置里登记 `{ id, name, path }`。
 *   预设（`presetTemplates()` 返回的 `src/defaults/…` 原文）只作为「从预设创建」的素材，
 *   **不再作为可用模板行列出**，也没有「查看」「复制为自定义」这些内置条目交互。
 * - 每行显示 名称 / id / 路径，并提供「打开」「删除」；删除只取消登记，不删文件。
 * - 「从预设创建」每次都写一个独立文件到 `AnnexGalleryTemplates/<preset-id>.<ext>`
 *   （文件夹无空格）；路径冲突由 `createVaultFile` 加序号（不覆盖），创建后不自动打开。
 * - 逐行独立检查路径/存在性：坏条目仍显示路径和错误，也仍可「打开」去修复。
 */
import { Notice } from "obsidian";
import { normalizeVaultRelPath, resolveVaultFile } from "../core/external-files";
import { presetTemplates, type TemplateKind, type TemplatePreset, type TemplateRef } from "../core/templates";
import type { PluginSettings } from "./settings";

export interface TemplatesEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  vaultRoot(): string;
  /** 在 vault 里新建一个文件（路径被占用时自动加后缀），返回实际写入的 vault 相对路径。 */
  createVaultFile(relPath: string, text: string): Promise<string>;
  /** 用系统默认外部应用打开一个本地绝对路径；失败时 throw。 */
  openWithDefaultApp(filePath: string): Promise<void>;
}

/** 从预设创建时落在哪个文件夹（spec 要求无空格）。 */
export const TEMPLATE_FOLDER = "AnnexGalleryTemplates";

const KIND_TITLE: Record<TemplateKind, string> = { metadata: "metadata 模板", base: "画廊模板" };
const KIND_EXT: Record<TemplateKind, string> = { metadata: ".md", base: ".base" };
const KIND_HINT: Record<TemplateKind, string> = {
  metadata: "生成元数据时 sidecar .md 的整份文本：第一行必须是 {{frontmatter}}，正文可用 {{thumbnail}} / {{tif}} / {{stem}} / {{<任意键>}}。",
  base: "创建画廊时 .base 的模板：可用 {{folder}} / {{cardSize}} / {{properties}}；顶层 filters 由插件加上文件夹 + 标签作用域，模板自己的 filters 只能收窄。",
};

function listOf(settings: PluginSettings, kind: TemplateKind): TemplateRef[] {
  return kind === "metadata" ? settings.metadataTemplates : settings.baseTemplates;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 路径规范化；非法路径（越界/绝对路径）返回 null，仅用于重复比较的尽力而为。 */
function normalizedOrNull(raw: string): string | null {
  try {
    return normalizeVaultRelPath(raw);
  } catch {
    return null;
  }
}

/** 文件名 → 模板 id（小写、非字母数字转 -），与已有 id 去重。 */
export function uniqueTemplateId(base: string, taken: Set<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "template";
  let id = slug;
  for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
  return id;
}

/** 文件路径 → 去掉类型扩展名后的名字（扩展名大小写不敏感）。 */
function stemOfPath(relPath: string, kind: TemplateKind): string {
  const file = relPath.slice(relPath.lastIndexOf("/") + 1);
  const ext = KIND_EXT[kind];
  return file.toLowerCase().endsWith(ext) ? file.slice(0, -ext.length) : file;
}

export class TemplatesEditor {
  constructor(
    private readonly container: HTMLElement,
    private readonly host: TemplatesEditorHost,
  ) {}

  render(): void {
    this.container.empty();
    this.renderKind("metadata");
    this.renderKind("base");
  }

  private renderKind(kind: TemplateKind): void {
    const card = this.container.createDiv({ cls: "annex-templates-card" });
    card.setAttr("data-kind", kind);
    card.createEl("h3", { cls: "annex-templates-title", text: KIND_TITLE[kind] });
    card.createDiv({ cls: "annex-templates-hint", text: KIND_HINT[kind] });

    const list = card.createDiv({ cls: "annex-template-list" });
    const refs = listOf(this.host.settings, kind);
    if (refs.length === 0) {
      list.createDiv({
        cls: "annex-templates-empty",
        text: "还没有登记模板。填 vault 里的文件路径点「登记」，或用「从预设创建…」生成一份。",
      });
    }

    refs.forEach((ref, index) => this.renderRow(list, kind, ref, index));

    const addRow = card.createDiv({ cls: "annex-template-add-row" });
    const input = addRow.createEl("input", { cls: "annex-template-path-input", type: "text" });
    input.setAttr("placeholder", `vault 里的模板文件路径（${KIND_EXT[kind]}）`);
    const add = addRow.createEl("button", { cls: "annex-template-add", text: "登记" });
    const submit = (): void => void this.register(kind, input.value);
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    const presetSelect = addRow.createEl("select", { cls: "dropdown annex-template-preset" });
    presetSelect.createEl("option", { text: "从预设创建…", value: "" });
    for (const preset of presetTemplates(kind)) {
      presetSelect.createEl("option", { text: `${preset.name}（${preset.id}）`, value: preset.id });
    }
    presetSelect.addEventListener("change", () => {
      const chosen = presetTemplates(kind).find((preset) => preset.id === presetSelect.value);
      presetSelect.value = "";
      if (chosen !== undefined) void this.createFromPreset(kind, chosen);
    });
  }

  private renderRow(parent: HTMLElement, kind: TemplateKind, ref: TemplateRef, index: number): void {
    const row = parent.createDiv({ cls: "annex-template-row annex-template-custom" });
    row.setAttr("data-template-id", ref.id);
    row.setAttr("data-template-path", ref.path);
    row.setAttr("data-state", "ok");

    row.createSpan({ cls: "annex-template-name", text: ref.name.trim() === "" ? "（未命名）" : ref.name });
    row.createSpan({ cls: "annex-template-id", text: `id: ${ref.id}` });
    row.createSpan({ cls: "annex-template-path", text: ref.path });

    let problem = "";
    try {
      resolveVaultFile(this.host.vaultRoot(), ref.path, kind);
    } catch (error) {
      problem = errText(error);
      row.setAttr("data-state", "error");
      row.addClass("annex-template-row-error");
    }

    const open = row.createEl("button", { cls: "annex-template-open", text: "打开" });
    open.setAttr("aria-label", "用系统默认应用打开这份模板（改完保存即生效）");
    open.addEventListener("click", () => void this.open(kind, ref));

    const del = row.createEl("button", { cls: "annex-template-del mod-warning", text: "删除" });
    del.setAttr("aria-label", "取消登记（不删除文件）");
    del.addEventListener("click", () => void this.remove(kind, index));

    if (problem !== "") row.createDiv({ cls: "annex-template-error", text: problem });
  }

  private takenIds(kind: TemplateKind): Set<string> {
    return new Set(listOf(this.host.settings, kind).map((entry) => entry.id));
  }

  /** 登记已有文件：路径安全 + 扩展名 + 存在性 + 重复路径。 */
  private async register(kind: TemplateKind, raw: string): Promise<void> {
    let relPath: string;
    try {
      relPath = resolveVaultFile(this.host.vaultRoot(), raw, kind).relPath;
    } catch (error) {
      new Notice(`登记失败：${errText(error)}`, 10000);
      return;
    }

    const list = listOf(this.host.settings, kind);
    if (list.some((ref) => ref.path === relPath || normalizedOrNull(ref.path) === relPath)) {
      new Notice(`这个文件已经登记过：${relPath}`);
      return;
    }

    const name = stemOfPath(relPath, kind);
    list.push({ id: uniqueTemplateId(name, this.takenIds(kind)), name, path: relPath });
    await this.host.saveSettings();
    this.render();
    new Notice(`已登记：${relPath}`);
  }

  /** 从预设创建一份独立文件：一个预设一个文件，冲突加序号不覆盖，创建后不自动打开。 */
  private async createFromPreset(kind: TemplateKind, preset: TemplatePreset): Promise<void> {
    try {
      const target = `${TEMPLATE_FOLDER}/${preset.id}${KIND_EXT[kind]}`;
      const written = await this.host.createVaultFile(target, preset.text);
      const name = stemOfPath(written, kind);
      listOf(this.host.settings, kind).push({
        id: uniqueTemplateId(name === "" ? preset.id : name, this.takenIds(kind)),
        name: written === target ? preset.name : `${preset.name}（副本）`,
        path: written,
      });
      await this.host.saveSettings();
      this.render();
      new Notice(`已从预设创建：${written}`);
    } catch (error) {
      new Notice(`从预设创建失败：${errText(error)}`, 12000);
    }
  }

  /** 用系统默认应用打开登记的文件；打开前重新做路径/存在性检查，失败绝不自动创建。 */
  private async open(kind: TemplateKind, ref: TemplateRef): Promise<void> {
    try {
      const file = resolveVaultFile(this.host.vaultRoot(), ref.path, kind);
      await this.host.openWithDefaultApp(file.absPath);
    } catch (error) {
      new Notice(`打不开「${ref.path}」：${errText(error)}`, 12000);
    }
  }

  /** 删除只取消登记，文件保留。 */
  private async remove(kind: TemplateKind, index: number): Promise<void> {
    const list = listOf(this.host.settings, kind);
    const target = list[index];
    if (target === undefined) return;
    list.splice(index, 1);
    await this.host.saveSettings();
    this.render();
    new Notice(`已取消登记（文件未删除）：${target.path}`);
  }
}
