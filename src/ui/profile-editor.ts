/**
 * 设置页的「文件名匹配模板」区 —— 外部 JSON 文件管理（spec-774d7ee / ticket 2133603）。
 *
 * 冻结口径：
 * - 每条模板 = vault 里一个独立的 `.json` 文件，顶层是一条 `ParseProfile` 对象；
 *   设置里只登记路径（`settings.profileFiles`），name/id 全部以 JSON 内容为准。
 * - 每行显示 外部 JSON 的 name / id / path，并提供「打开」「删除」；删除只取消登记。
 * - 登记时校验路径安全性（vault 内相对路径、`.json`）与文件存在性，并拒绝重复路径。
 * - 「从预设创建」每次写一个独立文件到 `AnnexGalleryTemplates/<preset-id>.json`；
 *   路径冲突由 `createVaultFile` 加序号（不覆盖），创建后不自动打开。
 *   写文件前先用 `loadProfileFiles` 读全部已登记文件：任何一份坏了/重复 id 都整体失败，
 *   绝不跳过坏文件去猜 id 是否重复；id 撞了就为待创建对象生成唯一 id（名称标副本）。
 * - 逐行独立读取：一份坏文件只让那一行显示错误，不影响其它行，也不阻止「打开」去修它。
 * - 运行时没有内置/预设 fallback；预设只是「从预设创建」的素材。
 *
 * 旧的内联 textarea / 临时缓冲文件回同步 / 预览 / 逐条保存与复制都已删除。
 */
import { Notice } from "obsidian";
import { normalizeVaultRelPath, resolveVaultFile } from "../core/external-files";
import { loadProfileFile, loadProfileFiles, type LoadedProfile, type ProfileFileRef } from "../core/profile-files";
import { DEFAULT_PROFILES, TEMPLATE_PROFILE, type ParseProfile } from "../core/profiles";
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

/** 「从预设创建」可选的素材：空白示例 + 内置默认 profile。 */
const PROFILE_PRESETS: ParseProfile[] = [TEMPLATE_PROFILE, ...DEFAULT_PROFILES];

/** 深拷贝一条 profile —— 创建副本时绝不能改到 core 里的 preset 对象。 */
export function cloneProfile(profile: ParseProfile): ParseProfile {
  return JSON.parse(JSON.stringify(profile)) as ParseProfile;
}

export function cloneProfiles(profiles: ParseProfile[]): ParseProfile[] {
  return profiles.map(cloneProfile);
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

/** 一行登记项 + 本次读取结果。坏文件只有 `error`，其余字段为空。 */
interface ProfileRow {
  index: number;
  ref: ProfileFileRef;
  loaded?: LoadedProfile;
  error?: string;
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

    const rows: ProfileRow[] = refs.map((ref, index) => {
      if (vaultRoot === null) return { index, ref, error: rootError };
      try {
        return { index, ref, loaded: loadProfileFile(vaultRoot, ref.path) };
      } catch (error) {
        return { index, ref, error: errText(error) };
      }
    });
    this.markDuplicateIds(rows);

    if (refs.length === 0) {
      if (rootError !== "") list.createDiv({ cls: "annex-profiles-error", text: rootError });
      list.createDiv({
        cls: "annex-profiles-empty",
        text: "还没有登记文件名匹配模板。填 vault 里的 .json 路径点「登记」，或用「从预设创建…」生成一份。",
      });
      return;
    }

    for (const row of rows) this.renderRow(list, row);
  }

  /** 工具条：路径输入 + 登记 + 从预设创建。 */
  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "annex-profiles-toolbar" });

    const input = toolbar.createEl("input", { cls: "annex-profile-path-input", type: "text" });
    input.setAttr("placeholder", "vault 里的 profile JSON 路径（.json，每条模板一个文件）");

    const register = toolbar.createEl("button", { cls: "annex-profile-register", text: "登记" });
    const submit = (): void => void this.register(input.value);
    register.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    const presetSelect = toolbar.createEl("select", { cls: "dropdown annex-profile-preset" });
    presetSelect.createEl("option", { text: "从预设创建…", value: "" });
    for (const preset of PROFILE_PRESETS) {
      presetSelect.createEl("option", { text: `${preset.name}（${preset.id}）`, value: preset.id });
    }
    presetSelect.addEventListener("change", () => {
      const chosen = PROFILE_PRESETS.find((preset) => preset.id === presetSelect.value);
      presetSelect.value = "";
      if (chosen !== undefined) void this.createFromPreset(chosen);
    });
  }

  /** 跨文件 id 重复：两条都标成错误行（仍保留 path 与「打开」）。 */
  private markDuplicateIds(rows: ProfileRow[]): void {
    const pathsById = new Map<string, string[]>();
    for (const row of rows) {
      const id = row.loaded?.profile.id;
      if (id === undefined) continue;
      pathsById.set(id, [...(pathsById.get(id) ?? []), row.ref.path]);
    }
    for (const row of rows) {
      const id = row.loaded?.profile.id;
      if (id === undefined) continue;
      const paths = pathsById.get(id) ?? [];
      if (paths.length > 1) {
        row.error = `profile id「${id}」重复登记：${paths.join("、")}（请删掉多余的一条，或修改其中一份 JSON 的 id）`;
      }
    }
  }

  private renderRow(parent: HTMLElement, row: ProfileRow): void {
    const el = parent.createDiv({ cls: "annex-profile-row" });
    el.setAttr("data-profile-path", row.ref.path);
    el.setAttr("data-state", row.error === undefined ? "ok" : "error");
    if (row.loaded !== undefined) el.setAttr("data-profile-id", row.loaded.profile.id);
    if (row.error !== undefined) el.addClass("annex-profile-row-error");

    const name = row.loaded?.profile.name?.trim() ?? "";
    el.createSpan({ cls: "annex-profile-name", text: name === "" ? "（未命名）" : name });
    if (row.loaded !== undefined) {
      el.createSpan({ cls: "annex-profile-id", text: `id: ${row.loaded.profile.id}` });
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
   * 从预设创建一份独立 JSON 文件。
   *
   * 写盘前读取全部已登记文件：只要有一份坏掉/重复 id 就整体失败（错误可见），
   * 不跳过坏条目去猜 id 冲突；全部有效时再为待创建对象生成唯一 id。
   */
  private async createFromPreset(preset: ParseProfile): Promise<void> {
    try {
      const loaded = loadProfileFiles(this.host.vaultRoot(), this.host.settings.profileFiles);
      const copy = cloneProfile(preset);
      const id = uniqueId(loaded.map((entry) => entry.profile.id), preset.id);
      copy.id = id;
      if (id !== preset.id) copy.name = `${preset.name}（副本）`;

      const relPath = await this.host.createVaultFile(
        `${TEMPLATE_FOLDER}/${preset.id}.json`,
        `${JSON.stringify(copy, null, 2)}\n`,
      );
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
