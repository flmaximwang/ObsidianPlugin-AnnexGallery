import * as path from "path";
import * as fs from "fs";
import {
  App,
  FileSystemAdapter,
  Menu,
  MenuItem,
  Modal,
  Notice,
  Plugin,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
  setIcon,
} from "obsidian";
import { git } from "./src/core/git";
import {
  ANNEX_OP_TITLE,
  AnnexOp,
  AnnexReport,
  DropReport,
  dropLargefiles,
  formatBytes,
  runAnnexOp,
} from "./src/core/annex";
import { initGallery } from "./src/core/init";
import { SidecarPlan, SidecarReport, generateSidecars, planSidecarTargets } from "./src/core/sidecar";
import { ThumbnailReport, generateThumbnails } from "./src/core/thumbnails";
import { addGalleryTag, buildGalleryBase, galleryFilePath, orderProperties, planGallery, type GalleryPlan } from "./src/core/gallery";
import { listTemplates, resolveTemplate, type TemplateListEntry, type TemplateRef } from "./src/core/templates";
import { findLoadedProfile, loadProfileFiles, profileFileRefs, type LoadedProfile } from "./src/core/profile-files";
import { progressPrefix } from "./src/core/types";
import {
  STATUS_REFRESH_MS,
  type RepoStatus,
  readRepoStatus,
  statusText,
  statusTooltip,
  unavailableStatus,
} from "./src/core/status";

import {
  DEFAULT_ASK,
  type ParseContext,
  type ParseProfile,
  pickProfile,
} from "./src/core/profiles";
import {
  AnnexGallerySettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
  SettingsHost,
  detectLegacyInlineProfiles,
  detectLegacyMetadataTemplates,
  readAsk,
  writeAsk,
  type LegacyInlineProfilesInfo,
  type LegacyMetadataTemplatesInfo,
} from "./src/ui/settings";

/** 弹窗提交时用的外部元数据预设（带其 vault 路径）与它的 ask 键 → 值。 */
type PromptSubmit = (profile: LoadedProfile, values: Record<string, string>) => void;

/**
 * The gallery menu title. Fixed English until the plugin ships bilingual UI.
 * Kept as a function so callers and tests share one source of truth.
 */
export function galleryMenuTitle(): string {
  return "Create Gallery";
}

