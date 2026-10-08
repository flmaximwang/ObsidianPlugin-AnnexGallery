import * as path from "path";
import { FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFolder } from "obsidian";
import { initGallery } from "./src/core/init";
import { SidecarReport, generateSidecars } from "./src/core/sidecar";
import { ThumbnailReport, generateThumbnails } from "./src/core/thumbnails";
import { progressPrefix } from "./src/core/types";
import { AnnexGallerySettingTab, DEFAULT_SETTINGS, PluginSettings, SettingsHost } from "./src/ui/settings";

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
            .setTitle("使用 Annex Gallery 管理")
            .setIcon("gallery-thumbnails")
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
        progress: (m) => console.log(progressPrefix(m)),
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
    new Notice(`生成缩略图：${dir}（${this.settings.thumbnailEdge}px）`);
    try {
      const report: ThumbnailReport = await generateThumbnails(dir, {
        edge: this.settings.thumbnailEdge,
        progress: (m) => console.log(progressPrefix(m)),
      });
      this.notifyReport("生成缩略图完成", [
        `目录：${report.dir}`,
        `边长：${report.edge}px`,
        `新建 ${report.created} · 跳过 ${report.skipped} · 失败 ${report.failed}`,
      ]);
    } catch (error) {
      new Notice(`生成缩略图失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  // ── 入口 3：使用 Annex Gallery 管理（sidecar .md） ───────────────────────

  private async runSidecars(folder: TFolder): Promise<void> {
    const dir = this.folderPath(folder);
    const sample = this.settings.folderSamples[dir] ?? this.settings.defaultSample;
    if (sample === "") {
      new Notice(`请先在「Annex Gallery」设置里填写「默认样品名」，再对 ${folder.path} 运行本命令。`, 10000);
      return;
    }
    try {
      const report: SidecarReport = await generateSidecars(dir, {
        vaultRoot: this.vaultRoot(),
        repoRoot: await this.gitRootOf(dir),
        sample,
        apply: true,
        progress: (m) => console.log(progressPrefix(m)),
      });
      const lines = [
        `目录：${report.dir}`,
        `写入 ${report.entries.filter((e) => e.action === "created").length} 份 sidecar`,
        `跳过（盘上已脏）${report.entries.filter((e) => e.action === "skipped-dirty").length} 份`,
        `失败 ${report.entries.filter((e) => e.action === "failed").length} 份`,
      ];
      const collisions = Object.entries(report.duplicateStems);
      if (collisions.length > 0) lines.push(`重名 stem ${collisions.length} 个——链接已按全 vault 路径写入`);
      this.notifyReport("使用 Annex Gallery 管理完成", lines);
    } catch (error) {
      new Notice(`生成 sidecar 失败：${String(error)}`, 10000);
      console.error(error);
    }
  }

  private async gitRootOf(dir: string): Promise<string> {
    return dir;
  }
}
