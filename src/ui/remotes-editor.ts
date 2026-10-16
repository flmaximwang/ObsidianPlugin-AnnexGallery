/**
 * 设置页最上方的「remote 设置」item —— 一个 item 里可以装多条 remote（名称 + 地址）。
 *
 * 形状：每行 = [名称] [地址] [删除]，列表下方一个「添加 remote」。
 * 落盘：输入即写 data.json（与「缩略图边长」同口径，不设「保存」按钮）。
 * 作用：`git remote add` / `set-url` 由「初始化 gallery」执行（见 src/core/remotes.ts）。
 *
 * 名称/地址都为空的行（刚点「添加」还没填）不写盘也不报错；缺一半时在行尾给一句提示。
 * 只在行尾那格上做局部更新，不重建 DOM —— 否则每敲一个键都会丢焦点。
 */
import type { RemoteEntry } from "../core/remotes";
import type { PluginSettings } from "./settings";

export interface RemotesEditorHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

/** 一行是否会被「初始化 gallery」真正用上；不完整时给一句为什么。 */
function rowProblem(remote: RemoteEntry): string | undefined {
  const name = remote.name.trim();
  const url = remote.url.trim();
  if (name === "" && url === "") return undefined; // 空行：忽略
  if (name === "") return "缺名称";
  if (/\s/.test(name)) return "名称里有空白字符";
  if (url === "") return "缺地址";
  return undefined;
}

export class RemotesEditor {
  /** 行尾提示格 & 名称输入框，按行号记住：更新时不查 DOM（无头桩里没有 querySelector）。 */
  private readonly notes = new Map<number, HTMLElement>();
  private readonly nameInputs = new Map<number, HTMLElement>();

  constructor(private readonly container: HTMLElement, private readonly host: RemotesEditorHost) {}

  render(): void {
    this.container.empty();
    this.notes.clear();
    this.nameInputs.clear();

    const card = this.container.createDiv({ cls: "annex-remotes-card" });
    card.createEl("h3", { cls: "annex-remotes-title", text: "remote 设置" });
    card.createDiv({
      cls: "annex-remotes-hint",
      text: "「初始化 gallery」会逐个执行 git remote add（同名已存在就 git remote set-url），只写配置、不 fetch 也不 push。名称与地址都填了才生效。",
    });

    const list = card.createDiv({ cls: "annex-remote-list" });
    const remotes = this.host.settings.remotes;
    if (remotes.length === 0) {
      list.createDiv({ cls: "annex-remotes-empty", text: "还没有 remote。" });
    }
    remotes.forEach((remote, index) => this.renderRow(list, remote, index));

    const addButton = card.createEl("button", { cls: "annex-remote-add", text: "添加 remote" });
    addButton.addEventListener("click", () => void this.add());
  }

  private renderRow(list: HTMLElement, remote: RemoteEntry, index: number): void {
    const row = list.createDiv({ cls: "annex-remote-row" });
    row.setAttr("data-remote-index", String(index));

    const nameInput = row.createEl("input", { cls: "annex-remote-name", type: "text" });
    nameInput.setAttr("placeholder", "名称（如 origin）");
    nameInput.value = remote.name;
    nameInput.addEventListener("input", () => void this.update(index, "name", nameInput.value));
    this.nameInputs.set(index, nameInput);

    const urlInput = row.createEl("input", { cls: "annex-remote-url", type: "text" });
    urlInput.setAttr("placeholder", "地址（ssh://… / https://… / 本地路径）");
    urlInput.value = remote.url;
    urlInput.addEventListener("input", () => void this.update(index, "url", urlInput.value));

    const note = row.createSpan({ cls: "annex-remote-note" });
    this.notes.set(index, note);
    this.paintNote(index, remote);

    const delButton = row.createEl("button", { cls: "annex-remote-del mod-warning", text: "删除" });
    delButton.addEventListener("click", () => void this.remove(index));
  }

  /** 行尾提示：没填全就写原因，填全了就清空。 */
  private paintNote(index: number, remote: RemoteEntry): void {
    const note = this.notes.get(index);
    if (note === undefined) return;
    const problem = rowProblem(remote);
    note.setText(problem ?? "");
    if (problem === undefined) note.removeClass("annex-remote-note-warn");
    else note.addClass("annex-remote-note-warn");
  }

  private async update(index: number, field: "name" | "url", value: string): Promise<void> {
    const remote = this.host.settings.remotes[index];
    if (remote === undefined) return;
    remote[field] = value;
    await this.host.saveSettings();
    this.paintNote(index, remote);
  }

  private async add(): Promise<void> {
    this.host.settings.remotes.push({ name: "", url: "" });
    await this.host.saveSettings();
    this.render();
    // 新建的那一行（如果是空行，不写盘也不影响）把光标放到名称上
    this.nameInputs.get(this.host.settings.remotes.length - 1)?.focus();
  }

  private async remove(index: number): Promise<void> {
    if (this.host.settings.remotes[index] === undefined) return;
    this.host.settings.remotes.splice(index, 1);
    await this.host.saveSettings();
    this.render();
  }
}
