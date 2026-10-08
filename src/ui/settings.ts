import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PROFILES, type ParseProfile } from "../core/profiles";
import { ProfileEditor, cloneProfile, cloneProfiles } from "./profile-editor";

export { cloneProfile, cloneProfiles };

export interface PluginSettings {
  /** Thumbnail edge length in px — keep equal to `.base`'s `cardSize`. */
  thumbnailEdge: number;
  /** `.gitattributes` to merge into; empty = `<vault>/.gitattributes`. */
  gitattributesPath: string;
  /** `.gitignore` to merge into; empty = `<vault>/.gitignore`. */
  gitignorePath: string;
  /** Last used sample name for command #3 («使用 Annex Gallery 管理»). */
  defaultSample: string;
  /** Remembered sample per image folder (absolute path). */
  folderSamples: Record<string, string>;
  /** T-008: metadata 解析配置，一条 profile = 一条正则 + 具名捕获组到键的映射。 */
  profiles: ParseProfile[];
  /** 文件夹绝对路径 → 选中的 profile id（右键弹窗记住上次选择）。 */
  folderProfiles: Record<string, string>;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  thumbnailEdge: 256,
  gitattributesPath: "",
  gitignorePath: "",
  defaultSample: "",
  folderSamples: {},
  // 深拷贝：DEFAULT_SETTINGS 是模块级常量，绝不能被编辑操作就地改到。
  profiles: cloneProfiles(DEFAULT_PROFILES),
  folderProfiles: {},
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
export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  vaultRoot(): string;
}

export class AnnexGallerySettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, host: SettingsHost) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(app, host as any);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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

    new Setting(containerEl)
      .setName(".gitattributes 路径")
      .setDesc(`留空 = <vault>/.gitattributes（当前 ${this.host.vaultRoot()}/.gitattributes）。写入是合并：只补缺失的规则。`)
      .addText((text) =>
        text
          .setPlaceholder(`${this.host.vaultRoot()}/.gitattributes`)
          .setValue(this.host.settings.gitattributesPath)
          .onChange(async (value) => {
            this.host.settings.gitattributesPath = value.trim();
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(".gitignore 路径")
      .setDesc("留空 = <vault>/.gitignore。默认只忽略 .obsidian。")
      .addText((text) =>
        text
          .setPlaceholder(`${this.host.vaultRoot()}/.gitignore`)
          .setValue(this.host.settings.gitignorePath)
          .onChange(async (value) => {
            this.host.settings.gitignorePath = value.trim();
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("默认样品名")
      .setDesc("生成 sidecar .md 时写入 sample 字段的默认值；按文件夹记住上一次用过的名字。")
      .addText((text) =>
        text.setValue(this.host.settings.defaultSample).onChange(async (value) => {
          this.host.settings.defaultSample = value.trim();
          await this.host.saveSettings();
        }),
      );

    // 多配置（profile）编辑器：单独一块容器，编辑器重渲染不会碰到上面的设置项。
    const profilesSection = containerEl.createDiv({ cls: "annex-profiles-section" });
    new ProfileEditor(profilesSection, this.host).render();
  }
}
