/**
 * 设置页里的「多配置（profile）编辑器」——按 docs/setting-panel.md 的布局重写。
 *
 * 一张卡片 = 一条 profile：
 *   <Name> <id> <状态头>          ← 状态只有三种：Saved / Unsaved changes / Syntax Error
 *   JSON 文本框                    ← 就地编辑；只做实时校验与预览，点「保存」才写盘
 *   解析预览                       ← 第一行是示例文件名（全宽，输入即解析，没有解析按钮）
 *     带边框的解析结果             ← 每行一条解析（`key = value`）
 *   右下角一排按钮：删除 打开 复制 保存（从右往左读 = 保存、复制、打开、删除）
 *
 * 「打开」= 把这条 profile 的 JSON 写进临时缓冲文件 → 系统默认外部应用打开 →
 * 外部应用一改就自动同步回面板（合法就顺手写盘）。实现见 ./external-edit.ts。
 *
 * 落盘纪律：输入时只做实时校验与预览（不写盘）；点「保存」或外部应用的改动才写 data.json。
 * 有 error 级问题的配置**绝不写盘**（坏正则写进 data.json 会让右键弹窗直接崩）。
 */
import { Notice } from "obsidian";
import {
  DEFAULT_PROFILES,
  TEMPLATE_PROFILE,
  type ParseContext,
  type ParsedFields,
  type ParseProfile,
  parseWithProfile,
  validateProfile,
  type ProfileIssue,
} from "../core/profiles";
import { bufferPath, ExternalEditSessions, type ExternalEditHost } from "./external-edit";
import type { PluginSettings } from "./settings";

export interface ProfileEditorHost extends ExternalEditHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

/** 卡片右上角状态胶囊的三种取值（spec 点名了这三个词）。 */
type SaveState = "saved" | "unsaved" | "badjson";

const STATE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  badjson: "Syntax Error",
};

const STATE_LEVEL: Record<SaveState, string> = { saved: "ok", unsaved: "warn", badjson: "error" };

/** 深拷贝一条 profile —— 编辑/复制时绝不能改到 core 里的对象或 DEFAULT_PROFILES。 */
export function cloneProfile(profile: ParseProfile): ParseProfile {
  return JSON.parse(JSON.stringify(profile)) as ParseProfile;
}

export function cloneProfiles(profiles: ParseProfile[]): ParseProfile[] {
  return profiles.map(cloneProfile);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 文件名去掉最后一个扩展名（与 core 的 stem 定义一致）。 */
function stemOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * 预览用的 ParseContext：解析与路径无关，所以只用文件名（相对路径那一格按 spec 去掉了），
 * 路径就取文件名本身。
 */
function buildContext(filename: string): ParseContext {
  return { stem: stemOf(filename), filename, relpath: filename, folderName: "" };
}

/**
 * 状态判定用的规范化：按键名排序后序列化。
 * 只把键顺序或缩进改一改，不该被判成「Unsaved changes」。
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

/** 唯一 id：撞了就加 `-2`、`-3`…（复制/新增/导入都走这里）。 */
function uniqueId(existing: ParseProfile[], base: string): string {
  const ids = new Set(existing.map((profile) => profile.id));
  const seed = base.trim() === "" ? "profile" : base.trim();
  if (!ids.has(seed)) return seed;
  let n = 2;
  while (ids.has(`${seed}-${n}`)) n += 1;
  return `${seed}-${n}`;
}

/** 导入的 .json 可以是单条 profile、一个数组，或 `{ profiles: [...] }`。 */
function profilesFromImport(raw: unknown): ParseProfile[] {
  const candidate = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles)
      ? ((raw as { profiles: unknown[] }).profiles)
      : [raw];
  const profiles: ParseProfile[] = [];
  for (const item of candidate) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("每一条 profile 必须是一个 JSON 对象");
    }
    profiles.push(item as ParseProfile);
  }
  return profiles;
}

export class ProfileEditor {
  private readonly sessions: ExternalEditSessions;

  constructor(private readonly container: HTMLElement, private readonly host: ProfileEditorHost) {
    this.sessions = new ExternalEditSessions(host);
  }

  /** 设置页隐藏/重渲染时收摊：停掉外部编辑的轮询，不留定时器。 */
  destroy(): void {
    this.sessions.stopAll();
  }