/** 一个只有说明文字 + 一排按钮的弹窗（画廊流程里的「补标签？」「已存在？」都用它）。 */
class ChoiceModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly paragraphs: string[],
    private readonly buttons: Array<{ text: string; style?: "cta" | "warning"; run?: () => void }>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    for (const text of this.paragraphs) this.contentEl.createEl("p", { text });
    const row = new Setting(this.contentEl);
    for (const spec of this.buttons) {
      row.addButton((button) => {
        button.setButtonText(spec.text);
        if (spec.style === "cta") button.setCta();
        if (spec.style === "warning") button.setDestructive();
        button.onClick(() => {
          this.close();
          spec.run?.();
        });
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 画廊模板多于一份时，先问用哪份（默认 = 这个文件夹上次选的，否则第一条已登记）。 */
class GalleryTemplateModal extends Modal {
  private selected: string;

  constructor(
    app: App,
    private readonly subject: string,
    private readonly options: TemplateListEntry[],
    defaultId: string,
    private readonly onChoose: (id: string) => void,
  ) {
    super(app);
    this.selected = options.some((option) => option.id === defaultId) ? defaultId : options[0].id;
  }

  onOpen(): void {
    this.titleEl.setText(`${galleryMenuTitle()} — Choose a gallery template`);
    this.contentEl.createEl("p", { text: `Generate the .base for ${this.subject}; pick a template (remembered per folder).` });
    new Setting(this.contentEl).setName("Gallery template").addDropdown((dropdown) => {
      for (const option of this.options) dropdown.addOption(option.id, `${option.name} (${option.id})`);
      dropdown.setValue(this.selected);
      dropdown.onChange((value) => {
        this.selected = value;
      });
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(galleryMenuTitle())
          .setCta()
          .onClick(() => {
            this.close();
            this.onChoose(this.selected);
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * `MenuItem.setSubmenu()` 是 Obsidian **内置但未进公开 typings** 的 API
 * （`obsidian` 1.14.4 的 obsidian.d.ts 里没有；app 的 obsidian.asar 里实测存在，
 * 且 Obsidian 自己的编辑器菜单就在用它）。这里只给它补一个可选签名。
 */
type SubmenuCapableMenuItem = MenuItem & { setSubmenu?: () => Menu };

/**
 * 把本插件的右键选项全部收进一个顶层 `Annex Gallery` 项的子菜单（用户 2026-10-17 口径）。
 *
 * `fill` 拿到的是**要往里加选项的那个菜单**：正常情况是子菜单；万一 app 上
 * `setSubmenu()` 不存在，退回顶层菜单（功能不丢，只多一个不响应的「Annex Gallery」标签项）。
 */
function addAnnexSubmenu(menu: Menu, fill: (target: Menu) => void): void {
  let submenu: Menu | null = null;
  menu.addItem((item) => {
    item.setTitle("Annex Gallery").setIcon("images");
    const capable = item as SubmenuCapableMenuItem;
    if (typeof capable.setSubmenu === "function") submenu = capable.setSubmenu();
  });
  fill(submenu ?? menu);
}

/** 取一条 profile 要现场问的键（缺省 ["sample"]）。 */
function askKeysFor(profile: ParseProfile): string[] {
  return Array.isArray(profile.ask) && profile.ask.length > 0 ? profile.ask : DEFAULT_ASK;
}

/** 用文件夹的相对路径当 pickProfile / 预览的 ctx（右键的是文件夹，不是某张图）。 */
function promptContext(relpath: string, subject: string): ParseContext {
  const filename = subject === "/" ? "" : subject;
  const parts = filename.split("/");
  const folderName = parts.length > 0 ? parts[parts.length - 1] : filename;
  return { stem: filename, filename, relpath: relpath === "" ? filename : relpath, folderName };
}

/** 弹窗要问的：选元数据预设（默认 pickProfile 命中或记住的那条）+ 该预设的 ask 字段。 */
class SamplePromptModal extends Modal {
  private readonly profiles: LoadedProfile[];
  private selectedProfile: LoadedProfile;
  private values: Record<string, string> = {};
  private askContainer!: HTMLElement;

  constructor(
    app: App,
    private readonly subject: string,
    private readonly host: SettingsHost,
    private readonly dir: string,
    private readonly relpath: string,
    profiles: LoadedProfile[],
    private readonly onSubmit: PromptSubmit,
  ) {
    super(app);
    if (profiles.length === 0) {
      throw new Error("No metadata preset is available yet: register an external .json under Metadata presets in Settings, or create one from a preset.");
    }
    this.profiles = profiles;
    this.selectedProfile = this.pickDefault();
  }

  /** 记住的 → pickProfile 命中 → 第一条已加载（外部 id；都无效时用第一条）。 */
  private pickDefault(): LoadedProfile {
    const remembered = this.host.settings.folderProfiles[this.dir];
    if (remembered !== undefined) {
      const found = findLoadedProfile(this.profiles, remembered);
      if (found !== undefined) return found;
    }
    try {
      const picked = pickProfile(
        this.profiles.map((entry) => entry.profile),
        promptContext(this.relpath, this.subject),
      );
      if (picked !== null) {
        const found = findLoadedProfile(this.profiles, picked.id);
        if (found !== undefined) return found;
      }
    } catch {
      // pickProfile 的正则可能编译失败（设置页已提示）：回退到第一条。
    }
    return this.profiles[0];
  }

  /** 换预设 ⇒ 要问的字段跟着换。 */
  private selectProfile(profile: LoadedProfile): void {
    this.selectedProfile = profile;
    this.renderAskFields();
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Generate metadata — choose a preset and fill in fields");
    contentEl.createEl("p", {
      text: `For ${this.subject}, generate one sidecar .md per image; choose a metadata preset first, then fill in the fields that must be provided now (remembered per folder and prefilled next time).`,
    });

    new Setting(contentEl)
      .setName("Metadata preset")
      .setDesc("Preselected by match when possible; otherwise every preset is listed. Shows the name and id. The body template comes from the preset's own template field.")
      .addDropdown((dropdown) => {
        for (const entry of this.profiles) {
          dropdown.addOption(entry.profile.id, `${entry.profile.name} (${entry.profile.id})`);
        }
        dropdown.setValue(this.selectedProfile.profile.id);
        dropdown.onChange((value) => {
          const found = this.profiles.find((entry) => entry.profile.id === value);
          if (found !== undefined) this.selectProfile(found);
        });
      });

    this.askContainer = contentEl.createDiv({ cls: "annex-ask-fields" });
    this.renderAskFields();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Generate metadata").setCta().onClick(() => this.submit()))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  private renderAskFields(): void {
    this.askContainer.empty();
    this.values = {};
    const ask = askKeysFor(this.selectedProfile.profile);
    for (const key of ask) {
      const prefilled = readAsk(this.host.settings, this.dir, key);
      this.values[key] = prefilled;
      new Setting(this.askContainer).setName(`Ask field: ${key}`).addText((text) => {
        text.setValue(prefilled);
        text.onChange((value) => {
          this.values[key] = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
        text.inputEl.addClass("annex-ask-input");
        text.inputEl.setAttr("data-ask-key", key);
        // 弹窗（popout window）里用输入框自己所属窗口的定时器，避免焦点跳到主窗口。
        text.inputEl.win.setTimeout(() => text.inputEl.focus(), 0);
      });
    }
  }

  private submit(): void {
    const selected = this.selectedProfile.profile;
    const ask = askKeysFor(selected);
    for (const key of ask) {
      if ((this.values[key] ?? "").trim() === "") {
        new Notice(`${key} cannot be empty`);
        return;
      }
    }
    this.host.settings.folderProfiles[this.dir] = selected.id;
    for (const key of ask) {
      writeAsk(this.host.settings, this.dir, key, (this.values[key] ?? "").trim());
    }
    void this.host.saveSettings();
    const values: Record<string, string> = {};
    for (const key of ask) values[key] = (this.values[key] ?? "").trim();
    this.close();
    this.onSubmit(this.selectedProfile, values);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 「生成元数据」重跑时的提问：已经存在 N 份 sidecar，覆盖重算还是只补缺失。
 *
 * 用户 2026-10-17 口径：「可以再次运行，适合于改动模版后重新计算元数据，会提示用户是否覆盖」。
 * 覆盖重算会把**被改过**的那几份一起重写（弹窗里写明份数），所以要让人看清再按。
 */
class OverwritePromptModal extends Modal {
  constructor(
    app: App,
    private readonly subject: string,
    private readonly plan: SidecarPlan,
    private readonly onChoose: (overwrite: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const where = this.subject === "/" ? "repository root" : this.subject;
    titleEl.setText("Generate metadata — sidecars already exist. What should happen?");
    contentEl.createEl("p", {
      text: `Under ${where}, ${this.plan.existing} of ${this.plan.images} images already have sidecars${
        this.plan.dirty > 0 ? `; ${this.plan.dirty} of them have uncommitted changes` : ""
      }.`,
    });
    contentEl.createEl("p", {
      text: "Recompute all: rewrite these " + String(this.plan.existing) + " sidecars with the current preset — use this after changing a preset (sidecars with local changes are overwritten too).",
    });
    contentEl.createEl("p", { text: "Only add missing: leave every existing sidecar untouched and create sidecars only for images that have none." });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Recompute all")
          .setDestructive()
          .onClick(() => {
            this.close();
            this.onChoose(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Only add missing")
          .setCta()
          .onClick(() => {
            this.close();
            this.onChoose(false);
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 「Drop largefiles」的确认弹窗：先把要丢多少、多大摆清楚，再动手。
 *
 * 丢弃本身是破坏性的（本地内容会没），所以默认走 git-annex 的安全路径：别处没有足够副本的文件
 * 会被 annex 自己挡下并原样保留 —— 弹窗里把这条写明，免得用户以为「点了就一定全丢」。
 */
class DropConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly subject: string,
    private readonly report: DropReport,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const where = this.subject === "/" ? "repository root" : this.subject;
    titleEl.setText("Drop largefiles — drop local content");
    contentEl.createEl("p", {
      text: `Under ${where}, ${this.report.present} annex files have local content (${formatBytes(this.report.bytesPresent)}). Confirming drops that content to free disk space.`,
    });
    contentEl.createEl("p", {
      text: "Metadata .md, .thumbnail.png and .base files never enter annex (annex.largefiles=nothing in .gitattributes), so they are untouched and the gallery keeps working; use git annex get to restore an original.",
    });
    contentEl.createEl("p", {
      text: "git-annex only drops content that has enough copies elsewhere: files without another copy are refused and kept as-is (reported as skipped).",
    });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Drop")
          .setDestructive()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class AnnexGalleryPlugin extends Plugin implements SettingsHost {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  /**
   * 旧 data.json 内联 `profiles` 的检测结果（结构上公开给 SettingsHost）。
   * 只用于设置页显示非阻塞的失效提示 —— 旧配置不迁移、不导出、绝不参与运行时。
   * 在 `loadSettings()` 里由原始 `loadData()` 结果填充。
   */
  legacyInlineProfiles: LegacyInlineProfilesInfo = { present: false, count: 0 };

  /**
   * 旧 data.json 的 `metadataTemplates`（metadata 模板登记表）的检测结果。
   * 同样只用于设置页显示非阻塞提示；旧键原样留在 data.json 里（不迁移、不删除）。
   */
  legacyMetadataTemplates: LegacyMetadataTemplatesInfo = { present: false, count: 0 };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AnnexGallerySettingTab(this.app, this));

    // 状态栏（spec: docs/status-bar.md）：未提交 / 未跟踪 / 未入库 largefiles。
    // 30 秒轮询 + 点击立即刷新；`registerInterval` 让框架在卸载时替我清掉这个定时器。
    this.setupStatusBar();
    this.registerInterval(window.setInterval(() => void this.refreshStatus(), this.statusRefreshMs));
    void this.refreshStatus();

    // 入口 1：注册命令「初始化 gallery」
    this.addCommand({
      id: "init-gallery",
      name: "Initialize gallery",
      callback: () => {
        void this.runInit();
      },
    });

    // 入口 2–8：右键文件夹菜单 —— 所有选项收在一个顶层「Annex Gallery」子菜单里
    // （spec: docs/context-menu.md）；顺序与命名按用户 2026-10-17 口径：
    // 生成元数据 · 生成缩略图 · 创建画廊/Create Gallery（2026-10-31 追加）· Add largefiles to Annex · Unlock & unannex largefiles ·
    // Lock largefiles · Unlock largefiles · Get largefiles · Drop largefiles
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        addAnnexSubmenu(menu, (target) => {
          const entries: Array<{ title: string; icon: string; run: () => void }> = [
            { title: "Generate metadata", icon: "file-text", run: () => void this.runSidecars(file) },
            { title: "Generate thumbnails", icon: "image", run: () => void this.runThumbnails(file) },
            { title: galleryMenuTitle(), icon: "layout-grid", run: () => void this.runGallery(file) },
            { title: ANNEX_OP_TITLE.add, icon: "package-plus", run: () => void this.runAnnex("add", file) },
            { title: ANNEX_OP_TITLE.unannex, icon: "package-open", run: () => void this.runAnnex("unannex", file) },
            { title: ANNEX_OP_TITLE.lock, icon: "lock", run: () => void this.runAnnex("lock", file) },
            { title: ANNEX_OP_TITLE.unlock, icon: "unlock", run: () => void this.runAnnex("unlock", file) },
            { title: ANNEX_OP_TITLE.get, icon: "download", run: () => void this.runAnnex("get", file) },
            { title: ANNEX_OP_TITLE.drop, icon: "cloud-off", run: () => void this.runDrop(file) },
          ];
          for (const entry of entries) {
            target.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(entry.run));
          }
        });
      }),
    );
  }

  // ── 状态栏：未提交 / 未跟踪 / 未入库 largefiles（spec: docs/status-bar.md）────

  /**
   * 刷新间隔（毫秒）。**冒烟测试直接读这个字段**断言「30 秒轮询」（`statusRefreshMs === 30000`），
   * 所以别把常量内联进 `registerInterval`，两边会飘。
   */
  readonly statusRefreshMs = STATUS_REFRESH_MS;

  private statusBarEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private statusRefreshEl: HTMLElement | null = null;
  /** 上一次读到的状态 —— 决定点击是「刷新」还是「初始化 gallery」。 */
  private status: RepoStatus | null = null;
  /** 正在跑的那一轮统计（内含「期间又来请求 → 再补一趟」的循环）。 */
  private statusDrain: Promise<void> | null = null;
  private statusQueued = false;

  /**
   * 建状态栏那一行：文字 + 一个刷新图标（`refresh-cw`）。
   *
   * 整行可点 —— 点下去的含义随当前状态变（见 `onStatusClick()`）：还没初始化时点一下
   * 就是「初始化 gallery」，其余情况是「立即刷新」。监听用 `registerDomEvent` 挂，
   * 插件卸载时框架自己摘掉，不留 handler。
   */
  private setupStatusBar(): void {
    const el = this.addStatusBarItem();
    el.addClass("annex-status-bar");
    el.setAttr("data-level", "loading");
    this.statusBarEl = el;

    this.statusTextEl = el.createSpan({ cls: "annex-status-counts", text: "Counting…" });
    this.statusTextEl.setAttr("aria-label", "Annex Gallery: counting");

    this.statusRefreshEl = el.createSpan({ cls: "annex-status-refresh" });
    setIcon(this.statusRefreshEl, "refresh-cw");
    this.statusRefreshEl.setAttr("aria-label", "Refresh now");

    this.registerDomEvent(el, "click", () => {
      void this.onStatusClick();
    });
  }

  /** 点击状态栏：未初始化 → 跑「初始化 gallery」（跑完重算）；其余 → 立即重算。 */
  private async onStatusClick(): Promise<void> {
    const current = this.status;
    if (current !== null && current.level === "uninitialized") {
      await this.runInit();
      await this.refreshStatus();
      return;
    }
    await this.refreshStatus();
  }

  /**
   * 读一次状态并画上去。
   *
   * 故意是 **public**：`tools/smoke-test.cjs` 与 `tools/status-check.cjs` 要能确定性地
   * `await` 一次刷新，而不是干等 30 秒轮询 —— `await` 返回时保证「已经有一趟在本次调用
   * 之后跑完」。
   *
   * 串行化：vault 大时一趟约 4 秒（`git status` ~2 秒 + `git annex add --dry-run` ~2 秒，
   * 实测见 docs/status-bar.md），同一时刻只跑一趟 git 子进程；期间的请求只登记一个标记，
   * 当前这趟跑完再补一趟（30 秒轮询 × 手动点击 × 多次点击都不会堆出一串子进程）。
   */
  async refreshStatus(): Promise<void> {
    if (this.statusDrain !== null) {
      this.statusQueued = true;
      await this.statusDrain;
      return;
    }
    this.statusDrain = (async () => {
      do {
        this.statusQueued = false;
        await this.runStatusRefresh();
      } while (this.statusQueued);
    })();
    try {
      await this.statusDrain;
    } finally {
      this.statusDrain = null;
    }
  }

  /** 真正的一趟：读 + 画。异常都收在这里，绝不让它冒到 onload / 定时器外面。 */
  private async runStatusRefresh(): Promise<void> {
    this.setStatusBusy(true);
    try {
      let dir = "";
      try {
        dir = this.vaultRoot();
      } catch {
        // 非桌面端才拿不到路径（isDesktopOnly 的插件本不会在那里加载）：别让异常冒出 onload。
      }
      const status =
        dir === ""
          ? unavailableStatus("", "Cannot resolve the local vault path (Annex Gallery is desktop-only)")
          : await readRepoStatus(dir);
      this.status = status;
      this.renderStatus(status);
    } finally {
      this.setStatusBusy(false);
    }
  }

  /** 把一条状态画进状态栏：文字、`data-level`（配色用）、`aria-label`（悬停提示 = 口径说明）。 */
  private renderStatus(status: RepoStatus): void {
    const el = this.statusBarEl;
    if (el === null) return;
    el.setAttr("data-level", status.level);
    const text = statusText(status);
    if (this.statusTextEl !== null) {
      this.statusTextEl.setText(text);
      this.statusTextEl.setAttr("aria-label", text);
    }
    el.setAttr("aria-label", statusTooltip(status));
  }

  private setStatusBusy(busy: boolean): void {
    this.statusBarEl?.setAttr("data-busy", busy ? "true" : "false");
  }

  onunload(): void {
    // nothing to tear down: no long-lived processes, no open handles
  }

  // ── settings plumbing ────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    // 原始 data.json（未经合并）：旧内联 `profiles` 与旧 `metadataTemplates` 的检测只看它本身。
    const rawData: unknown = await this.loadData();
    this.legacyInlineProfiles = detectLegacyInlineProfiles(rawData);
    this.legacyMetadataTemplates = detectLegacyMetadataTemplates(rawData);
    const stored: Record<string, unknown> =
      rawData !== null && typeof rawData === "object" && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};
    // Did the loaded data.json actually carry the obsolete remotes key? If so, drop it and
    // persist once at the end of this method so the file stops containing it immediately.
    const hadLegacyRemotes =
      rawData !== null &&
      typeof rawData === "object" &&
      !Array.isArray(rawData) &&
      Object.prototype.hasOwnProperty.call(rawData, "remotes");
    // 顺序不变：用户已有的 data.json 优先，缺失的键才用 DEFAULT_SETTINGS，绝不冲掉现有配置。
    // 注意：旧的内联 `profiles`、旧的 `metadataTemplates` 会原样留在 data.json 里（不迁移、不删除），
    // 但运行时**只读** `profileFiles` 指向的外部 JSON —— 旧值永远不会被当成配置来源。
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // 已废弃的键：.gitattributes / .gitignore 路径与「默认样品名」都不再是设置项
    // （spec: 用默认即可、没有所谓默认样品名）。留在 data.json 里只会误导人，删掉。
    const legacy = this.settings as unknown as Record<string, unknown>;
    delete legacy.gitattributesPath;
    delete legacy.gitignorePath;
    delete legacy.defaultSample;
    // Remotes now live only in .git/config. Drop the obsolete data.json copy silently.
    delete legacy.remotes;
    // 元数据预设：只保留 vault 相对路径；真正的路径/存在性/内容校验发生在每次操作前的
    // `loadProfileFiles`（那时出错才可见）。
    this.settings.profileFiles = profileFileRefs(this.settings.profileFiles);
    if (this.settings.folderProfiles === null || typeof this.settings.folderProfiles !== "object") {
      this.settings.folderProfiles = {};
    }
    if (this.settings.folderSamples === null || typeof this.settings.folderSamples !== "object") {
      this.settings.folderSamples = {};
    }
    // 画廊模板登记与按文件夹的选择：旧 data.json 没这些键 ⇒ 空。
    // 值是 unknown：只接受 string/number/boolean，其它（对象、数组…）一律当空串 ——
    // String(obj) 会变成 "[object Object]"，混进设置里只会更难排查。
    const asText = (value: unknown): string =>
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : "";
    const refs = (value: unknown): TemplateRef[] =>
      Array.isArray(value)
        ? value
            .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
            .map((entry) => ({
              id: asText(entry.id),
              name: asText(entry.name ?? entry.id),
              path: asText(entry.path),
            }))
            .filter((entry) => entry.id !== "" && entry.path !== "")
        : [];
    this.settings.baseTemplates = refs(this.settings.baseTemplates);
    const folderBaseTemplates = this.settings.folderBaseTemplates as unknown;
    if (folderBaseTemplates === null || typeof folderBaseTemplates !== "object" || Array.isArray(folderBaseTemplates)) {
      this.settings.folderBaseTemplates = {};
    }
    // ⚠️ `DEFAULT_SETTINGS` 里的数组/对象是**模块级常量**：`Object.assign` 只把引用拷过来，
    // 一次运行里写入的「按文件夹记忆」会污染模块常量 —— 下一个插件实例（新窗口 / 重载）就会读到
    // 上一轮的残留记忆（甚至把「模板没登记」的错误掩盖掉）。这里统一换成各自的副本。
    this.settings.folderProfiles = { ...this.settings.folderProfiles };
    this.settings.folderSamples = { ...this.settings.folderSamples };
    this.settings.folderBaseTemplates = { ...this.settings.folderBaseTemplates };
    this.settings.profileFiles = [...this.settings.profileFiles];
    this.settings.baseTemplates = [...this.settings.baseTemplates];
    // Silently drop the obsolete data.json copy from disk (no notice, no migration).
    if (hadLegacyRemotes) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 「当前仓库」= the vault this Obsidian window has open (desktop only). */
  vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("Annex Gallery is desktop-only: cannot resolve the local vault path");
  }

  /** 设置页「复制为自定义」：在 vault 里新建文件（被占用就加 ` 2`、` 3`…），返回实际路径。 */
  async createVaultFile(relPath: string, text: string): Promise<string> {
    const target = normalizePath(relPath);
    const dot = target.lastIndexOf(".");
    const stem = dot > target.lastIndexOf("/") ? target.slice(0, dot) : target;
    const ext = dot > target.lastIndexOf("/") ? target.slice(dot) : "";
    let candidate = target;
    for (let n = 2; fs.existsSync(path.join(this.vaultRoot(), candidate)); n += 1) candidate = `${stem} ${n}${ext}`;
    const folder = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
    if (folder !== "" && this.app.vault.getAbstractFileByPath(folder) === null) await this.app.vault.createFolder(folder);
    await this.app.vault.create(candidate, text);
    return candidate;
  }

  /**
   * 用系统默认外部应用打开一个文件（设置页卡片的「打开」按钮）。
   *
   * ⚠️ Obsidian 的 `app.openWithDefaultApp(p)` 吃的是 **vault 相对路径**：bundle 里它做的是
   * `FileSystemAdapter.getFilePath(p)` 拼成绝对路径再 `window.open(abs, "_external")`。我们的
   * 缓冲文件在 `TMPDIR` 里（不在 vault 内），传绝对路径进去会被拼成 `<vault>/var/folders/…`
   * 这种不存在的路径 —— **静默失败、什么都不弹**（真机踩过）。
   *
   * 所以：绝对路径一律走 Electron 的 `shell.openPath`（它就是要绝对路径，且返回空串才算成功，
   * 失败时返回原因）；只有当路径确实落在 vault 内时才退回 Obsidian 那个 API。
   */
  async openWithDefaultApp(filePath: string): Promise<void> {
    type ElectronModule = typeof import("electron");
    let electron: ElectronModule | undefined;
    try {
      // 桌面端由 Obsidian 提供 electron（esbuild 里是 external）；无头自检环境里没有它，
      // import 失败就落回 vault 内那条路（app.openWithDefaultApp 只认 vault 相对路径）。
      electron = await import("electron");
    } catch {
      electron = undefined; // 无头自检环境里没有 electron：往下走 vault 内那条路
    }
    const shell = electron?.shell;
    if (shell !== undefined) {
      const failure = await shell.openPath(filePath);
      if (failure === "") return;
      throw new Error(`The system default application could not open it: ${failure}`);
    }

    const opener = (this.app as App & { openWithDefaultApp?: (target: string) => void }).openWithDefaultApp;
    if (typeof opener === "function") {
      const root = this.vaultRoot();
      const relative = path.relative(root, filePath);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        opener.call(this.app, relative.split(path.sep).join("/"));
        return;
      }
      throw new Error(
        `No system default application available: electron.shell.openPath is unavailable and ${filePath} is outside the vault (app.openWithDefaultApp only accepts vault-relative paths)`,
      );
    }
    throw new Error("No system default application available: neither electron.shell.openPath nor app.openWithDefaultApp exists");
  }

  private folderPath(folder: TFolder): string {
    return path.join(this.vaultRoot(), folder.path === "/" ? "" : folder.path);
  }

  /** Folder → the git work tree containing it (used by the dirty-file guard). */
  private gitTopOf(dir: string): string {
    const result = git(["rev-parse", "--show-toplevel"], dir);
    return result.code === 0 ? result.stdout.trim() : dir;
  }

  /**
   * 进度日志默认不进控制台：社区插件审核要求默认配置下只显示错误。
   * 需要看 git / git-annex 的实时输出时在设置里打开「调试日志」。
   */
  private logProgress(message: string): void {
    if (this.settings.debugLogging) console.debug(progressPrefix(message));
  }

  private notifyReport(title: string, lines: string[]): void {
    new Notice(`${title}\n${lines.join("\n")}`, 8000);
    for (const line of lines) this.logProgress(line);
  }

  // ── 入口 1：初始化 gallery ───────────────────────────────────────────────

  private async runInit(): Promise<void> {
    const root = this.vaultRoot();
    try {
      const result = await initGallery(root, {
        progress: (message) => this.logProgress(message),
      });
      this.notifyReport("Initialize gallery complete", [
        `Repository root: ${result.root}`,
        `git init: ${result.createdRepo ? "created" : "already a repository, skipped"}`,
        `git annex init: ${result.initedAnnex ? "ran" : "already an annex repository, skipped"}`,
        `annex.addunlocked: ${
          result.shape.addUnlocked.action === "unchanged"
            ? "branch is already true, unchanged"
            : "branch set to true (files added from now on are stored unlocked)"
        }`,
        ...(result.shape.localRepairs.length === 0
          ? []
          : [
              `Local settings: repaired ${result.shape.localRepairs.length} (${result.shape.localRepairs
                .map((entry) => `${entry.key}=${entry.previous ?? "(none)"}→${entry.action === "unset" ? "unset" : String(entry.standard)}`)
                .join(" · ")})`,
            ]),
        `.gitattributes: added ${result.gitattributes.added.length} rules`,
        `.gitignore: added ${result.gitignore.added.length} rules`,
        ...result.notes,
      ]);
    } catch (error) {
      new Notice(`Initialize gallery failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 入口 2：生成缩略图 ───────────────────────────────────────────────────

  private async runThumbnails(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const progress = new Notice(`Generate thumbnails: ${folder.path} (${this.settings.thumbnailEdge}px)`, 0);
    try {
      const report: ThumbnailReport = await generateThumbnails(dir, {
        edge: this.settings.thumbnailEdge,
        progress: (message) => this.logProgress(message),
      });
      progress.hide();
      this.notifyReport("Generate thumbnails complete", [
        `Directory: ${report.dir}`,
        `Edge: ${report.edge}px`,
        `Created ${report.created} · Skipped ${report.skipped} · Failed ${report.failed}`,
      ]);
    } catch (error) {
      progress.hide();
      new Notice(`Generate thumbnails failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 入口 4–8：git-annex largefiles 操作（Add / Unlock & unannex / Lock / Unlock / Get）──

  /**
   * 一个 annex 操作跑在一个目录上。长操作（`Get largefiles` 可能要下载几分钟）走**流式**执行，
   * 进度实时写进那条常驻 Notice —— 不用同步等待，Obsidian 的 UI 不会冻住。
   */
  private async runAnnex(op: AnnexOp, folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const where = folder.path === "/" ? "repository root" : folder.path;
    const title = ANNEX_OP_TITLE[op];
    const notice = new Notice(`${title}: ${where} …`, 0);
    const progress = (message: string): void => {
      notice.setMessage(message);
      this.logProgress(message);
    };
    try {
      const report: AnnexReport = await runAnnexOp(op, dir, { progress });
      notice.hide();
      this.notifyReport(`${title} complete`, this.annexReportLines(op, where, report));
    } catch (error) {
      notice.hide();
      new Notice(`${title} failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }

  /** 每个操作自带一句「按完之后要知道什么」。 */
  private annexReportLines(op: AnnexOp, where: string, report: AnnexReport): string[] {
    const lines = [
      `Directory: ${where}`,
      `annex reported ${report.ok} action(s)${
        report.skipped > 0 ? ` · ${report.skipped} skipped` : ""
      } (no enough copies elsewhere) · ${report.failed} failed — files that needed no action are not listed`,
    ];
    if (op === "add" && report.candidates !== undefined) {
      lines.push(`${report.candidates} candidate largefile(s) — .gitattributes annex.largefiles decides what enters annex and what stays in git`);
      lines.push("Hint: newly added/staged changes still need a commit to enter history.");
    }
    if (op === "get" && report.candidates !== undefined) {
      lines.push(`${report.candidates} file(s) missing local content (files already present locally are unaffected)`);
    }
    if (op === "drop" && report.bytesFreed !== undefined && report.bytesFreed > 0) {
      lines.push(`Freed ${formatBytes(report.bytesFreed)}`);
    }
    if (op === "unannex") {
      if (report.staged !== undefined) {
        lines.push(`Staged ${report.staged} file(s) as ordinary git files (git annex add --force-small) — a commit is still needed`);
      }
      lines.push("These files are now managed directly by git instead of annex.");
    }
    if (op === "lock") {
      lines.push("Note: after lock, working-tree files are symlinks and Obsidian silently skips indexing them (original-image links stop working); use Unlock largefiles to restore.");
    }
    if (op === "unlock") {
      lines.push("Working-tree files are now regular files (index 100644) and Obsidian indexes them normally.");
    }
    const failed = report.entries.filter((entry) => entry.action === "failed");
    for (const entry of failed.slice(0, 3)) lines.push(`Failed: ${entry.file} (${entry.detail ?? ""})`);
    return lines;
  }

  // ── 入口 3：生成元数据（sidecar .md；可重跑，会问是否覆盖）────────────────

  /**
   * 每次生成操作开始时重新读全部外部元数据预设 JSON。
   *
   * 运行时**唯一**的预设来源是设置里登记的外部 `.json`（每份一个顶层 `ParseProfile` 对象）：
   * 旧内联 `profiles`、内置预设都不参与。任一份文件坏了 / id 重复 ⇒ 抛错（带路径）；
   * 一份都没登记 ⇒ 同样报错并引导去设置页 —— 不静默回退到任何内置内容。
   */
  private loadProfilesForOperation(): LoadedProfile[] {
    const loaded = loadProfileFiles(this.vaultRoot(), profileFileRefs(this.settings.profileFiles));
    if (loaded.length === 0) {
      throw new Error(
        "No metadata preset is registered yet: register an external .json under Metadata presets in Settings, or create one from a preset.",
      );
    }
    return loaded;
  }

  private async runSidecars(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const relpath = folder.path === "/" ? "" : folder.path;
    // 校验与加载都在最前面：坏文件 / 重复 id / 空列表 ⇒ 弹窗都不开，更不会写盘。
    let loaded: LoadedProfile[];
    try {
      loaded = this.loadProfilesForOperation();
    } catch (error) {
      new Notice(`Generate metadata failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
      return;
    }
    try {
      new SamplePromptModal(this.app, folder.path, this, dir, relpath, loaded, (profile, values) => {
        void this.generateSidecarsWithPrompt(folder, dir, loaded, profile, values);
      }).open();
    } catch (error) {
      new Notice(`Generate metadata failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
    }
  }

  /**
   * 「生成元数据」可以重跑（用户 2026-10-17 口径）：改动预设后要重算，所以先**只读**数一下
   * 已存在的 sidecar（`planSidecarTargets`，不写盘），有的话问一句「覆盖重算 / 只补缺失 / 取消」。
   *
   * 正文模板不再单独解析：由 core 的 `generateSidecars` 按 `profile.template` 读 vault 里的 `.md`，
   * 坏模板在任何写盘之前就抛出（这里 catch 住并提示）。
   */
  private async generateSidecarsWithPrompt(
    folder: TFolder,
    dir: string,
    loaded: LoadedProfile[],
    selected: LoadedProfile,
    values: Record<string, string>,
  ): Promise<void> {
    let plan: SidecarPlan;
    try {
      plan = planSidecarTargets(dir, this.gitTopOf(dir));
    } catch (error) {
      console.error(error);
      plan = { images: 0, existing: 0, dirty: 0 };
    }
    if (plan.existing === 0) {
      await this.executeSidecars(folder, dir, loaded, selected, values, false);
      return;
    }
    new OverwritePromptModal(this.app, folder.path, plan, (overwrite) => {
      void this.executeSidecars(folder, dir, loaded, selected, values, overwrite);
    }).open();
  }

  private async executeSidecars(
    folder: TFolder,
    dir: string,
    loaded: LoadedProfile[],
    selected: LoadedProfile,
    values: Record<string, string>,
    overwrite: boolean,
  ): Promise<void> {
    // 预设选择与 ask 值已由弹窗写进 folderProfiles / folderSamples 并落盘。
    const profile = selected.profile;
    const ask = askKeysFor(profile);
    const summary = ask.map((key) => `${key}=${values[key] ?? ""}`).join(" · ");
    const progress = new Notice(`Generate metadata: ${folder.path} (${profile.name} | ${summary}${overwrite ? " | recompute all" : ""})`, 0);
    try {
      const report: SidecarReport = await generateSidecars(dir, {
        vaultRoot: this.vaultRoot(),
        repoRoot: this.gitTopOf(dir),
        // 弹窗里选的预设 / 填的 ask 都要传下去（之前漏传，弹窗的预设选择不生效）。
        profile,
        // 候选预设 = 本次操作开始时读到的全部外部预设（不再有内置兜底）。
        profiles: loaded.map((entry) => entry.profile),
        ask: values,
        apply: true,
        overwrite,
        progress: (message) => this.logProgress(message),
      });
      progress.hide();
      const count = (action: string): number => report.entries.filter((entry) => entry.action === action).length;
      const lines = [
        `Directory: ${report.dir}`,
        `Created ${count("created")} · Overwritten ${count("overwritten")} · Skipped (exists) ${count("skipped-existing")} · Skipped (modified) ${count("skipped-dirty")} · Failed ${count("failed")}`,
      ];
      lines.push(`Preset: ${selected.path}`);
      if (overwrite) lines.push("Mode: recompute all (every existing sidecar is rewritten with the current preset)");
      const templateNotes = report.entries.filter((entry) => (entry.detail ?? "").includes("Template placeholders"));
      if (templateNotes.length > 0) lines.push(`${templateNotes.length} sidecar(s) had body placeholders with no value (left empty; see the console)`);
      const collisions = Object.entries(report.duplicateStems);
      if (collisions.length > 0) lines.push(`${collisions.length} duplicate stem(s) — links were written using full-vault paths`);
      const failed = report.entries.filter((entry) => entry.action === "failed");
      for (const entry of failed.slice(0, 3)) lines.push(`Failed: ${path.basename(entry.sidecar)} (${entry.detail ?? ""})`);
      this.notifyReport("Generate metadata complete", lines);
    } catch (error) {
      progress.hide();
      new Notice(`Generate metadata failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 创建画廊 / Create Gallery（spec: docs/gallery.md）──────────────────────

  /**
   * 选模板（多于一份才问，按文件夹记住）→ 填模板（坏模板在这里就停）→ 只读盘点 →
   * 有旧 sidecar 没标签就问「补标签 / 跳过 / 取消」→ 目标已存在就问「覆盖 / 打开已有 / 取消」→ 写 → 打开。
   *
   * 外部元数据预设在这一步的最前面就读好（画廊的属性顺序按各预设的 frontmatter 键排）；
   * 读坏了 / 一份都没登记 ⇒ 在写 .base 之前就停。
   */
  private async runGallery(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const title = galleryMenuTitle();
    let loaded: LoadedProfile[];
    try {
      loaded = this.loadProfilesForOperation();
    } catch (error) {
      new Notice(`${title} failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
      return;
    }
    // 运行时只有已登记的外部 .base；没有内置兜底。
    const options = listTemplates("base", this.settings.baseTemplates);
    if (options.length === 0) {
      new Notice(
        `${title} failed: no gallery template (.base) is registered yet. Register an external file under Gallery templates in Settings, or create one from a preset.`,
        10000,
      );
      return;
    }
    // 记住的 id 仍有效就用它；无效（旧内置 default 之类）⇒ 用第一条已登记的。
    const remembered = this.settings.folderBaseTemplates[dir];
    const defaultId = options.some((entry) => entry.id === remembered) ? remembered : options[0].id;
    const go = (id: string): void => {
      this.settings.folderBaseTemplates[dir] = id;
      void this.saveSettings();
      void this.prepareGallery(folder, dir, id, loaded);
    };
    if (options.length === 1) {
      go(options[0].id);
      return;
    }
    new GalleryTemplateModal(this.app, folder.path, options, defaultId, go).open();
  }

  private async prepareGallery(
    folder: TFolder,
    dir: string,
    templateId: string,
    loaded: LoadedProfile[],
  ): Promise<void> {
    const title = galleryMenuTitle();
    const relFolder = folder.path === "/" ? "" : folder.path;
    let plan: GalleryPlan;
    let built: { text: string; missing: string[] };
    let label: string;
    try {
      const template = resolveTemplate("base", templateId, this.settings.baseTemplates, this.vaultRoot());
      label = template.label;
      plan = planGallery(dir);
      const properties = orderProperties(
        plan.keys,
        loaded.map((entry) => Object.keys(entry.profile.frontmatter ?? {})),
      );
      built = buildGalleryBase(template, { folder: relFolder, cardSize: this.settings.thumbnailEdge, properties });
    } catch (error) {
      new Notice(`${title} failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
      return;
    }

    const target = galleryFilePath(relFolder, this.app.vault.getName());
    const afterTags = (fixTags: boolean): void => {
      const write = (): void => void this.writeGallery(title, target, built, plan, label, fixTags);
      if (!fs.existsSync(path.join(this.vaultRoot(), target))) {
        write();
        return;
      }
      new ChoiceModal(this.app, `${title} — ${target} already exists`, [`${target} already exists. Overwriting rewrites the whole file from the template (manual view edits are lost).`], [
        { text: "Overwrite", style: "warning", run: write },
        { text: "Open existing", style: "cta", run: () => void this.openVaultFile(target) },
        { text: "Cancel" },
      ]).open();
    };

    if (plan.untagged.length === 0) {
      afterTags(false);
      return;
    }
    new ChoiceModal(
      this.app,
      `${title} — ${plan.untagged.length} old sidecar(s) have no tag`,
      [
        `${plan.untagged.length} sidecar(s) with a tif key under ${folder.path} lack the annex-gallery-metadata tag. The gallery only recognizes that tag, so they would not appear.`,
        "Add tag: only add this one item to tags; nothing else in the file is changed.",
      ],
      [
        { text: "Add tag", style: "cta", run: () => afterTags(true) },
        { text: "Skip", run: () => afterTags(false) },
        { text: "Cancel" },
      ],
    ).open();
  }

  private async writeGallery(
    title: string,
    target: string,
    built: { text: string; missing: string[] },
    plan: GalleryPlan,
    label: string,
    fixTags: boolean,
  ): Promise<void> {
    try {
      let fixed = 0;
      if (fixTags) {
        for (const file of plan.untagged) {
          const text = fs.readFileSync(file, "utf8");
          const next = addGalleryTag(text);
          if (next !== null && next !== text) {
            fs.writeFileSync(file, next, "utf8");
            fixed += 1;
          }
        }
      }
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) await this.app.vault.modify(existing, built.text);
      else if (fs.existsSync(path.join(this.vaultRoot(), target))) await this.app.vault.adapter.write(target, built.text); // 盘上有、索引还没跟上
      else await this.app.vault.create(target, built.text);
      await this.openVaultFile(target);

      const lines = [
        `Gallery: ${target} (template: ${label})`,
        `${plan.tagged + fixed} sidecar(s) in the gallery${fixed > 0 ? ` (${fixed} tagged just now)` : ""}${
          !fixTags && plan.untagged.length > 0 ? ` · ${plan.untagged.length} untagged and hidden` : ""
        }`,
      ];
      if (plan.missingSidecars > 0) lines.push(`${plan.missingSidecars} image(s) have no sidecar yet — run Generate metadata first`);
      if (plan.missingThumbnails > 0) lines.push(`${plan.missingThumbnails} sidecar(s) are missing thumbnails — run Generate thumbnails first`);
      if (built.missing.length > 0) lines.push(`Template placeholders with no value were left empty: ${built.missing.map((name) => `{{${name}}}`).join(" ")}`);
      this.notifyReport(`${title} complete`, lines);
    } catch (error) {
      new Notice(`${title} failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
    }
  }

  private async openVaultFile(relPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  // ── 入口 4：Drop largefiles（丢弃本地 annex 内容，腾硬盘）─────────────────

  /**
   * 先预览（本地有多少 annex 内容、多大），弹窗确认后再真丢。
   *
   * 预览只跑 `git annex find --in=here`（annex 的 drop 没有 --dry-run），所以这个阶段
   * 一个字节都不动；真丢时的成败逐文件看 `--json` 的 `success`（annex 的退出码不可信）。
   */
  private async runDrop(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const where = folder.path === "/" ? "repository root" : folder.path;
    try {
      const preview = await dropLargefiles(dir, { dryRun: true, progress: (m) => this.logProgress(m) });
      if (preview.present === 0) {
        new Notice(
          `Drop largefiles: ${where} has no local annex content to drop (already dropped, or no annex files here)`,
          8000,
        );
        return;
      }
      new DropConfirmModal(this.app, folder.path, preview, () => {
        void this.executeDrop(dir, where, preview.present);
      }).open();
    } catch (error) {
      new Notice(`Drop largefiles failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }

  private async executeDrop(dir: string, where: string, expected: number): Promise<void> {
    const progress = new Notice(`Drop largefiles: dropping local content for ${expected} file(s) under ${where}…`, 0);
    try {
      const report: DropReport = await dropLargefiles(dir, {
        progress: (message) => this.logProgress(message),
      });
      progress.hide();
      const lines = [
        `Directory: ${where}`,
        `Dropped ${report.dropped} · Freed ${formatBytes(report.bytesFreed)}`,
        `Skipped (no enough copies elsewhere) ${report.skipped} · Failed ${report.failed}`,
      ];
      const failed = report.entries.filter((entry) => entry.action === "failed");
      for (const entry of failed.slice(0, 3)) lines.push(`Failed: ${entry.file} (${entry.detail ?? ""})`);
      this.notifyReport("Drop largefiles complete", lines);
    } catch (error) {
      progress.hide();
      new Notice(`Drop largefiles failed: ${String(error)}`, 10000);
      console.error(error);
    }
  }
}
