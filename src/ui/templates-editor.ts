/**
 * 设置页的「模板」区：metadata 模板（sidecar .md）与画廊模板（.base）各一张卡片。
 *
 * - 内置模板（源码里的 `src/defaults/…`）一行一条：「查看」开只读弹窗；「复制为自定义」把原文写进
 *   vault 的 `Annex Gallery Templates/`，并登记成一条自定义模板 —— 改模板就改那份副本。
 * - 自定义模板一行一条：名字 · id · vault 路径 ·「删除」（只取消登记，**不删文件**）。
 * - 最下面一行「登记」：填 vault 相对路径，文件存在且扩展名对（.md / .base）才收。
 *
 * 落盘口径与 remote 设置一致：点了就写 data.json，不设「保存」按钮。
 */
import * as fs from "fs";
import * as path from "path";
import { App, Modal, Notice } from "obsidian";
import { builtinTemplates, type TemplateKind, type TemplateRef } from "../core/templates";
import type { PluginSettings } from "./settings";

export interface TemplatesEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  vaultRoot(): string;
  /** 在 vault 里新建一个文件（路径被占用时自动加后缀），返回实际写入的 vault 相对路径。 */
  createVaultFile(relPath: string, text: string): Promise<string>;
}

/** 复制为自定义时落在哪个文件夹。 */
export const TEMPLATE_FOLDER = "Annex Gallery Templates";

const KIND_TITLE: Record<TemplateKind, string> = { metadata: "metadata 模板", base: "画廊模板" };
const KIND_EXT: Record<TemplateKind, string> = { metadata: ".md", base: ".base" };
const KIND_HINT: Record<TemplateKind, string> = {
  metadata: "生成元数据时 sidecar .md 的整份文本：第一行必须是 {{frontmatter}}，正文可用 {{thumbnail}} / {{tif}} / {{stem}} / {{<任意键>}}。",
  base: "创建画廊时 .base 的模板：可用 {{folder}} / {{cardSize}} / {{properties}}；顶层 filters 由插件加上文件夹 + 标签作用域，模板自己的 filters 只能收窄。",
};

function listOf(settings: PluginSettings, kind: TemplateKind): TemplateRef[] {
  return kind === "metadata" ? settings.metadataTemplates : settings.baseTemplates;
}

/** 文件名 → 模板 id（小写、非字母数字转 -），与已有 id（含内置）去重。 */
export function uniqueTemplateId(base: string, taken: Set<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "template";
  let id = slug;
  for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
  return id;
}

/** 只读查看一份内置模板的原文。 */
class TemplateViewModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly text: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const area = this.contentEl.createEl("textarea", { cls: "annex-template-view" });
    area.value = this.text;
    area.setAttr("readonly", "true");
    area.setAttr("rows", String(Math.min(30, this.text.split("\n").length + 1)));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class TemplatesEditor {
  constructor(
    private readonly container: HTMLElement,
    private readonly host: TemplatesEditorHost,
    private readonly app: App,
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
    for (const builtin of builtinTemplates(kind)) {
      const row = list.createDiv({ cls: "annex-template-row annex-template-builtin" });
      row.setAttr("data-template-id", builtin.id);
      row.createSpan({ cls: "annex-template-name", text: builtin.name });
      row.createSpan({ cls: "annex-template-id", text: `id: ${builtin.id} · 内置` });
      const view = row.createEl("button", { cls: "annex-template-view-btn", text: "查看" });
      view.addEventListener("click", () => new TemplateViewModal(this.app, `${KIND_TITLE[kind]}：${builtin.name}`, builtin.text).open());
      const copy = row.createEl("button", { cls: "annex-template-copy", text: "复制为自定义" });
      copy.addEventListener("click", () => void this.copyBuiltin(kind, builtin.id, builtin.name, builtin.text));
    }

    listOf(this.host.settings, kind).forEach((ref, index) => {
      const row = list.createDiv({ cls: "annex-template-row annex-template-custom" });
      row.setAttr("data-template-id", ref.id);
      row.createSpan({ cls: "annex-template-name", text: ref.name });
      row.createSpan({ cls: "annex-template-id", text: `id: ${ref.id}` });
      row.createSpan({ cls: "annex-template-path", text: ref.path });
      const del = row.createEl("button", { cls: "annex-template-del mod-warning", text: "删除" });
      del.setAttr("aria-label", "取消登记（不删除文件）");
      del.addEventListener("click", () => void this.remove(kind, index));
    });

    const addRow = card.createDiv({ cls: "annex-template-add-row" });
    const input = addRow.createEl("input", { cls: "annex-template-path-input", type: "text" });
    input.setAttr("placeholder", `vault 里的模板文件路径（${KIND_EXT[kind]}）`);
    const add = addRow.createEl("button", { cls: "annex-template-add", text: "登记" });
    add.addEventListener("click", () => void this.register(kind, input.value));
  }

  private takenIds(kind: TemplateKind): Set<string> {
    return new Set([...builtinTemplates(kind).map((entry) => entry.id), ...listOf(this.host.settings, kind).map((entry) => entry.id)]);
  }

  private async register(kind: TemplateKind, raw: string): Promise<void> {
    const rel = raw.trim().replace(/^\/+/, "").split(path.sep).join("/");
    if (rel === "") {
      new Notice("先填模板文件在 vault 里的路径");
      return;
    }
    if (!rel.toLowerCase().endsWith(KIND_EXT[kind])) {
      new Notice(`${KIND_TITLE[kind]}必须是 ${KIND_EXT[kind]} 文件：${rel}`);
      return;
    }
    if (!fs.existsSync(path.join(this.host.vaultRoot(), rel))) {
      new Notice(`vault 里没有这个文件：${rel}`);
      return;
    }
    if (listOf(this.host.settings, kind).some((entry) => entry.path === rel)) {
      new Notice(`已经登记过：${rel}`);
      return;
    }
    const name = path.posix.basename(rel, KIND_EXT[kind]);
    listOf(this.host.settings, kind).push({ id: uniqueTemplateId(name, this.takenIds(kind)), name, path: rel });
    await this.host.saveSettings();
    this.render();
  }

  private async copyBuiltin(kind: TemplateKind, id: string, name: string, text: string): Promise<void> {
    try {
      const written = await this.host.createVaultFile(`${TEMPLATE_FOLDER}/${id}${KIND_EXT[kind]}`, text);
      listOf(this.host.settings, kind).push({
        id: uniqueTemplateId(`${id}-copy`, this.takenIds(kind)),
        name: `${name}（副本）`,
        path: written,
      });
      await this.host.saveSettings();
      new Notice(`已复制到 ${written}，改这份文件即可`);
      this.render();
    } catch (error) {
      new Notice(`复制模板失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  private async remove(kind: TemplateKind, index: number): Promise<void> {
    const list = listOf(this.host.settings, kind);
    if (list[index] === undefined) return;
    list.splice(index, 1);
    await this.host.saveSettings();
    this.render();
  }
}
