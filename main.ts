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
  getLanguage,
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
import { checkMetadataTemplate } from "./src/core/templates";
import { ThumbnailReport, generateThumbnails } from "./src/core/thumbnails";
import { addGalleryTag, buildGalleryBase, galleryFilePath, orderProperties, planGallery, type GalleryPlan } from "./src/core/gallery";
import { DEFAULT_TEMPLATE_ID, listTemplates, resolveTemplate, type ResolvedTemplate, type TemplateRef } from "./src/core/templates";
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
  DEFAULT_PROFILES,
  type ParseContext,
  type ParseProfile,
  pickProfile,
} from "./src/core/profiles";
import { mergeScannedRemotes, scanRemotes } from "./src/core/remotes";
import {
  AnnexGallerySettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
  SettingsHost,
  cloneProfiles,
  readAsk,
  writeAsk,
} from "./src/ui/settings";

/** 弹窗提交时用的 profile、其 ask 键 → 值、以及选中的 metadata 模板 id。 */
type PromptSubmit = (profile: ParseProfile, values: Record<string, string>, templateId: string) => void;

/**
 * 「创建画廊」的标题跟 Obsidian 界面语言走（用户 2026-10-31 口径：只有这一项本地化）。
 * `getLanguage()` 是 1.8+ 的公开 API；更老的 app 上不存在 ⇒ 退回 moment 的 locale，再不行用英文。
 */
