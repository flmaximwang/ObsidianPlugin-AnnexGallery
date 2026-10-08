import { App, PluginSettingTab, Setting } from "obsidian";

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
}

export const DEFAULT_SETTINGS: PluginSettings = {
  thumbnailEdge: 256,
  gitattributesPath: "",
  gitignorePath: "",
  defaultSample: "",
  folderSamples: {},
};

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
  }
}
