/**
 * T-008 · B-004 —— 设置页里的「多配置（profile）编辑器」。
 *
 * 一条 profile 一张卡片：显示 name / id / match 规则 / 校验状态，编辑用 JSON 文本框
 * （用户很熟 JSON/正则，比一堆表单控件好用），实时跑 `validateProfile` 把 error/warn
 * 列在卡片下方；还有「解析预览」——粘个文件名（+ 可选相对路径）就显示 `parseWithProfile`
 * 拆出的键值，并标出哪些具名组没参与匹配。
 *
 * ⚠️ 引擎层（src/core/profiles.ts 的 parseWithProfile / validateProfile）由并行块 B-002
 * 实现，现在还是抛错的桩。这里必须**优雅处理**：catch 住并把错误显示在卡片上，绝不能
 * 因为引擎没就绪就把设置页整个搞崩。等集成后预览/校验会自动变成真实结果。
 *
 * 落盘纪律：输入时只做实时校验与预览（不写盘）；点「应用」或文本框失焦时才写 data.json。
 */
import {
  DEFAULT_PROFILES,
  type ParsedFields,
  type ParseContext,
  type ParseProfile,
  parseWithProfile,
  validateProfile,
  type ProfileIssue,
} from "../core/profiles";
import type { PluginSettings } from "./settings";

export interface ProfileEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

const TECNAI_TEMPLATE_ID = "tecnaitem";

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

/** 由预览的两个输入拼出 ParseContext。 */
function buildContext(filename: string, relpathInput: string): ParseContext {
  const relpath = relpathInput.trim() === "" ? filename : relpathInput.trim();
  const parts = relpath.split("/");
  const folderName = parts.length > 1 ? parts[parts.length - 2] : "";
  return { stem: stemOf(filename), filename, relpath, folderName };
}

