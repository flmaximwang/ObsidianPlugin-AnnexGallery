import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionControl, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";
import type { ProfileFileRef } from "../core/profile-files";
import type { TemplateRef } from "../core/templates";
import { ProfileEditor, type ProfileEditorHost } from "./profile-editor";
import { RemotesEditor } from "./remotes-editor";
import { TemplatesEditor, type TemplatesEditorHost } from "./templates-editor";

/**
 * 落进 data.json 的设置。
 *
 * 按 docs/setting-panel.md：`.gitattributes` / `.gitignore` 用内置默认即可（不再暴露路径），
 * 也没有「默认样品名」这种东西 —— 每次生成 metadata 都在弹窗里填样品名（按文件夹记住上次的值）。
 */
export interface PluginSettings {
  /** Thumbnail edge length in px — keep equal to `.base`'s `cardSize`. */
  thumbnailEdge: number;
  /** 按文件夹记住的现场填写值（`sample` 用目录本身当键，兼容旧 data.json）。 */
  folderSamples: Record<string, string>;
  /**
   * 元数据预设：设置里只登记 vault 内的独立 `.json` 文件（每条一个文件，顶层一条
   * `ParseProfile`）。id/name/frontmatter 等全部以 JSON 内容为准，所以这里只保存路径。
   *
   * 旧 data.json 的内联 `profiles: ParseProfile[]` **不再是配置来源**，也不会自动迁移；
   * 检测到旧数据时由设置页显示非阻塞提示（见 `detectLegacyInlineProfiles`）。
   */
  profileFiles: ProfileFileRef[];
  /** 文件夹绝对路径 → 选中的元数据预设 id（右键弹窗记住上次选择）。 */
  folderProfiles: Record<string, string>;
  /** 自定义画廊模板（vault 里的 .base）。 */
  baseTemplates: TemplateRef[];
  /** 文件夹绝对路径 → 「创建画廊」上次选的画廊模板 id。 */
  folderBaseTemplates: Record<string, string>;
  /** 把 git / git-annex 的进度写进开发者控制台；默认关闭（社区插件审核要求默认只显示错误）。 */
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  thumbnailEdge: 256,
  folderSamples: {},
  profileFiles: [],
  folderProfiles: {},
  baseTemplates: [],
  folderBaseTemplates: {},
  debugLogging: false,
};

/**
 * 旧 data.json 里内联 profile 数组的键名。仅用于检测与提示，**不是**运行时配置来源。
 */
export const LEGACY_INLINE_PROFILES_KEY = "profiles";

/**
 * 旧 data.json 里「metadata 模板登记表」的键名。
 *
 * 2.0 及更早版本把 sidecar 正文模板单独登记在 `metadataTemplates` 里；现在正文由每条
 * 元数据预设自己的 `template` 字段指向 vault `.md`，这份登记表**不再被读取**，也不会自动迁移。
 */
export const LEGACY_METADATA_TEMPLATES_KEY = "metadataTemplates";

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

/** 旧「metadata 模板登记表」的检测结果（供设置页显示非阻塞提示）。 */
export interface LegacyMetadataTemplatesInfo {
  /** 是否存在非空的 `metadataTemplates` 数组。 */
  present: boolean;
  /** 旧登记的条数（不是数组时为 0）。 */
  count: number;
}

/**
 * 检测旧 data.json 里的 `metadataTemplates: TemplateRef[]`。
 *
 * 这份登记表已经不用了（正文改由元数据预设的 `template` 字段指向 vault `.md`），
 * 但**不迁移、也不删除** data.json 里的旧键 —— 只在设置页显示一条可见、非阻塞的提示，
 * 引导用户从「从预设创建」重新生成。正文内容不会因此丢失：旧正文文件仍在 vault 里。
 */
export function detectLegacyMetadataTemplates(raw: unknown): LegacyMetadataTemplatesInfo {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { present: false, count: 0 };
  const value = (raw as Record<string, unknown>)[LEGACY_METADATA_TEMPLATES_KEY];
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
  /**
   * 旧 data.json 的 `metadataTemplates`（metadata 模板登记表）的检测结果。
   * 同样只用于显示非阻塞提示；旧键原样留在 data.json 里，不迁移、不删除。
   */
  legacyMetadataTemplates: LegacyMetadataTemplatesInfo;
}