  render(): void {
    this.sessions.stopAll();
    this.container.empty();
    const root = this.container.createDiv({ cls: "annex-profiles" });

    // ── 工具条：新模版 / 导入模版 / 添加预设（下拉选框），从左往右 ──────────
    const toolbar = root.createDiv({ cls: "annex-profiles-toolbar" });
    const newButton = toolbar.createEl("button", { cls: "annex-profile-new", text: "新模版" });
    newButton.addEventListener("click", () => void this.addProfile(TEMPLATE_PROFILE));

    const importButton = toolbar.createEl("button", { cls: "annex-profile-import", text: "导入模版" });
    const importInput = toolbar.createEl("input", { cls: "annex-profile-import-file", type: "file" });
    importInput.setAttr("accept", ".json,application/json");
    importInput.addClass("annex-hidden");
    importButton.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const file = (importInput as HTMLInputElement).files?.[0];
      if (file !== undefined && file !== null) void this.importFile(file);
    });

    const presetSelect = toolbar.createEl("select", { cls: "annex-profile-preset" });
    presetSelect.createEl("option", { text: "添加预设…", value: "" });
    for (const preset of DEFAULT_PROFILES) {
      presetSelect.createEl("option", { text: `${preset.name}（${preset.id}）`, value: preset.id });
    }
    presetSelect.addEventListener("change", () => {
      const chosen = DEFAULT_PROFILES.find((preset) => preset.id === presetSelect.value);
      presetSelect.value = "";
      if (chosen !== undefined) void this.addProfile(chosen);
    });

    // ── 卡片列表 ────────────────────────────────────────────────────────────
    const list = root.createDiv({ cls: "annex-profile-list" });
    const profiles = this.host.settings.profiles;
    if (profiles.length === 0) {
      list.createDiv({
        cls: "annex-profiles-empty",
        text: "还没有配置。点「新模版」建一条，或「导入模版」读一份 .json。",
      });
      return;
    }
    profiles.forEach((profile, index) => this.renderCard(list, profile, index));
  }

  /** 新增一条（新模版 / 添加预设共用）。 */
  private async addProfile(template: ParseProfile): Promise<void> {
    const profiles = this.host.settings.profiles;
    const copy = cloneProfile(template);
    const id = uniqueId(profiles, template.id);
    copy.id = id;
    if (id !== template.id) copy.name = `${template.name}（副本）`;
    profiles.push(copy);
    await this.host.saveSettings();
    this.render();
  }

  /** 导入一个 .json（单条 / 数组 / `{ profiles: [...] }` 都认）。 */
  private async importFile(file: File): Promise<void> {
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const incoming = profilesFromImport(raw);
      if (incoming.length === 0) throw new Error("文件里没有 profile");
      const added: string[] = [];
      for (const profile of incoming) {
        const copy = cloneProfile(profile);
        copy.id = uniqueId(this.host.settings.profiles, copy.id);
        added.push(copy.id);
        this.host.settings.profiles.push(copy);
      }
      await this.host.saveSettings();
      this.render();
      new Notice(`已导入 ${added.length} 条配置：${added.join("、")}`);
    } catch (error) {
      new Notice(`导入失败：${errText(error)}`, 10000);
    }
  }

  private async duplicate(index: number): Promise<void> {
    const profiles = this.host.settings.profiles;
    const source = profiles[index];
    if (source === undefined) return;
    const copy = cloneProfile(source);
    copy.id = uniqueId(profiles, source.id);
    copy.name = `${source.name}（副本）`;
    profiles.splice(index + 1, 0, copy);
    await this.host.saveSettings();
    this.render();
  }

  private async remove(index: number): Promise<void> {
    const profiles = this.host.settings.profiles;
    const target = profiles[index];
    if (target === undefined) return;
    this.sessions.stop(target.id);
    profiles.splice(index, 1);
    await this.host.saveSettings();
    this.render();
  }

  private renderCard(parent: HTMLElement, profile: ParseProfile, index: number): void {
    const card = parent.createDiv({ cls: "annex-profile-card" });
    card.setAttr("data-profile-id", profile.id);

    // ── 头一行：<Name> <id> <状态> ──────────────────────────────────────────
    const head = card.createDiv({ cls: "annex-profile-card-head" });
    const nameEl = head.createSpan({ cls: "annex-profile-name", text: profile.name || "（未命名）" });
    head.createSpan({ cls: "annex-profile-sep", text: "·" });
    const idEl = head.createSpan({ cls: "annex-profile-id", text: `id: ${profile.id}` });
    const statusEl = head.createSpan({ cls: "annex-profile-status" });

    // ── JSON 文本框 ─────────────────────────────────────────────────────────
    const jsonArea = card.createEl("textarea", { cls: "annex-profile-json" });
    // Obsidian 的 textarea 默认只有 2 行高，JSON 配置根本看不全
    jsonArea.rows = 20;
    jsonArea.spellcheck = false;
    jsonArea.value = JSON.stringify(profile, null, 2);

    const messages = card.createDiv({ cls: "annex-profile-messages" });

    // ── 解析预览 ────────────────────────────────────────────────────────────
    const preview = card.createDiv({ cls: "annex-preview" });
    preview.createDiv({ cls: "annex-preview-title", text: "解析预览" });
    const filenameInput = preview.createEl("input", { cls: "annex-preview-filename", type: "text" });
    filenameInput.setAttr("placeholder", "示例文件名（输入即解析，例：12345X-5705-0015.tif）");
    const resultEl = preview.createDiv({ cls: "annex-preview-result" });

    // ── 底部动作：DOM 顺序 删除→打开→复制→保存，视觉上从右往左读就是 ────────
    //    保存、复制、打开、删除；整排贴右下角（styles.css 里 justify-content: flex-end）。
    const actions = card.createDiv({ cls: "annex-profile-actions" });
    const deleteButton = actions.createEl("button", { cls: "annex-profile-del mod-warning", text: "删除" });
    const openButton = actions.createEl("button", { cls: "annex-profile-open", text: "打开" });
    const duplicateButton = actions.createEl("button", { cls: "annex-profile-dup", text: "复制" });
    const saveButton = actions.createEl("button", { cls: "annex-profile-save mod-cta", text: "保存" });

    let draft: ParseProfile = cloneProfile(profile);
    /** 盘上那份（语义比较的基线）。 */
    let onDisk: ParseProfile = cloneProfile(profile);

    const setState = (state: SaveState): void => {
      statusEl.setText(STATE_LABEL[state]);
      statusEl.setAttr("data-level", STATE_LEVEL[state]);
    };

    const listIssues = (issues: ProfileIssue[]): void => {
      for (const issue of issues) {
        messages.createDiv({
          cls: `annex-profile-msg annex-profile-msg-${issue.level}`,
          text: `[${issue.level}] ${issue.message}`,
        });
      }
    };

    /** 校验 draft；引擎抛错时当作「没有 error」（绝不因为校验器坏了就卡住写盘）。 */
    const issuesOf = (candidate: ParseProfile): ProfileIssue[] => {
      try {
        return validateProfile(candidate);
      } catch (error) {
        messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-warn", text: `校验暂不可用：${errText(error)}` });
        return [];
      }
    };

    const parseDraft = (): ParseProfile => {
      const raw = JSON.parse(jsonArea.value) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("JSON 顶层必须是一个对象");
      return raw as ParseProfile;
    };

    const renderPreview = (): void => {
      resultEl.empty();
      const filename = filenameInput.value.trim();
      if (filename === "") {
        resultEl.setAttr("data-state", "idle");
        resultEl.createDiv({
          cls: "annex-preview-hint",
          text: "在上面填一个真实文件名再看结果；正则不命中时这里会写明「正则不命中」。预览只显示正则拆出来的字段（tags / session / date / width 等是生成时另算的）。",
        });
        return;
      }
      try {
        const parsed = parseWithProfile(draft, buildContext(filename));
        resultEl.setAttr("data-state", parsed.matched ? "ok" : "nomatch");
        renderParsed(resultEl, draft, parsed, filename);
      } catch (error) {
        resultEl.setAttr("data-state", "error");
        resultEl.createDiv({ cls: "annex-preview-error", text: `解析暂不可用：${errText(error)}` });
      }
    };

    /** 文本框一变就跑：JSON 语法 → 实时校验 → 预览 → 状态胶囊。不写盘。 */
    const refresh = (): void => {
      messages.empty();
      let parsed: ParseProfile;
      try {
        parsed = parseDraft();
      } catch (error) {
        messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-error", text: `JSON 解析失败：${errText(error)}` });
        setState("badjson");
        resultEl.empty();
        resultEl.setAttr("data-state", "badjson");
        resultEl.createDiv({ cls: "annex-preview-error", text: "JSON 有语法错误，先修好才能预览解析结果。" });
        return;
      }
      draft = parsed;
      card.setAttr("data-profile-id", draft.id ?? "");
      nameEl.setText(draft.name || "（未命名）");
      idEl.setText(`id: ${draft.id ?? ""}`);
      listIssues(issuesOf(draft));
      setState(canonical(draft) === canonical(onDisk) ? "saved" : "unsaved");
      renderPreview();
    };

    /** 把 draft 写进 data.json（有 error 级问题就拒绝）。返回是否写成功。 */
    const writeThrough = async (): Promise<boolean> => {
      const parsed = parseDraft();
      const issues = issuesOf(parsed);
      const errors = issues.filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        setState("unsaved");
        new Notice(`有 ${errors.length} 条 error，未写盘：${errors[0].message}`, 8000);
        return false;
      }
      this.host.settings.profiles[index] = parsed;
      await this.host.saveSettings();
      onDisk = cloneProfile(parsed);
      setState("saved");
      return true;
    };

    const save = async (): Promise<void> => {
      try {
        if (await writeThrough()) this.sessions.sync(draft.id, jsonArea.value);
      } catch (error) {
        messages.empty();
        messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-error", text: `JSON 解析失败，未写盘：${errText(error)}` });
        setState("badjson");
      }
    };

    /** 外部应用改了缓冲文件 → 回灌文本框、重跑校验，合法就顺手写盘。 */
    const applyExternal = (text: string): void => {
      jsonArea.value = text;
      refresh();
      let parsed: ParseProfile;
      try {
        parsed = parseDraft();
      } catch {
        return; // 语法错误：refresh() 已经把状态胶囊点成 Syntax Error
      }
      try {
        if (issuesOf(parsed).some((issue) => issue.level === "error")) return; // 不写盘，等用户在面板里修
      } catch {
        return;
      }
      this.host.settings.profiles[index] = parsed;
      onDisk = cloneProfile(parsed);
      setState("saved");
      messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-ok", text: "已从外部应用同步并写盘。" });
      void this.host.saveSettings();
    };

    const openExternally = async (): Promise<void> => {
      const id = (draft.id ?? "").trim() === "" ? `profile-${index + 1}` : draft.id;
      try {
        const file = await this.sessions.open(id, jsonArea.value, applyExternal);
        new Notice(`已用系统默认应用打开：\n${file}\n在那里改完保存，这里会自动同步。`, 8000);
      } catch (error) {
        new Notice(`打不开系统默认应用，可以手动打开这个文件：\n${bufferPath(id)}\n（${errText(error)}）`, 12000);
      }
    };

    jsonArea.addEventListener("input", refresh); // 实时校验/预览，不落盘
    filenameInput.addEventListener("input", renderPreview); // 输入即解析，没有解析按钮
    saveButton.addEventListener("click", () => void save());
    duplicateButton.addEventListener("click", () => void this.duplicate(index));
    deleteButton.addEventListener("click", () => void this.remove(index));
    openButton.addEventListener("click", () => void openExternally());

    refresh();
  }
}

