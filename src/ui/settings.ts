import { App, PluginSettingTab, Setting } from "obsidian";
import type { ProfileFileRef } from "../core/profile-files";
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
  /**
   * 文件名匹配模板：设置里只登记 vault 内的独立 `.json` 文件（每条一个文件，顶层一条
   * `ParseProfile`）。id/name/正则等全部以 JSON 内容为准，所以这里只保存路径。
   *
   * 旧 data.json 的内联 `profiles: ParseProfile[]` **不再是配置来源**，也不会自动迁移；
   * 检测到旧数据时由设置页显示非阻塞提示（见 `detectLegacyInlineProfiles`）。
   */
  profileFiles: ProfileFileRef[];
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
  profileFiles: [],
  folderProfiles: {},
  metadataTemplates: [],
  baseTemplates: [],
  folderMetadataTemplates: {},
  folderBaseTemplates: {},
};

/**
 * 旧 data.json 里内联 profile 数组的键名。仅用于检测与提示，**不是**运行时配置来源。
 */
export const LEGACY_INLINE_PROFILES_KEY = "profiles";

/** 旧内联 profile 的检测结果（供设置页显示非阻塞提示）。 */
export interface LegacyInlineProfilesInfo {
  /** 是否存在非空的内联 `profiles` 数组。 */
  present: boolean;
  /** 旧内联配置的条数（不是数组时为 0）。 */
  count: number;
}

/**
 * 检测旧的内联 `profiles: ParseProfile[]`。
 *
 * T1 不做迁移、不导出、不读取旧配置参与运行时；T2/T3 拿到 `rawData`（`loadData()` 的原始对象）
 * 后调用这个函数，`present === true` 时显示一条可见、非阻塞的失效提示，引导用户把每条 profile
 * 手工保存成独立的 `.json` 并在设置页登记。**绝不能因为检测到旧数据就回退到预设。**
 */
export function detectLegacyInlineProfiles(raw: unknown): LegacyInlineProfilesInfo {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { present: false, count: 0 };
  const value = (raw as Record<string, unknown>)[LEGACY_INLINE_PROFILES_KEY];
  const count = Array.isArray(value) ? value.length : 0;
  return { present: count > 0, count };
}

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
  /**
   * 旧 data.json 内联 `profiles` 的检测结果（由插件从原始 `loadData()` 填充）。
   * 设置页只用它显示「已失效、需要手工登记外部 JSON」的非阻塞提示；不迁移、不读取。
   */
  legacyInlineProfiles: LegacyInlineProfilesInfo;
  /** 扫当前仓库的 remote，把设置里没有的补进来；返回补了几条。 */
  scanVaultRemotes(): Promise<number>;
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

    // 标题：没有说明文字（spec「标题下方无说明」）。
    containerEl.createEl("h1", { cls: "annex-settings-title", text: "Annex Gallery Settings" });

    // 最上方、profile 卡片之前：remote 设置（一个 item 装多条 remote）。
    const remotesSection = containerEl.createDiv({ cls: "annex-remotes-section" });
    new RemotesEditor(remotesSection, this.host).render();

    // remote 设置与模版设置之间也来一条分割线（用户 2026-10-17 追加）。
    containerEl.createEl("hr", { cls: "annex-remotes-divider annex-settings-divider" });

    // 多配置编辑器：路径登记 / 从预设创建 + 每行一条已登记的外部 JSON。
    // ProfileEditor 会清空自己的容器，所以旧配置提示和编辑器各用一个子容器。
    const profilesSection = containerEl.createDiv({ cls: "annex-profiles-section" });
    this.renderLegacyInlineProfilesWarning(profilesSection);
    const profilesEditor = profilesSection.createDiv({ cls: "annex-profiles-editor" });
    new ProfileEditor(profilesEditor, this.host).render();

    // 模板区：metadata 模板 + 画廊模板（登记外部文件 / 从预设创建 / 打开 / 取消登记）。
    const templatesSection = containerEl.createDiv({ cls: "annex-templates-section" });
    new TemplatesEditor(templatesSection, this.host).render();

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

  /**
   * 旧内联 `profiles` 的失效提示：可见、非阻塞，明确「不迁移、不导出、不 fallback」。
   * `legacyInlineProfiles` 由插件在 loadSettings 时从原始 data.json 填入。
   */
  private renderLegacyInlineProfilesWarning(parent: HTMLElement): void {
    const legacy = this.host.legacyInlineProfiles;
    if (legacy === undefined || !legacy.present) return;
    const warning = parent.createDiv({ cls: "annex-legacy-profiles-warning" });
    warning.setAttr("data-count", String(legacy.count));
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-title",
      text: "旧版内联文件名匹配模板已不再生效",
    });
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-body",
      text:
        `data.json 里还有 ${legacy.count} 条内联 profiles。本版本不会读取、不会自动迁移，也不会回退到预设。` +
        "请把每条配置分别保存成 vault 里的一个 .json 文件，然后在下面逐条「登记」。",
    });
  }
}
