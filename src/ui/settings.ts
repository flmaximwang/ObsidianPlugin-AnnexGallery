import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PROFILES, type ParseProfile } from "../core/profiles";
import type { RemoteEntry } from "../core/remotes";
import type { TemplateRef } from "../core/templates";
import { ProfileEditor, cloneProfile, cloneProfiles, type ProfileEditorHost } from "./profile-editor";
import { RemotesEditor } from "./remotes-editor";
import { TemplatesEditor, type TemplatesEditorHost } from "./templates-editor";

export { cloneProfile, cloneProfiles };

/**
 * 落进 data.json 的设置。
 *
 * 按 docs/setting-panel.md：`.gitattributes` / `.gitignore` 用内置默认即可（不再暴露路径），
 * 也没有「默认样品名」这种东西 —— 每次生成 metadata 都在弹窗里填样品名（按文件夹记住上次的值）。
 */
export interface PluginSettings {
  /** Thumbnail edge length in px — keep equal to `.base`'s `cardSize`. */
  thumbnailEdge: number;
  /** 「remote 设置」：可以有多条，一条 = 名称 + 地址；「初始化 gallery」时逐个 git remote add/set-url。 */
  remotes: RemoteEntry[];
  /** 按文件夹记住的现场填写值（`sample` 用目录本身当键，兼容旧 data.json）。 */
  folderSamples: Record<string, string>;
  /** T-008: metadata 解析配置，一条 profile = 一条正则 + 具名捕获组到键的映射。 */
  profiles: ParseProfile[];
  /** 文件夹绝对路径 → 选中的 profile id（右键弹窗记住上次选择）。 */
  folderProfiles: Record<string, string>;
  /** 自定义 metadata 模板（vault 里的 .md；内置的不在这里，见 src/core/templates.ts）。 */
  metadataTemplates: TemplateRef[];
  /** 自定义画廊模板（vault 里的 .base）。 */
  baseTemplates: TemplateRef[];
  /** 文件夹绝对路径 → 「生成元数据」上次选的 metadata 模板 id。 */
  folderMetadataTemplates: Record<string, string>;
  /** 文件夹绝对路径 → 「创建画廊」上次选的画廊模板 id。 */
  folderBaseTemplates: Record<string, string>;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  thumbnailEdge: 256,
  remotes: [],
  folderSamples: {},
  // 深拷贝：DEFAULT_SETTINGS 是模块级常量，绝不能被编辑操作就地改到。
  profiles: cloneProfiles(DEFAULT_PROFILES),
  folderProfiles: {},
  metadataTemplates: [],
  baseTemplates: [],
  folderMetadataTemplates: {},
  folderBaseTemplates: {},
};

/**
 * ask 值的落盘位置：`sample` 沿用 `folderSamples[目录]`（与旧 data.json 兼容），
 * 其它 ask 键用 `<目录>\u0001<键>` 这个复合键，避免给 folderSamples 多加一层。
 */
export function askStorageKey(folderDir: string, key: string): string {
  return key === "sample" ? folderDir : `${folderDir}\u0001${key}`;
}

export function readAsk(settings: PluginSettings, folderDir: string, key: string): string {
  const stored = settings.folderSamples[askStorageKey(folderDir, key)];
  if (stored !== undefined) return stored;
  // 兼容：老 data.json 只写了 folderSamples[目录]，键就是 sample。
  return key === "sample" ? settings.folderSamples[folderDir] ?? "" : "";
}

export function writeAsk(settings: PluginSettings, folderDir: string, key: string, value: string): void {
  settings.folderSamples[askStorageKey(folderDir, key)] = value;
}

/** What the settings tab needs from the plugin (breaks the import cycle). */
export interface SettingsHost extends ProfileEditorHost, TemplatesEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  vaultRoot(): string;
  /** 扫当前仓库的 remote，把设置里没有的补进来；返回补了几条。 */
  scanVaultRemotes(): Promise<number>;
}

export class AnnexGallerySettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  private editor: ProfileEditor | null = null;

  constructor(app: App, host: SettingsHost) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(app, host as any);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    this.editor?.destroy();
    containerEl.empty();

    // 标题：没有说明文字（spec「标题下方无说明」）。
    containerEl.createEl("h1", { cls: "annex-settings-title", text: "Annex Gallery Settings" });

    // 最上方、profile 卡片之前：remote 设置（一个 item 装多条 remote）。
    const remotesSection = containerEl.createDiv({ cls: "annex-remotes-section" });
    new RemotesEditor(remotesSection, this.host).render();

    // remote 设置与模版设置之间也来一条分割线（用户 2026-10-17 追加）。
    containerEl.createEl("hr", { cls: "annex-remotes-divider annex-settings-divider" });

    // 多配置编辑器：工具条（新模版 / 导入模版 / 添加预设）+ 每张卡片。
    const profilesSection = containerEl.createDiv({ cls: "annex-profiles-section" });
    this.editor = new ProfileEditor(profilesSection, this.host);
    this.editor.render();

    // 模板区：metadata 模板 + 画廊模板（内置只读、可复制；自定义 = vault 里登记的文件）。
    const templatesSection = containerEl.createDiv({ cls: "annex-templates-section" });
    new TemplatesEditor(templatesSection, this.host, this.app).render();

    // 分割线以下才是剩下的普通设置项（spec 只留「缩略图边长」）。
    containerEl.createEl("hr", { cls: "annex-settings-divider" });

    new Setting(containerEl)
      .setName("缩略图边长")
      .setDesc("生成 .thumbnail.png 时的边长（px）。建议与 .base 的 cardSize 保持一致，默认 256。")
      .addText((text) =>
        text.setValue(String(this.host.settings.thumbnailEdge)).onChange(async (value) => {
          const edge = Number.parseInt(value, 10);
          this.host.settings.thumbnailEdge = Number.isFinite(edge) && edge > 0 ? edge : DEFAULT_SETTINGS.thumbnailEdge;
          await this.host.saveSettings();
        }),
      );

    // 每次打开设置页也扫一遍仓库里的 remote（在 Obsidian 外面加过 remote 时能立刻看到）；
    // 只有真的补进了新条目才重渲染，避免无限循环。
    void this.host
      .scanVaultRemotes()
      .then((added) => {
        if (added > 0) this.display();
      })
      .catch((error) => console.error(error));
  }

  /** 设置页关掉/切走时收摊（外部编辑的轮询定时器）。 */
  hide(): void {
    this.editor?.destroy();
    this.editor = null;
  }
}