function renderParsed(
  resultEl: HTMLElement,
  profile: ParseProfile,
  parsed: ParsedFields,
  filename: string,
): void {
  if (!parsed.matched) {
    resultEl.createDiv({
      cls: "annex-preview-nomatch",
      text: `正则不命中：「${filename}」不符合这条 profile 的 regex（onMismatch=${profile.onMismatch ?? "empty"}）。下面每行是把 fields 按 whenMissing 填出来的值，不是从文件名解析出来的。`,
    });
  }
  const rows = resultEl.createDiv({ cls: "annex-preview-rows" });
  const fieldSpecs = Array.isArray(profile.fields) ? profile.fields : [];
  if (fieldSpecs.length === 0) {
    rows.createDiv({ cls: "annex-preview-empty", text: "这条 profile 没有声明 fields（具名组 → 键）。" });
  }
  for (const field of fieldSpecs) {
    const key = field.key ?? field.group;
    const raw = parsed.values[key] ?? parsed.values[field.group];
    const value = raw === undefined ? "" : raw;
    const missing = parsed.missingGroups.includes(field.group);
    const row = rows.createDiv({ cls: "annex-preview-row" });
    row.setAttr("data-key", key);
    row.setAttr("data-value", value);
    if (missing) row.addClass("annex-preview-missing");
    const isEmpty = value === "" || value === '""' || value === "''";
    if (isEmpty) row.addClass("annex-preview-empty-value");
    row.createSpan({ cls: "annex-preview-key", text: `${key} = ` });
    row.createSpan({ cls: "annex-preview-value", text: isEmpty ? "（空）" : value });
  }
  if (parsed.missingGroups.length > 0) {
    resultEl.createDiv({
      cls: "annex-preview-missing-groups",
      text: `未参与匹配的具名组：${parsed.missingGroups.join(", ")}`,
    });
  }
  if (parsed.extraGroups.length > 0) {
    resultEl.createDiv({
      cls: "annex-preview-extra-groups",
      text: `正则里未映射到键的具名组（正常，用于配平分支）：${parsed.extraGroups.join(", ")}`,
    });
  }
}