export class AnnexGallerySettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  /**
   * Obsidian 1.13+ 的声明式设置页：整页由定义生成，`display()` 不再被调用。
   *
   * 顺序与旧版一致：remote 编辑器 → 元数据预设（旧数据提示 + ProfileEditor）→
   * 画廊模板区（TemplatesEditor）→ 两个普通设置项。两条 `<hr>` 分割线换成 group 的 heading；
   * 三个编辑器用 render 项挂载（name/desc 只用于设置搜索，编辑器自带卡片标题）。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        // 没有 heading：RemotesEditor 卡片自带「Remotes」标题，避免重复。
        type: "group",
        cls: "annex-editors-group",
        items: [this.remotesDefinition()],
      },
      {
        type: "group",
        heading: "Metadata presets and gallery templates",
        cls: "annex-editors-group",
        items: [this.profilesDefinition(), this.templatesDefinition()],
      },
      {
        type: "group",
        heading: "General",
        items: [this.thumbnailEdgeDefinition(), this.debugLoggingDefinition()],
      },
    ];
  }

  /**
   * 默认实现写 `this.plugin.settings` 后直接 `plugin.saveData()`；这里统一走
   * `host.saveSettings()`，并保证「缩略图边长」读出来一定是合法正整数。
   */
  getControlValue(key: string): unknown {
    if (key === "thumbnailEdge") {
      const edge = this.host.settings.thumbnailEdge;
      return Number.isInteger(edge) && edge > 0 ? edge : DEFAULT_SETTINGS.thumbnailEdge;
    }
    if (key === "debugLogging") return this.host.settings.debugLogging;
    return undefined;
  }

  /** 覆写持久化路径：先落到 `host.settings`，再走插件自己的 `saveSettings()`。 */
  setControlValue(key: string, value: unknown): void | Promise<void> {
    if (key === "thumbnailEdge") {
      const edge = typeof value === "number" ? value : Number.parseInt(String(value), 10);
      this.host.settings.thumbnailEdge =
        Number.isInteger(edge) && edge > 0 ? edge : DEFAULT_SETTINGS.thumbnailEdge;
      return this.host.saveSettings();
    }
    if (key === "debugLogging") {
      this.host.settings.debugLogging = Boolean(value);
      return this.host.saveSettings();
    }
    return undefined;
  }

  private remotesDefinition(): SettingDefinitionRender {
    return {
      name: "Remotes",
      desc: "Read from .git/config and written back only when you save. Only remote configuration is changed — nothing is fetched or pushed.",
      render: (setting) => {
        const container = this.mountEditor(setting, "annex-remotes-section");
        // The editor rebuilds only its own card, so the other editors keep their input.
        new RemotesEditor(container, {
          app: this.app,
          vaultRoot: () => this.host.vaultRoot(),
        }).render();
      },
    };
  }

  private profilesDefinition(): SettingDefinitionRender {
    return {
      name: "Metadata presets",
      desc: "Each metadata preset is a .json file in the vault (frontmatter and an optional body template live inside); register its path here, or create one from a preset.",
      render: (setting) => {
        // ProfileEditor 会清空自己的容器，所以旧配置提示和编辑器各用一个子容器。
        const container = this.mountEditor(setting, "annex-profiles-section");
        this.renderLegacyInlineProfilesWarning(container);
        this.renderLegacyMetadataTemplatesWarning(container);
        const editor = container.createDiv({ cls: "annex-profiles-editor" });
        new ProfileEditor(editor, this.host).render();
      },
    };
  }

  private templatesDefinition(): SettingDefinitionRender {
    return {
      name: "Gallery templates",
      desc: "Gallery templates are .base files in the vault; register one here or create one from a preset.",
      render: (setting) => {
        const container = this.mountEditor(setting, "annex-templates-section");
        new TemplatesEditor(container, this.host).render();
      },
    };
  }

  private thumbnailEdgeDefinition(): SettingDefinitionControl<"thumbnailEdge"> {
    return {
      name: "Thumbnail edge",
      desc: "Edge length in pixels for generated .thumbnail.png files. Keeping it equal to the .base cardSize is recommended; default 256.",
      control: {
        type: "number",
        key: "thumbnailEdge",
        defaultValue: DEFAULT_SETTINGS.thumbnailEdge,
        min: 1,
        step: 1,
        validate: (value) => (Number.isInteger(value) && value > 0 ? undefined : "Enter a positive integer (px)"),
      },
    };
  }

  private debugLoggingDefinition(): SettingDefinitionControl<"debugLogging"> {
    return {
      name: "Debug logging",
      desc: "Write git / git-annex progress to the developer console. Off by default.",
      control: {
        type: "toggle",
        key: "debugLogging",
        defaultValue: DEFAULT_SETTINGS.debugLogging,
      },
    };
  }

  /**
   * render 项挂到框架给的 `.setting-item-control`：框架在每次重渲染前会 `Setting.clear()`
   * 清空这个容器，不会叠加旧卡片；`settingEl` 则要留给框架的 name/desc。
   */
  private mountEditor(setting: Setting, cls: string): HTMLElement {
    setting.settingEl.addClass("annex-editor-row");
    return setting.controlEl.createDiv({ cls });
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
      text: "Legacy inline metadata presets are no longer active",
    });
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-body",
      text:
        `data.json still contains ${legacy.count} inline profiles. This version does not read or migrate them, and does not fall back to presets.` +
        "Save each configuration as its own .json file in the vault, then register them one by one below.",
    });
  }

  /**
   * 旧「metadata 模板登记表」（`metadataTemplates`）的失效提示：可见、非阻塞。
   *
   * 正文模板不再单独登记 —— 它由每条元数据预设的 `template` 字段指向 vault 里的 `.md`。
   * 旧键原样留在 data.json 里（不迁移、不删除），旧正文文件也仍在 vault 里；这里只提示用户
   * 从「从预设创建」重新生成一份新格式的预设。
   */
  private renderLegacyMetadataTemplatesWarning(parent: HTMLElement): void {
    const legacy = this.host.legacyMetadataTemplates;
    if (legacy === undefined || !legacy.present) return;
    const warning = parent.createDiv({ cls: "annex-legacy-profiles-warning" });
    warning.setAttr("data-count", String(legacy.count));
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-title",
      text: "The legacy metadata template registry is no longer active",
    });
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-body",
      text:
        `data.json still contains ${legacy.count} metadataTemplates. This version does not read or migrate them` +
        " (the old key stays in data.json and the old body files remain in the vault)." +
        "Use Create from preset to generate a new metadata preset: the body template is specified by the preset template field.",
    });
  }
}
