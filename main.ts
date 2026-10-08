import * as path from "path";
import { App, FileSystemAdapter, Menu, Modal, Notice, Plugin, Setting, TAbstractFile, TFolder } from "obsidian";
import { git } from "./src/core/git";
import { initGallery } from "./src/core/init";
import { SidecarReport, generateSidecars } from "./src/core/sidecar";
import { ThumbnailReport, generateThumbnails } from "./src/core/thumbnails";
import { progressPrefix } from "./src/core/types";
import { AnnexGallerySettingTab, DEFAULT_SETTINGS, PluginSettings, SettingsHost } from "./src/ui/settings";

/** Asks for the `sample` name before generating sidecars; remembered per folder. */
class SamplePromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly subject: string,
    initial: string,
    private readonly onSubmit: (sample: string) => void,
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("生成 metadata — 样品名");
    contentEl.createEl("p", {
      text: `为 ${this.subject} 里每张图生成一份 sidecar .md，需要一个样品名写进 sample 字段（按文件夹记住，下次自动填上）。`,
    });

    new Setting(contentEl).setName("样品名").addText((text) => {
      text.setValue(this.value);
      text.onChange((value) => {
        this.value = value;
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.submit();
        }
      });
      setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("生成 metadata").setCta().onClick(() => this.submit()))
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
  }

  private submit(): void {
    const sample = this.value.trim();
    if (sample === "") {
      new Notice("样品名不能为空");
      return;
    }
    this.close();
    this.onSubmit(sample);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    const remembered = this.settings.folderSamples[dir] ?? this.settings.defaultSample;
    new SamplePromptModal(this.app, folder.path, remembered, (sample) => {
      void this.executeSidecars(folder, dir, sample);
    }).open();
  }

  private async executeSidecars(folder: TFolder, dir: string, sample: string): Promise<void> {
    this.settings.folderSamples[dir] = sample;
    this.settings.defaultSample = sample;
    await this.saveSettings();

    const progress = new Notice(`生成 metadata：${folder.path}（sample=${sample}）`, 0);
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
