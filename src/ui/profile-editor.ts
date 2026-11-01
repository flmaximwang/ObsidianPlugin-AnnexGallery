/**
 * 设置页的「元数据预设」区 —— 外部 JSON 文件管理（spec-774d7ee / ticket qij）。
 *
 * 冻结口径：
 * - 一条元数据预设 = vault 里一个独立的 `.json` 文件，顶层是一条 `ParseProfile` 对象；
 *   设置里只登记路径（`settings.profileFiles`），name / id / frontmatter 全部以 JSON 内容为准。
 * - 每行显示 外部 JSON 的 name / id / path，并提供「打开」「删除」；删除只取消登记。
 * - 逐行用 `inspectProfileFile` 检查（**不抛错**）：error 级问题把整行标红（`data-state="error"`），
 *   warn 级问题单独一行提示（`.annex-profile-warn`），不阻塞这一行 —— 坏行照样能「打开」去修、
 *   能「删除」取消登记。旧格式的 JSON 会在这里报出 `inspectProfileFile` 给的迁移提示。
 * - 「从预设创建」写两份文件：正文 `AnnexGalleryTemplates/<preset-id>.md`（素材有正文才写）与
 *   预设本身 `AnnexGalleryTemplates/<preset-id>.json`；路径冲突由 `createVaultFile` 加序号（不覆盖）。
 *   JSON 里的 `template` 写成正文**实际**落盘的路径；没有正文时写成空串（sidecar 只有 frontmatter）。
 * - 写文件前先用 `loadProfileFiles` 读全部已登记文件：任何一份坏了/重复 id 都整体失败，
 *   绝不跳过坏文件去猜 id 是否重复；id 撞了就为待创建对象生成唯一 id（名称标副本）。
 * - 运行时没有内置/预设 fallback；预设只是「从预设创建」的素材。
 */
import { Notice } from "obsidian";
import { normalizeVaultRelPath, resolveVaultFile } from "../core/external-files";
import {
  inspectProfileFile,
  loadProfileFiles,
  type ProfileFileRef,
  type ProfileInspection,
} from "../core/profile-files";
import { PRESET_PROFILES, presetJsonText, type ProfilePreset } from "../core/presets";
import type { PluginSettings } from "./settings";
import { TEMPLATE_FOLDER } from "./templates-editor";

export interface ProfileEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  vaultRoot(): string;
  /** 用系统默认外部应用打开一个本地绝对路径；失败时 throw。 */
  openWithDefaultApp(filePath: string): Promise<void>;
  /** 在 vault 里新建文件（被占用时自动加后缀），返回实际写入的 vault 相对路径。 */
  createVaultFile(relPath: string, text: string): Promise<string>;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 路径规范化；非法路径（越界/绝对路径）返回 null，仅用于重复比较的尽力而为。 */
function normalizedOrNull(raw: string): string | null {
  try {
    return normalizeVaultRelPath(raw);
  } catch {
    return null;
  }
}

/** 唯一 id：撞了就加 `-2`、`-3`…（从预设创建时用）。 */
function uniqueId(existing: Iterable<string>, base: string): string {
  const ids = new Set(existing);
  const seed = base.trim() === "" ? "profile" : base.trim();
  if (!ids.has(seed)) return seed;
  let n = 2;
  while (ids.has(`${seed}-${n}`)) n += 1;
  return `${seed}-${n}`;
}

/** 一行登记项 + 本次的检查结果。坏文件也有 `inspection`（只是 issues 里有 error）。 */
interface ProfileRow {
  index: number;
  ref: ProfileFileRef;
  /** 逐文件检查结果（读不了文件时为 null）。 */
  inspection: ProfileInspection | null;
  /** error 级问题：整行标红。 */
  error?: string;
  /** warn 级问题：单独一行提示，不阻塞这一行。 */
  warnings: string[];
}

export class ProfileEditor {
  constructor(
    private readonly container: HTMLElement,
    private readonly host: ProfileEditorHost,
  ) {}