export function galleryMenuTitle(): string {
  let lang = "";
  try {
    if (typeof getLanguage === "function") lang = getLanguage();
  } catch {
    lang = "";
  }
  if (lang === "") {
    const moment = (globalThis as { moment?: { locale?: () => string } }).moment;
    lang = typeof moment?.locale === "function" ? moment.locale() : "";
  }
  return lang.toLowerCase().startsWith("zh") ? "创建画廊" : "Create Gallery";
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
        if (spec.style === "warning") button.setWarning();
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

/** 画廊模板多于一份时，先问用哪份（默认 = 这个文件夹上次选的，否则 default）。 */
class GalleryTemplateModal extends Modal {
  private selected: string;

  constructor(
    app: App,
    private readonly subject: string,
    private readonly options: Array<{ id: string; name: string; builtin: boolean }>,
    remembered: string | undefined,
    private readonly onChoose: (id: string) => void,
  ) {
    super(app);
    this.selected = options.some((option) => option.id === remembered) ? (remembered as string) : DEFAULT_TEMPLATE_ID;
  }

  onOpen(): void {
    this.titleEl.setText(`${galleryMenuTitle()} — 选画廊模板`);
    this.contentEl.createEl("p", { text: `为 ${this.subject} 生成 .base；选一份模板（按文件夹记住）。` });
    new Setting(this.contentEl).setName("画廊模板").addDropdown((dropdown) => {
      for (const option of this.options) dropdown.addOption(option.id, `${option.name}（${option.id}${option.builtin ? " · 内置" : ""}）`);
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
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
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

/** 弹窗要问的：选 profile（默认 pickProfile 命中或记住的那条）+ 该 profile 的 ask 字段。 */
class SamplePromptModal extends Modal {
  private readonly profiles: ParseProfile[];
  private selectedProfile: ParseProfile;
  private values: Record<string, string> = {};
  private askContainer!: HTMLElement;
  private templateId: string;
  private templateDropdown: { setValue(value: string): unknown } | null = null;

  constructor(
    app: App,
    private readonly subject: string,
    private readonly host: SettingsHost,
    private readonly dir: string,
    private readonly relpath: string,
    private readonly onSubmit: PromptSubmit,
  ) {
    super(app);
    this.profiles = host.settings.profiles.length > 0 ? host.settings.profiles : DEFAULT_PROFILES;
    this.selectedProfile = this.pickDefault();
    const remembered = host.settings.folderMetadataTemplates[dir];
    this.templateId = this.templateExists(remembered) ? (remembered as string) : this.profileTemplate(this.selectedProfile);
  }

  private templateExists(id: string | undefined): boolean {
    return id !== undefined && listTemplates("metadata", this.host.settings.metadataTemplates).some((entry) => entry.id === id);
  }

  /** profile 自己声明的模板（不存在时退回 default —— 真用到时再报错，见 resolveTemplate）。 */
  private profileTemplate(profile: ParseProfile): string {
    const id = profile.metadataTemplate;
    return id !== undefined && this.templateExists(id) ? id : DEFAULT_TEMPLATE_ID;
  }

  /** 记住的 → pickProfile 命中 → 第一条（引擎未实现/无命中时静默回退，列出全部让用户挑）。 */
  private pickDefault(): ParseProfile {
    const remembered = this.host.settings.folderProfiles[this.dir];
    if (remembered !== undefined) {
      const found = this.profiles.find((profile) => profile.id === remembered);
      if (found !== undefined) return found;
    }
    try {
      const picked = pickProfile(this.profiles, promptContext(this.relpath, this.subject));
      if (picked !== null) return picked;
    } catch {
      // pickProfile 是并行块 B-002 的桩（还在抛错）：回退到第一条。
    }
    return this.profiles[0];
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("生成 metadata — 选配置 + 填字段");
    contentEl.createEl("p", {
      text: `为 ${this.subject} 里每张图生成一份 sidecar .md；先选解析配置（profile），再填需要现场获得的字段（按文件夹记住，下次自动填上）。`,
    });

    new Setting(contentEl)
      .setName("解析配置（profile）")
      .setDesc("默认按 match 自动预选，选不出来时列出全部；显示 name 并带上 id。")
      .addDropdown((dropdown) => {
        for (const profile of this.profiles) {
          dropdown.addOption(profile.id, `${profile.name}（${profile.id}）`);
        }
        dropdown.setValue(this.selectedProfile.id);
        dropdown.onChange((value) => {
          const found = this.profiles.find((profile) => profile.id === value);
          if (found !== undefined) this.selectedProfile = found;
          // 换 profile ⇒ 模板跟着换成这条 profile 声明的那份（仍可再手动改）。
          this.templateId = this.profileTemplate(this.selectedProfile);
          this.templateDropdown?.setValue(this.templateId);
          this.renderAskFields();
        });
      });

    new Setting(contentEl)
      .setName("metadata 模板")
      .setDesc("sidecar .md 的整份文本；默认取 profile 的 metadataTemplate，按文件夹记住。")
      .addDropdown((dropdown) => {
        for (const entry of listTemplates("metadata", this.host.settings.metadataTemplates)) {
          dropdown.addOption(entry.id, `${entry.name}（${entry.id}${entry.builtin ? " · 内置" : ""}）`);
        }
        dropdown.setValue(this.templateId);
        dropdown.onChange((value) => {
          this.templateId = value;
        });
        this.templateDropdown = dropdown;
      });

    this.askContainer = contentEl.createDiv({ cls: "annex-ask-fields" });
    this.renderAskFields();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("生成元数据").setCta().onClick(() => this.submit()))
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  private renderAskFields(): void {
    this.askContainer.empty();
    this.values = {};
    const ask = askKeysFor(this.selectedProfile);
    for (const key of ask) {
      const prefilled = readAsk(this.host.settings, this.dir, key);
      this.values[key] = prefilled;
      new Setting(this.askContainer).setName(`询问字段：${key}`).addText((text) => {
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
        setTimeout(() => text.inputEl.focus(), 0);
      });
    }
  }

  private submit(): void {
    const ask = askKeysFor(this.selectedProfile);
    for (const key of ask) {
      if ((this.values[key] ?? "").trim() === "") {
        new Notice(`${key} 不能为空`);
        return;
      }
    }
    this.host.settings.folderProfiles[this.dir] = this.selectedProfile.id;
    this.host.settings.folderMetadataTemplates[this.dir] = this.templateId;
    for (const key of ask) {
      writeAsk(this.host.settings, this.dir, key, (this.values[key] ?? "").trim());
    }
    void this.host.saveSettings();
    const values: Record<string, string> = {};
    for (const key of ask) values[key] = (this.values[key] ?? "").trim();
    this.close();
    this.onSubmit(this.selectedProfile, values, this.templateId);
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
    const where = this.subject === "/" ? "仓库根" : this.subject;
    titleEl.setText("生成元数据 — 已有 sidecar，怎么处理？");
    contentEl.createEl("p", {
      text: `${where} 下 ${this.plan.images} 张图里已有 ${this.plan.existing} 份 sidecar${
        this.plan.dirty > 0 ? `，其中 ${this.plan.dirty} 份被改过（git 报脏）` : ""
      }。`,
    });
    contentEl.createEl("p", {
      text: "覆盖重算：按当前 profile 重写这 " + String(this.plan.existing) + " 份 —— 改动模版后重新计算元数据就用它（被改过的那几份也会被覆盖）。",
    });
    contentEl.createEl("p", { text: "只补缺失：已存在的一律不动，只为还没有 sidecar 的图新建。" });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("覆盖重算")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onChoose(true);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("只补缺失")
          .setCta()
          .onClick(() => {
            this.close();
            this.onChoose(false);
          }),
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
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
    const where = this.subject === "/" ? "仓库根" : this.subject;
    titleEl.setText("Drop largefiles — 丢弃本地内容");
    contentEl.createEl("p", {
      text: `${where} 下有 ${this.report.present} 个 annex 文件在本地有内容，共 ${formatBytes(this.report.bytesPresent)}。确认后会丢掉这些内容（腾硬盘）。`,
    });
    contentEl.createEl("p", {
      text: "元数据 .md、缩略图 .thumbnail.png 与 .base 都不进 annex（.gitattributes 里是 annex.largefiles=nothing），所以不会被碰 —— 画廊照旧能看；原图要取回来时用 git annex get。",
    });
    contentEl.createEl("p", {
      text: "git-annex 只会丢「别处有足够副本」的内容：别处没有副本的文件会被拒绝，原样保留（报告里记为「被挡下」）。",
    });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("丢弃")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      )
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class AnnexGalleryPlugin extends Plugin implements SettingsHost {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AnnexGallerySettingTab(this.app, this));

    // 插件加载时扫一遍：当前仓库本来就有 remote（有些仓库确实有），别让它显示成「没有 remote」。
    // 只补设置里没有的，不覆盖同名的；不是 git 仓库就静默跳过。
    void this.scanVaultRemotes()
      .then((added) => {
        if (added > 0) {
          new Notice(`已从当前仓库读到 ${added} 条 remote（设置页「remote 设置」里可见）。`, 8000);
        }
      })
      .catch((error) => console.error(error));

    // 状态栏（spec: docs/status-bar.md）：未提交 / 未跟踪 / 未入库 largefiles。
    // 30 秒轮询 + 点击立即刷新；`registerInterval` 让框架在卸载时替我清掉这个定时器。
    this.setupStatusBar();
    this.registerInterval(window.setInterval(() => void this.refreshStatus(), this.statusRefreshMs));
    void this.refreshStatus();

    // 入口 1：注册命令「初始化 gallery」
    this.addCommand({
      id: "init-gallery",
      name: "初始化 gallery",
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
            { title: "生成元数据", icon: "file-text", run: () => void this.runSidecars(file) },
            { title: "生成缩略图", icon: "image", run: () => void this.runThumbnails(file) },
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

    this.statusTextEl = el.createSpan({ cls: "annex-status-counts", text: "统计中…" });
    this.statusTextEl.setAttr("aria-label", "Annex Gallery：正在统计");

    this.statusRefreshEl = el.createSpan({ cls: "annex-status-refresh" });
    setIcon(this.statusRefreshEl, "refresh-cw");
    this.statusRefreshEl.setAttr("aria-label", "立即刷新");

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
          ? unavailableStatus("", "拿不到 vault 的本地路径（Annex Gallery 只支持桌面版）")
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
    // 顺序不变：用户已有的 data.json 优先，缺失的键才用 DEFAULT_SETTINGS，绝不冲掉现有配置。
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 已废弃的键：.gitattributes / .gitignore 路径与「默认样品名」都不再是设置项
    // （spec: 用默认即可、没有所谓默认样品名）。留在 data.json 里只会误导人，删掉。
    const legacy = this.settings as unknown as Record<string, unknown>;
    delete legacy.gitattributesPath;
    delete legacy.gitignorePath;
    delete legacy.defaultSample;
    // profiles 缺失/非法 → 内置 DEFAULT_PROFILES；并总是深拷贝，免得编辑时改到模块常量。
    const profiles = Array.isArray(this.settings.profiles) ? this.settings.profiles : DEFAULT_PROFILES;
    this.settings.profiles = cloneProfiles(profiles);
    if (this.settings.folderProfiles === null || typeof this.settings.folderProfiles !== "object") {
      this.settings.folderProfiles = {};
    }
    if (this.settings.folderSamples === null || typeof this.settings.folderSamples !== "object") {
      this.settings.folderSamples = {};
    }
    // 模板登记与按文件夹的选择：旧 data.json 没这些键 ⇒ 空。
    const refs = (value: unknown): TemplateRef[] =>
      Array.isArray(value)
        ? value
            .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
            .map((entry) => ({ id: String(entry.id ?? ""), name: String(entry.name ?? entry.id ?? ""), path: String(entry.path ?? "") }))
            .filter((entry) => entry.id !== "" && entry.path !== "")
        : [];
    this.settings.metadataTemplates = refs(this.settings.metadataTemplates);
    this.settings.baseTemplates = refs(this.settings.baseTemplates);
    for (const key of ["folderMetadataTemplates", "folderBaseTemplates"] as const) {
      const value = this.settings[key] as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) this.settings[key] = {};
    }
    // remotes：必须是 { name, url } 数组；旧 data.json 没这个键 ⇒ 空数组。
    if (!Array.isArray(this.settings.remotes)) {
      this.settings.remotes = [];
    } else {
      this.settings.remotes = this.settings.remotes
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({ name: String(entry.name ?? ""), url: String(entry.url ?? "") }));
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 「当前仓库」= the vault this Obsidian window has open (desktop only). */
  vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("Annex Gallery 只支持桌面版：拿不到 vault 的本地路径");
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let electron: { shell?: { openPath(target: string): Promise<string> } } | undefined;
    try {
      electron = require("electron") as typeof electron;
    } catch {
      electron = undefined; // 无头自检环境里没有 electron：往下走 vault 内那条路
    }
    if (electron?.shell?.openPath !== undefined) {
      const failure = await electron.shell.openPath(filePath);
      if (failure === "") return;
      throw new Error(`系统默认应用没能打开它：${failure}`);
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
        `拿不到系统默认应用：require("electron").shell.openPath 不可用，而 ${filePath} 不在 vault 内（app.openWithDefaultApp 只认 vault 相对路径）`,
      );
    }
    throw new Error("拿不到系统默认应用：既没有 electron.shell.openPath，也没有 app.openWithDefaultApp");
  }

  /**
   * 插件加载/打开设置页时扫一遍仓库里的 remote：仓库有、设置里还没有的补进设置（不覆盖同名的）。
   * 返回补进去了几条。vault 不是 git 仓库 / git 不可用 ⇒ 0，不报错。
   */
  async scanVaultRemotes(): Promise<number> {
    let root: string;
    try {
      root = this.vaultRoot();
    } catch {
      return 0;
    }
    const top = git(["rev-parse", "--show-toplevel"], root);
    const repoDir = top.code === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : root;
    const scanned = scanRemotes(repoDir);
    if (scanned.length === 0) return 0;
    const { remotes, added } = mergeScannedRemotes(this.settings.remotes, scanned);
    if (added.length === 0) return 0;
    this.settings.remotes = remotes;
    await this.saveSettings();
    return added.length;
  }

  private folderPath(folder: TFolder): string {
    return path.join(this.vaultRoot(), folder.path === "/" ? "" : folder.path);
  }

  /** Folder → the git work tree containing it (used by the dirty-file guard). */
  private gitTopOf(dir: string): string {
    const result = git(["rev-parse", "--show-toplevel"], dir);
    return result.code === 0 ? result.stdout.trim() : dir;
  }

  private notifyReport(title: string, lines: string[]): void {
    new Notice(`${title}\n${lines.join("\n")}`, 8000);
    for (const line of lines) console.log(progressPrefix(line));
  }

  // ── 入口 1：初始化 gallery ───────────────────────────────────────────────

  private async runInit(): Promise<void> {
    const root = this.vaultRoot();
    try {
      const result = await initGallery(root, {
        remotes: this.settings.remotes,
        progress: (message) => console.log(progressPrefix(message)),
      });
      const remotes = result.remotes;
      const remoteCount = (action: string): number => remotes.filter((entry) => entry.action === action).length;
      this.notifyReport("初始化 gallery 完成", [
        `仓库根：${result.root}`,
        `git init：${result.createdRepo ? "已新建" : "已存在，跳过"}`,
        `git annex init：${result.initedAnnex ? "已执行" : "已是 annex 仓库，跳过"}`,
        `annex.addunlocked：${
          result.shape.addUnlocked.action === "unchanged"
            ? "分支已是 true，未改动"
            : "分支已设为 true（此后 add 的文件以 unlocked 入库）"
        }`,
        ...(result.shape.localRepairs.length === 0
          ? []
          : [
              `本机设置：修 ${result.shape.localRepairs.length} 项（${result.shape.localRepairs
                .map((entry) => `${entry.key}=${entry.previous ?? "(无)"}→${entry.action === "unset" ? "删" : String(entry.standard)}`)
                .join(" · ")}）`,
            ]),
        `.gitattributes：补 ${result.gitattributes.added.length} 条规则`,
        `.gitignore：补 ${result.gitignore.added.length} 条规则`,
        ...(remotes.length === 0
          ? []
          : [
              `remote：新增 ${remoteCount("added")} · 改地址 ${remoteCount("updated")} · 未变 ${remoteCount("unchanged")} · 跳过 ${remoteCount("skipped")} · 失败 ${remoteCount("failed")}`,
            ]),
        ...remotes
          .filter((entry) => entry.action === "failed" || entry.action === "skipped")
          .slice(0, 3)
          .map((entry) => `remote ${entry.name || "(空)"}：${entry.detail ?? entry.action}`),
        ...result.notes,
      ]);
    } catch (error) {
      new Notice(`初始化 gallery 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 入口 2：生成缩略图 ───────────────────────────────────────────────────

  private async runThumbnails(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const progress = new Notice(`生成缩略图：${folder.path}（${this.settings.thumbnailEdge}px）`, 0);
    try {
      const report: ThumbnailReport = await generateThumbnails(dir, {
        edge: this.settings.thumbnailEdge,
        progress: (message) => console.log(progressPrefix(message)),
      });
      progress.hide();
      this.notifyReport("生成缩略图完成", [
        `目录：${report.dir}`,
        `边长：${report.edge}px`,
        `新建 ${report.created} · 跳过 ${report.skipped} · 失败 ${report.failed}`,
      ]);
    } catch (error) {
      progress.hide();
      new Notice(`生成缩略图失败：${String(error)}`, 10000);
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
    const where = folder.path === "/" ? "仓库根" : folder.path;
    const title = ANNEX_OP_TITLE[op];
    const notice = new Notice(`${title}：${where} …`, 0);
    const progress = (message: string): void => {
      notice.setMessage(message);
      console.log(progressPrefix(message));
    };
    try {
      const report: AnnexReport = await runAnnexOp(op, dir, { progress });
      notice.hide();
      this.notifyReport(`${title} 完成`, this.annexReportLines(op, where, report));
    } catch (error) {
      notice.hide();
      new Notice(`${title} 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  /** 每个操作自带一句「按完之后要知道什么」。 */
  private annexReportLines(op: AnnexOp, where: string, report: AnnexReport): string[] {
    const lines = [
      `目录：${where}`,
      `annex 报出动作 ${report.ok} 个${
        report.skipped > 0 ? ` · 被挡下 ${report.skipped} 个` : ""
      }（别处无足够副本）· 失败 ${report.failed} 个 —— 不需要动的文件不会出现在输出里`,
    ];
    if (op === "add" && report.candidates !== undefined) {
      lines.push(`候选图片 ${report.candidates} 张 —— 按 .gitattributes 的 annex.largefiles 决定谁进 annex、谁进 git`);
      lines.push("提示：新增/暂存的改动还要 commit 一次才算落进历史。");
    }
    if (op === "get" && report.candidates !== undefined) {
      lines.push(`本地缺内容 ${report.candidates} 个（内容已在本地的不受影响）`);
    }
    if (op === "drop" && report.bytesFreed !== undefined && report.bytesFreed > 0) {
      lines.push(`释放 ${formatBytes(report.bytesFreed)}`);
    }
    if (op === "unannex") {
      if (report.staged !== undefined) {
        lines.push(`已按普通 git 文件暂存 ${report.staged} 个（git annex add --force-small）—— 还需要一次 commit`);
      }
      lines.push("现在这些文件由 git 直接管理，不再走 annex。");
    }
    if (op === "lock") {
      lines.push("注意：lock 后工作树里是软链，Obsidian 会静默不索引这些文件（原图链接会失效）；要复原用 Unlock largefiles。");
    }
    if (op === "unlock") {
      lines.push("现在工作树里是实文件（index 100644），Obsidian 能正常索引。");
    }
    const failed = report.entries.filter((entry) => entry.action === "failed");
    for (const entry of failed.slice(0, 3)) lines.push(`失败：${entry.file}（${entry.detail ?? ""}）`);
    return lines;
  }

  // ── 入口 3：生成元数据（sidecar .md；可重跑，会问是否覆盖）────────────────

  private async runSidecars(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const relpath = folder.path === "/" ? "" : folder.path;
    new SamplePromptModal(this.app, folder.path, this, dir, relpath, (profile, values, templateId) => {
      void this.generateSidecarsWithPrompt(folder, dir, profile, values, templateId);
    }).open();
  }

  /**
   * 「生成元数据」可以重跑（用户 2026-10-17 口径）：改动模版（profile）后要重算，所以先**只读**数一下
   * 已存在的 sidecar（`planSidecarTargets`，不写盘），有的话问一句「覆盖重算 / 只补缺失 / 取消」。
   */
  private async generateSidecarsWithPrompt(
    folder: TFolder,
    dir: string,
    profile: ParseProfile,
    values: Record<string, string>,
    templateId: string,
  ): Promise<void> {
    // 坏模板（文件没了 / 第一行不是 {{frontmatter}}）在任何写盘之前就停下，不静默回退。
    let template: ResolvedTemplate;
    try {
      template = resolveTemplate("metadata", templateId, this.settings.metadataTemplates, this.vaultRoot());
      checkMetadataTemplate(template);
    } catch (error) {
      new Notice(`生成元数据失败：${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error(error);
      return;
    }
    let plan: SidecarPlan;
    try {
      plan = planSidecarTargets(dir, this.gitTopOf(dir));
    } catch (error) {
      console.error(error);
      plan = { images: 0, existing: 0, dirty: 0 };
    }
    if (plan.existing === 0) {
      await this.executeSidecars(folder, dir, profile, values, template, false);
      return;
    }
    new OverwritePromptModal(this.app, folder.path, plan, (overwrite) => {
      void this.executeSidecars(folder, dir, profile, values, template, overwrite);
    }).open();
  }

  private async executeSidecars(
    folder: TFolder,
    dir: string,
    profile: ParseProfile,
    values: Record<string, string>,
    template: ResolvedTemplate,
    overwrite: boolean,
  ): Promise<void> {
    // profile 选择与 ask 值已由弹窗写进 folderProfiles / folderSamples 并落盘。
    const ask = askKeysFor(profile);
    const sample = (values["sample"] ?? values[ask[0]] ?? "").trim();
    const summary = ask.map((key) => `${key}=${values[key] ?? ""}`).join(" · ");
    const progress = new Notice(`生成元数据：${folder.path}（${profile.name}｜${summary}${overwrite ? "｜覆盖重算" : ""}）`, 0);
    try {
      const report: SidecarReport = await generateSidecars(dir, {
        vaultRoot: this.vaultRoot(),
        repoRoot: this.gitTopOf(dir),
        sample,
        // 弹窗里选的 profile / 填的 ask / 选的模板都要传下去（之前漏传，弹窗的 profile 选择不生效）。
        profile,
        profiles: this.settings.profiles,
        ask: values,
        template,
        apply: true,
        overwrite,
        progress: (message) => console.log(progressPrefix(message)),
      });
      progress.hide();
      const count = (action: string): number => report.entries.filter((entry) => entry.action === action).length;
      const lines = [
        `目录：${report.dir}`,
        `新建 ${count("created")} 份 · 覆盖 ${count("overwritten")} 份 · 跳过（已存在）${count("skipped-existing")} · 跳过（被改过）${count("skipped-dirty")} · 失败 ${count("failed")}`,
      ];
      lines.push(`模板：${template.label}`);
      if (overwrite) lines.push("模式：覆盖重算（已存在的 sidecar 全部按当前 profile 重写）");
      const templateNotes = report.entries.filter((entry) => (entry.detail ?? "").includes("模板里的"));
      if (templateNotes.length > 0) lines.push(`${templateNotes.length} 份里有模板占位符取不到值（已留空，详见控制台）`);
      const collisions = Object.entries(report.duplicateStems);
      if (collisions.length > 0) lines.push(`重名 stem ${collisions.length} 个 —— 链接已按全 vault 路径写入`);
      const failed = report.entries.filter((entry) => entry.action === "failed");
      for (const entry of failed.slice(0, 3)) lines.push(`失败：${path.basename(entry.sidecar)}（${entry.detail ?? ""}）`);
      this.notifyReport("生成元数据完成", lines);
    } catch (error) {
      progress.hide();
      new Notice(`生成元数据失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 创建画廊 / Create Gallery（spec: docs/gallery.md）──────────────────────

  /**
   * 选模板（多于一份才问，按文件夹记住）→ 填模板（坏模板在这里就停）→ 只读盘点 →
   * 有旧 sidecar 没标签就问「补标签 / 跳过 / 取消」→ 目标已存在就问「覆盖 / 打开已有 / 取消」→ 写 → 打开。
   */
  private async runGallery(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const options = listTemplates("base", this.settings.baseTemplates);
    const go = (id: string): void => {
      this.settings.folderBaseTemplates[dir] = id;
      void this.saveSettings();
      void this.prepareGallery(folder, dir, id);
    };
    if (options.length <= 1) {
      go(options[0]?.id ?? DEFAULT_TEMPLATE_ID);
      return;
    }
    new GalleryTemplateModal(this.app, folder.path, options, this.settings.folderBaseTemplates[dir], go).open();
  }

  private async prepareGallery(folder: TFolder, dir: string, templateId: string): Promise<void> {
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
        this.settings.profiles.map((profile) => profile.keyOrder),
      );
      built = buildGalleryBase(template, { folder: relFolder, cardSize: this.settings.thumbnailEdge, properties });
    } catch (error) {
      new Notice(`${title}失败：${error instanceof Error ? error.message : String(error)}`, 10000);
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
      new ChoiceModal(this.app, `${title} — ${target} 已存在`, [`${target} 已经存在。覆盖会用模板重写整份文件（手改过的视图会丢）。`], [
        { text: "覆盖", style: "warning", run: write },
        { text: "打开已有", style: "cta", run: () => void this.openVaultFile(target) },
        { text: "取消" },
      ]).open();
    };

    if (plan.untagged.length === 0) {
      afterTags(false);
      return;
    }
    new ChoiceModal(
      this.app,
      `${title} — 有 ${plan.untagged.length} 份旧 sidecar 没有标签`,
      [
        `${folder.path} 下有 ${plan.untagged.length} 份 sidecar（带 tif）还没有 annex-gallery-metadata 标签，画廊只认这个标签，它们不会出现。`,
        "补标签：只在 tags 里加这一项，别的内容一个字都不动。",
      ],
      [
        { text: "补标签", style: "cta", run: () => afterTags(true) },
        { text: "跳过", run: () => afterTags(false) },
        { text: "取消" },
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
        `画廊：${target}（模板：${label}）`,
        `进画廊的 sidecar ${plan.tagged + fixed} 份${fixed > 0 ? `（其中补标签 ${fixed} 份）` : ""}${
          !fixTags && plan.untagged.length > 0 ? ` · 没标签、不显示 ${plan.untagged.length} 份` : ""
        }`,
      ];
      if (plan.missingSidecars > 0) lines.push(`${plan.missingSidecars} 张图还没有 sidecar —— 先跑「生成元数据」`);
      if (plan.missingThumbnails > 0) lines.push(`${plan.missingThumbnails} 份 sidecar 缺缩略图 —— 先跑「生成缩略图」`);
      if (built.missing.length > 0) lines.push(`模板占位符取不到值、已留空：${built.missing.map((name) => `{{${name}}}`).join(" ")}`);
      this.notifyReport(`${title}完成`, lines);
    } catch (error) {
      new Notice(`${title}失败：${error instanceof Error ? error.message : String(error)}`, 10000);
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
    const where = folder.path === "/" ? "仓库根" : folder.path;
    try {
      const preview = await dropLargefiles(dir, { dryRun: true, progress: (m) => console.log(progressPrefix(m)) });
      if (preview.present === 0) {
        new Notice(
          `Drop largefiles：${where} 没有可丢的本地 annex 内容（已经丢过，或这里没有 annex 文件）`,
          8000,
        );
        return;
      }
      new DropConfirmModal(this.app, folder.path, preview, () => {
        void this.executeDrop(dir, where, preview.present);
      }).open();
    } catch (error) {
      new Notice(`Drop largefiles 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  private async executeDrop(dir: string, where: string, expected: number): Promise<void> {
    const progress = new Notice(`Drop largefiles：正在丢弃 ${where} 的 ${expected} 个文件的本地内容…`, 0);
    try {
      const report: DropReport = await dropLargefiles(dir, {
        progress: (message) => console.log(progressPrefix(message)),
      });
      progress.hide();
      const lines = [
        `目录：${where}`,
        `丢弃 ${report.dropped} 个 · 释放 ${formatBytes(report.bytesFreed)}`,
        `被挡下（别处无足够副本）${report.skipped} 个 · 失败 ${report.failed} 个`,
      ];
      const failed = report.entries.filter((entry) => entry.action === "failed");
      for (const entry of failed.slice(0, 3)) lines.push(`失败：${entry.file}（${entry.detail ?? ""}）`);
      this.notifyReport("Drop largefiles 完成", lines);
    } catch (error) {
      progress.hide();
      new Notice(`Drop largefiles 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }
}
