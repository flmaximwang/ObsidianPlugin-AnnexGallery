import * as path from "path";
import { App, FileSystemAdapter, Menu, Modal, Notice, Plugin, Setting, TAbstractFile, TFolder } from "obsidian";
import { git } from "./src/core/git";
import { initGallery } from "./src/core/init";
import { SidecarReport, generateSidecars } from "./src/core/sidecar";
import { ThumbnailReport, generateThumbnails } from "./src/core/thumbnails";
import { progressPrefix } from "./src/core/types";

import {
  DEFAULT_ASK,
  DEFAULT_PROFILES,
  type ParseContext,
  type ParseProfile,
  pickProfile,
} from "./src/core/profiles";
import {
  AnnexGallerySettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
  SettingsHost,
  cloneProfiles,
  readAsk,
  writeAsk,
} from "./src/ui/settings";

/** 弹窗提交时用的 profile 与其 ask 键 → 值。 */
type PromptSubmit = (profile: ParseProfile, values: Record<string, string>) => void;

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
          this.renderAskFields();
        });
      });

    this.askContainer = contentEl.createDiv({ cls: "annex-ask-fields" });
    this.renderAskFields();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("生成 metadata").setCta().onClick(() => this.submit()))
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
    for (const key of ask) {
      writeAsk(this.host.settings, this.dir, key, (this.values[key] ?? "").trim());
    }
    if (ask.includes("sample")) {
      this.host.settings.defaultSample = (this.values["sample"] ?? "").trim();
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

export default class AnnexGalleryPlugin extends Plugin implements SettingsHost {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AnnexGallerySettingTab(this.app, this));

    // 入口 1：注册命令「初始化 gallery」
    this.addCommand({
      id: "init-gallery",
      name: "初始化 gallery",
      callback: () => {
        void this.runInit();
      },
    });

    // 入口 2 / 3：右键文件夹菜单
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("生成缩略图")
            .setIcon("image")
            .onClick(() => {
              void this.runThumbnails(file);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("使用 Annex Gallery 管理（生成 metadata）")
            .setIcon("file-text")
            .onClick(() => {
              void this.runSidecars(file);
            }),
        );
      }),
    );
  }

  onunload(): void {
    // nothing to tear down: no long-lived processes, no open handles
  }

  // ── settings plumbing ────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    // 顺序不变：用户已有的 data.json 优先，缺失的键才用 DEFAULT_SETTINGS，绝不冲掉现有配置。
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // profiles 缺失/非法 → 内置 DEFAULT_PROFILES；并总是深拷贝，免得编辑时改到模块常量。
    const profiles = Array.isArray(this.settings.profiles) ? this.settings.profiles : DEFAULT_PROFILES;
    this.settings.profiles = cloneProfiles(profiles);
    if (this.settings.folderProfiles === null || typeof this.settings.folderProfiles !== "object") {
      this.settings.folderProfiles = {};
    }
    if (this.settings.folderSamples === null || typeof this.settings.folderSamples !== "object") {
      this.settings.folderSamples = {};
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
        gitattributesPath: this.settings.gitattributesPath || undefined,
        gitignorePath: this.settings.gitignorePath || undefined,
        progress: (message) => console.log(progressPrefix(message)),
      });
      this.notifyReport("初始化 gallery 完成", [
        `仓库根：${result.root}`,
        `git init：${result.createdRepo ? "已新建" : "已存在，跳过"}`,
        `git annex init：${result.initedAnnex ? "已执行" : "已是 annex 仓库，跳过"}`,
        `.gitattributes：补 ${result.gitattributes.added.length} 条规则`,
        `.gitignore：补 ${result.gitignore.added.length} 条规则`,
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

  // ── 入口 3：使用 Annex Gallery 管理（sidecar .md） ───────────────────────

  private async runSidecars(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const relpath = folder.path === "/" ? "" : folder.path;
    new SamplePromptModal(this.app, folder.path, this, dir, relpath, (profile, values) => {
      void this.executeSidecars(folder, dir, profile, values);
    }).open();
  }

  private async executeSidecars(
    folder: TFolder,
    dir: string,
    profile: ParseProfile,
    values: Record<string, string>,
  ): Promise<void> {
    // profile 选择与 ask 值已由弹窗写进 folderProfiles / folderSamples 并落盘。
    const ask = askKeysFor(profile);
    const sample = (values["sample"] ?? values[ask[0]] ?? "").trim();
    const summary = ask.map((key) => `${key}=${values[key] ?? ""}`).join(" · ");
    const progress = new Notice(`生成 metadata：${folder.path}（${profile.name}｜${summary}）`, 0);
    try {
      const report: SidecarReport = await generateSidecars(dir, {
        vaultRoot: this.vaultRoot(),
        repoRoot: this.gitTopOf(dir),
        sample,
        apply: true,
        progress: (message) => console.log(progressPrefix(message)),
      });
      progress.hide();
      const count = (action: string): number => report.entries.filter((entry) => entry.action === action).length;
      const lines = [
        `目录：${report.dir}`,
        `新建 ${count("created")} 份 · 跳过（已存在）${count("skipped-existing")} · 跳过（被改过）${count("skipped-dirty")} · 失败 ${count("failed")}`,
      ];
      const collisions = Object.entries(report.duplicateStems);
      if (collisions.length > 0) lines.push(`重名 stem ${collisions.length} 个 —— 链接已按全 vault 路径写入`);
      const failed = report.entries.filter((entry) => entry.action === "failed");
      for (const entry of failed.slice(0, 3)) lines.push(`失败：${path.basename(entry.sidecar)}（${entry.detail ?? ""}）`);
      this.notifyReport("使用 Annex Gallery 管理完成", lines);
    } catch (error) {
      progress.hide();
      new Notice(`生成 metadata 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }
}