  render(): void {
    this.container.empty();
    const root = this.container.createDiv({ cls: "annex-profiles" });

    this.renderToolbar(root);
    const list = root.createDiv({ cls: "annex-profile-list" });
    const refs = this.host.settings.profileFiles;

    let vaultRoot: string | null = null;
    let rootError = "";
    try {
      vaultRoot = this.host.vaultRoot();
    } catch (error) {
      rootError = `读不了 vault 路径：${errText(error)}`;
    }

    const rows = this.buildRows(refs, vaultRoot, rootError);

    if (refs.length === 0) {
      if (rootError !== "") list.createDiv({ cls: "annex-profiles-error", text: rootError });
      list.createDiv({
        cls: "annex-profiles-empty",
        text:
          "还没有登记元数据预设。填 vault 里的 .json 路径点「登记」，或用「从预设创建…」生成一份" +
          "（frontmatter 与可选的正文模板都写在这份 .json 里）。",
      });
      return;
    }

    for (const row of rows) this.renderRow(list, row);
  }

  /** 工具条：路径输入 + 登记 + 从预设创建。 */
  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "annex-profiles-toolbar" });

    const input = toolbar.createEl("input", { cls: "annex-profile-path-input", type: "text" });
    input.setAttr(
      "placeholder",
      "vault 里的元数据预设路径（.json，一条预设一个文件；frontmatter / 正文模板写在文件里）",
    );

    const register = toolbar.createEl("button", { cls: "annex-profile-register", text: "登记" });
    const submit = (): void => void this.register(input.value);
    register.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    const presetSelect = toolbar.createEl("select", { cls: "dropdown annex-profile-preset" });
    presetSelect.createEl("option", { text: "从预设创建…", value: "" });
    for (const preset of PRESET_PROFILES) {
      presetSelect.createEl("option", { text: `${preset.name}（${preset.id}）`, value: preset.id });
    }
    presetSelect.addEventListener("change", () => {
      const chosen = PRESET_PROFILES.find((preset) => preset.id === presetSelect.value);
      presetSelect.value = "";
      if (chosen !== undefined) void this.createFromPreset(chosen);
    });
  }

  /** 逐行检查：error → 整行错误；warn → 单独一行提示。 */
  private buildRows(
    refs: readonly ProfileFileRef[],
    vaultRoot: string | null,
    rootError: string,
  ): ProfileRow[] {
    const rows: ProfileRow[] = refs.map((ref, index) => {
      if (vaultRoot === null) return { index, ref, inspection: null, error: rootError, warnings: [] };
      const inspection = inspectProfileFile(vaultRoot, ref.path);
      const errors = inspection.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => issue.message);
      const warnings = inspection.issues
        .filter((issue) => issue.level === "warn")
        .map((issue) => issue.message);
      return {
        index,
        ref,
        inspection,
        ...(errors.length > 0 ? { error: errors.join("；") } : {}),
        warnings,
      };
    });
    this.markDuplicateIds(rows);
    return rows;
  }

  /** 跨文件 id 重复：两条都标成错误行（仍保留 path 与「打开」）。 */
  private markDuplicateIds(rows: ProfileRow[]): void {
    const pathsById = new Map<string, string[]>();
    for (const row of rows) {
      const id = this.rowId(row);
      if (id === undefined) continue;
      pathsById.set(id, [...(pathsById.get(id) ?? []), row.ref.path]);
    }
    for (const row of rows) {
      const id = this.rowId(row);
      if (id === undefined) continue;
      const paths = pathsById.get(id) ?? [];
      if (paths.length > 1) {
        row.error = `元数据预设 id「${id}」重复登记：${paths.join("、")}（请删掉多余的一条，或修改其中一份 JSON 的 id）`;
      }
    }
  }

  /** 行上的预设 id（文件坏了 / id 不是字符串时没有）。 */
  private rowId(row: ProfileRow): string | undefined {
    const id = row.inspection?.profile?.id;
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  }

  private renderRow(parent: HTMLElement, row: ProfileRow): void {
    const el = parent.createDiv({ cls: "annex-profile-row" });
    el.setAttr("data-profile-path", row.ref.path);
    el.setAttr("data-state", row.error === undefined ? "ok" : "error");
    const id = this.rowId(row);
    if (id !== undefined) el.setAttr("data-profile-id", id);
    if (row.error !== undefined) el.addClass("annex-profile-row-error");

    const rawName = row.inspection?.profile?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    el.createSpan({ cls: "annex-profile-name", text: name === "" ? "（未命名）" : name });
    if (id !== undefined) {
      el.createSpan({ cls: "annex-profile-id", text: `id: ${id}` });
    }
    el.createSpan({ cls: "annex-profile-path", text: row.ref.path });

    const open = el.createEl("button", { cls: "annex-profile-open", text: "打开" });
    open.setAttr("aria-label", "用系统默认应用打开这份 JSON（改完在设置页重新读取即可生效）");
    open.addEventListener("click", () => void this.open(row.ref));

    const remove = el.createEl("button", { cls: "annex-profile-del mod-warning", text: "删除" });
    remove.setAttr("aria-label", "取消登记（不删除文件）");
    remove.addEventListener("click", () => void this.unregister(row.index));

    if (row.error !== undefined) {
      el.createDiv({ cls: "annex-profile-error", text: row.error });
    }
    for (const warning of row.warnings) {
      el.createDiv({ cls: "annex-profile-warn", text: warning });
    }
  }

  /** 登记一个已有文件：路径安全 + 扩展名 + 存在性 + 重复路径。 */
  private async register(raw: string): Promise<void> {
    let relPath: string;
    try {
      relPath = resolveVaultFile(this.host.vaultRoot(), raw, "profile").relPath;
    } catch (error) {
      new Notice(`登记失败：${errText(error)}`, 10000);
      return;
    }

    const duplicate = this.host.settings.profileFiles.some(
      (ref) => ref.path === relPath || normalizedOrNull(ref.path) === relPath,
    );
    if (duplicate) {
      new Notice(`这个文件已经登记过：${relPath}`);
      return;
    }

    this.host.settings.profileFiles.push({ path: relPath });
    await this.host.saveSettings();
    this.render();
    new Notice(`已登记：${relPath}`);
  }

  /**
   * 从预设创建一份独立的 JSON（外加可选的正文 `.md`）。
   *
   * 写盘前读取全部已登记文件：只要有一份坏掉/重复 id 就整体失败（错误可见），
   * 不跳过坏条目去猜 id 冲突；全部有效时再为待创建对象生成唯一 id。
   *
   * 正文先写：JSON 里的 `template` 必须写正文**实际**落盘的路径（重名时 `createVaultFile`
   * 会加序号）；没有正文素材时 `template` 写成空串（sidecar 只有 frontmatter）。
   */
  private async createFromPreset(preset: ProfilePreset): Promise<void> {
    try {
      const loaded = loadProfileFiles(this.host.vaultRoot(), this.host.settings.profileFiles);
      const id = uniqueId(
        loaded.map((entry) => entry.profile.id),
        preset.id,
      );
      const name = id === preset.id ? preset.name : `${preset.name}（副本）`;

      let templatePath = "";
      if (preset.body !== undefined) {
        templatePath = await this.host.createVaultFile(`${TEMPLATE_FOLDER}/${preset.id}.md`, preset.body);
      }

      const jsonText = presetJsonText({ ...preset, profile: { ...preset.profile, id, name } }, templatePath);
      const relPath = await this.host.createVaultFile(`${TEMPLATE_FOLDER}/${preset.id}.json`, jsonText);
      this.host.settings.profileFiles.push({ path: relPath });
      await this.host.saveSettings();
      this.render();
      new Notice(`已从预设创建：${relPath}`);
    } catch (error) {
      new Notice(`从预设创建失败：${errText(error)}`, 12000);
    }
  }

  /** 用系统默认应用打开登记的文件；打开前重新做路径/存在性检查，失败绝不自动创建。 */
  private async open(ref: ProfileFileRef): Promise<void> {
    try {
      const file = resolveVaultFile(this.host.vaultRoot(), ref.path, "profile");
      await this.host.openWithDefaultApp(file.absPath);
    } catch (error) {
      new Notice(`打不开「${ref.path}」：${errText(error)}`, 12000);
    }
  }

  /** 删除只取消登记，文件保留。 */
  private async unregister(index: number): Promise<void> {
    const target = this.host.settings.profileFiles[index];
    if (target === undefined) return;
    this.host.settings.profileFiles.splice(index, 1);
    await this.host.saveSettings();
    this.render();
    new Notice(`已取消登记（文件未删除）：${target.path}`);
  }
}
