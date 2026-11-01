import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionControl, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";
import type { ProfileFileRef } from "../core/profile-files";
import type { RemoteEntry } from "../core/remotes";
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
  /** 「remote 设置」：可以有多条，一条 = 名称 + 地址；「初始化 gallery」时逐个 git remote add/set-url。 */
  remotes: RemoteEntry[];
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
  remotes: [],
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
  /** 扫当前仓库的 remote，把设置里没有的补进来；返回补了几条。 */
  scanVaultRemotes(): Promise<number>;
}

export class AnnexGallerySettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  /** 本次「打开设置页」是否已经扫过仓库 remote；hide() 重置。 */
  private remotesScanDone = false;
  /** 扫描在途：update() 重渲染时不再并发触发。 */
  private remotesScanInFlight = false;

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
        // 没有 heading：RemotesEditor 卡片自带「remote 设置」标题，避免重复。
        type: "group",
        cls: "annex-editors-group",
        items: [this.remotesDefinition()],
      },
      {
        type: "group",
        heading: "元数据预设与画廊模板",
        cls: "annex-editors-group",
        items: [this.profilesDefinition(), this.templatesDefinition()],
      },
      {
        type: "group",
        heading: "常规",
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

  /** 关闭设置页后允许下一次打开再扫一遍仓库 remote（口径与旧 `display()` 一致）。 */
  hide(): void {
    this.remotesScanDone = false;
    super.hide();
  }

  private remotesDefinition(): SettingDefinitionRender {
    return {
      name: "remote 设置",
      desc: "「初始化 gallery」会逐个执行 git remote add（同名已存在就 git remote set-url）；只写配置、不 fetch 也不 push。名称与地址都填了才生效。",
      render: (setting) => {
        const container = this.mountEditor(setting, "annex-remotes-section");
        new RemotesEditor(container, this.host).render();
        this.scheduleRemoteScan();
      },
    };
  }

  private profilesDefinition(): SettingDefinitionRender {
    return {
      name: "元数据预设",
      desc: "每条元数据预设是 vault 里的一个 .json 文件（frontmatter 与可选正文模板都写在里面）；在这里登记路径，或从预设创建。",
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
      name: "画廊模板",
      desc: "画廊模板是 vault 里的 .base；在这里登记或从预设创建。",
      render: (setting) => {
        const container = this.mountEditor(setting, "annex-templates-section");
        new TemplatesEditor(container, this.host).render();
      },
    };
  }

  private thumbnailEdgeDefinition(): SettingDefinitionControl<"thumbnailEdge"> {
    return {
      name: "缩略图边长",
      desc: "生成 .thumbnail.png 时的边长（px）。建议与 .base 的 cardSize 保持一致，默认 256。",
      control: {
        type: "number",
        key: "thumbnailEdge",
        defaultValue: DEFAULT_SETTINGS.thumbnailEdge,
        min: 1,
        step: 1,
        validate: (value) => (Number.isInteger(value) && value > 0 ? undefined : "请输入正整数（px）"),
      },
    };
  }

  private debugLoggingDefinition(): SettingDefinitionControl<"debugLogging"> {
    return {
      name: "调试日志",
      desc: "把 git / git-annex 的进度输出到开发者控制台。默认关闭。",
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
   * 打开设置页时扫一遍仓库 remote（口径与旧 `display()` 末尾一致）；补进新条目才 `update()`。
   *
   * 递归保护：本次打开只扫一轮（`remotesScanDone`），在途时不再触发；`hide()` 后才允许下一次。
   * 因此 `update()` → 重渲染 → render 回调不会再次发起扫描。
   */
  private scheduleRemoteScan(): void {
    if (this.remotesScanDone || this.remotesScanInFlight) return;
    this.remotesScanInFlight = true;
    void this.host
      .scanVaultRemotes()
      .then((added) => {
        this.remotesScanInFlight = false;
        this.remotesScanDone = true;
        if (added > 0) this.update();
      })
      .catch((error) => {
        this.remotesScanInFlight = false;
        this.remotesScanDone = true;
        console.error(error);
      });
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
      text: "旧版内联元数据预设已不再生效",
    });
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-body",
      text:
        `data.json 里还有 ${legacy.count} 条内联 profiles。本版本不会读取、不会自动迁移，也不会回退到预设。` +
        "请把每条配置分别保存成 vault 里的一个 .json 文件，然后在下面逐条「登记」。",
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
      text: "旧版 metadata 模板登记表已不再生效",
    });
    warning.createDiv({
      cls: "annex-legacy-profiles-warning-body",
      text:
        `data.json 里还有 ${legacy.count} 条 metadataTemplates。本版本不会读取它们，也不会自动迁移` +
        "（data.json 里的旧键原样保留，vault 里的旧正文文件也还在）。" +
        "请改用「从预设创建」生成新的元数据预设：正文模板由预设自己的 template 字段指定。",
    });
  }
}