function uniqueId(existing: ParseProfile[], base: string): string {
  const ids = new Set(existing.map((profile) => profile.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export class ProfileEditor {
  constructor(private readonly container: HTMLElement, private readonly host: ProfileEditorHost) {}

  render(): void {
    this.container.empty();
    const root = this.container.createDiv({ cls: "annex-profiles" });

    const head = root.createDiv({ cls: "annex-profiles-head" });
    head.createEl("h3", { text: "Metadata 配置（profile）" });
    head.createEl("p", {
      text: "每条配置 = 一条正则 + 具名捕获组到 frontmatter 键的映射。编辑用 JSON；改动实时校验，点「应用」或输入框失焦时才写盘。",
    });
    const toolbar = head.createDiv({ cls: "annex-profiles-toolbar" });
    const addButton = toolbar.createEl("button", { cls: "annex-profile-add", text: "新增（TECNAI 模板）" });
    addButton.addEventListener("click", () => void this.addProfile());

    const list = root.createDiv({ cls: "annex-profile-list" });
    const profiles = this.host.settings.profiles;
    if (profiles.length === 0) {
      list.createDiv({ cls: "annex-profiles-empty", text: "还没有配置。点「新增」从内置 TECNAI 模板建一条。" });
      return;
    }
    profiles.forEach((profile, index) => this.renderCard(list, profile, index));
  }

  private async addProfile(): Promise<void> {
    const template = DEFAULT_PROFILES.find((profile) => profile.id === TECNAI_TEMPLATE_ID) ?? DEFAULT_PROFILES[0];
    const profiles = this.host.settings.profiles;
    const copy = cloneProfile(template);
    copy.id = uniqueId(profiles, template.id);
    copy.name = `${template.name}（副本）`;
    profiles.push(copy);
    await this.host.saveSettings();
    this.render();
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
    if (profiles[index] === undefined) return;
    profiles.splice(index, 1);
    await this.host.saveSettings();
    this.render();
  }

  private renderCard(parent: HTMLElement, profile: ParseProfile, index: number): void {
    const card = parent.createDiv({ cls: "annex-profile-card" });
    card.setAttr("data-profile-id", profile.id);

    const head = card.createDiv({ cls: "annex-profile-card-head" });
    const nameEl = head.createSpan({ cls: "annex-profile-name", text: profile.name || "（未命名）" });
    const idEl = head.createSpan({ cls: "annex-profile-id", text: profile.id });
    const matchEl = head.createSpan({
      cls: "annex-profile-match",
      text: profile.match ? `match: ${JSON.stringify(profile.match)}` : "match: 无（不会自动命中）",
    });
    const statusEl = head.createSpan({ cls: "annex-profile-status" });

    const textarea = card.createEl("textarea", { cls: "annex-profile-json" });
    textarea.value = JSON.stringify(profile, null, 2);

    const messages = card.createDiv({ cls: "annex-profile-messages" });

    const preview = card.createDiv({ cls: "annex-preview" });
    preview.createDiv({ cls: "annex-preview-title", text: "解析预览" });
    const inputs = preview.createDiv({ cls: "annex-preview-inputs" });
    const filenameInput = inputs.createEl("input", { cls: "annex-preview-filename", type: "text" });
    filenameInput.setAttr("placeholder", "文件名，例如 12345X-5705-0015");
    const relpathInput = inputs.createEl("input", { cls: "annex-preview-relpath", type: "text" });
    relpathInput.setAttr("placeholder", "可选：相对 vault 路径，例如 TEM/20261008-1495dd26-5705");
    const runButton = inputs.createEl("button", { cls: "annex-preview-run", text: "解析" });
    const resultEl = preview.createDiv({ cls: "annex-preview-result" });

    const actions = card.createDiv({ cls: "annex-profile-actions" });
    const applyButton = actions.createEl("button", { cls: "annex-profile-apply", text: "应用" });
    const dupButton = actions.createEl("button", { cls: "annex-profile-dup", text: "复制" });
    const delButton = actions.createEl("button", { cls: "annex-profile-del mod-warning", text: "删除" });

    let draft: ParseProfile = cloneProfile(profile);

    const setStatus = (text: string, level: string): void => {
      statusEl.setText(text);
      statusEl.setAttr("data-level", level);
    };

    const renderPreview = (): void => {
      resultEl.empty();
      const context = buildContext(filenameInput.value, relpathInput.value);
      try {
        const parsed = parseWithProfile(draft, context);
        resultEl.setAttr("data-state", "ok");
        renderParsed(resultEl, draft, parsed);
      } catch (error) {
        resultEl.setAttr("data-state", "error");
        resultEl.createDiv({ cls: "annex-preview-error", text: `解析暂不可用：${errText(error)}` });
      }
    };

    const refresh = (): void => {
      messages.empty();
      let parsed: ParseProfile;
      try {
        const raw = JSON.parse(textarea.value) as unknown;
        if (raw === null || typeof raw !== "object") throw new Error("JSON 顶层必须是一个对象");
        parsed = raw as ParseProfile;
      } catch (error) {
        messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-error", text: `JSON 解析失败：${errText(error)}` });
        setStatus("JSON 错误", "error");
        return;
      }
      draft = parsed;
      card.setAttr("data-profile-id", draft.id ?? "");
      nameEl.setText(draft.name || "（未命名）");
      idEl.setText(draft.id ?? "");
      matchEl.setText(draft.match ? `match: ${JSON.stringify(draft.match)}` : "match: 无（不会自动命中）");

      try {
        const issues: ProfileIssue[] = validateProfile(draft);
        for (const issue of issues) {
          messages.createDiv({
            cls: `annex-profile-msg annex-profile-msg-${issue.level}`,
            text: `[${issue.level}] ${issue.message}`,
          });
        }
        const hasError = issues.some((issue) => issue.level === "error");
        if (hasError) setStatus(`校验：${issues.length} 条问题`, "error");
        else if (issues.length > 0) setStatus(`校验：${issues.length} 条警告`, "warn");
        else setStatus("校验通过", "ok");
      } catch (error) {
        // 引擎未实现：显示为「校验暂不可用」，不当作错误，也不让设置页崩掉。
        messages.createDiv({ cls: "annex-profile-msg annex-profile-msg-warn", text: `校验暂不可用：${errText(error)}` });
        setStatus("校验不可用（引擎未实现）", "warn");
      }

      renderPreview();
    };

    const commit = async (): Promise<void> => {
      let parsed: ParseProfile;
      try {
        parsed = JSON.parse(textarea.value) as ParseProfile;
      } catch {
        return; // JSON 没解析通过就不落盘，避免把坏配置写进 data.json
      }
      this.host.settings.profiles[index] = parsed;
      await this.host.saveSettings();
    };

    textarea.addEventListener("input", refresh); // 实时校验/预览，不落盘
    textarea.addEventListener("blur", () => void commit());
    filenameInput.addEventListener("input", renderPreview);
    relpathInput.addEventListener("input", renderPreview);
    runButton.addEventListener("click", renderPreview);
    applyButton.addEventListener("click", () => void commit());
    dupButton.addEventListener("click", () => void this.duplicate(index));
    delButton.addEventListener("click", () => void this.remove(index));

    refresh();
  }
}

function renderParsed(resultEl: HTMLElement, profile: ParseProfile, parsed: ParsedFields): void {
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
