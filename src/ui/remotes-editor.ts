/**
 * Remotes editor — the settings-page section that reads `.git/config` and writes back
 * only on an explicit Save.
 *
 * Contract (implemented by the UI slice, consumed by the settings tab):
 *   `new RemotesEditor(container, host).render()`
 *     - reads the snapshot synchronously via `readRemotes(host.vaultRoot())`;
 *     - keeps the draft rows in memory only — no data.json, no plugin settings;
 *     - calls `host.refresh()` after a successful save / Reload so the tab re-renders
 *       from a fresh git read.
 *
 * The settings tab mounts it with:
 *   new RemotesEditor(container, {
 *     app: this.app,
 *     vaultRoot: () => this.host.vaultRoot(),
 *     refresh: () => this.update(),
 *   }).render();
 *
 * Behaviour (annex-gallery-10m DESIGN 3/4/5/6/7/8/9):
 *   - `.git/config` is the single source of truth: the editor never persists rows.
 *   - Save re-reads git first (staleness check), validates the whole draft, then runs the
 *     ordered plan from `planRemoteChanges` — removals only after a confirm modal.
 *   - Multi-URL remotes and git-annex special remotes are read-only: the plugin never
 *     creates, edits or removes them (manage those with `git remote` / `git annex initremote`
 *     in a terminal). No transfer operation is ever started from here.
 *
 * All user-facing strings are English (annex-gallery-5vm).
 */
import { Modal, Notice, Setting, type App } from "obsidian";
import {
  applyRemotePlan,
  planRemoteChanges,
  readRemotes,
  rowsFromSnapshot,
  sameRemoteConfig,
  specialRemoteDocUrl,
  type GitRemote,
  type RemoteApplyResult,
  type RemoteIssue,
  type RemotePlan,
  type RemoteRow,
  type RemotesSnapshot,
  type SpecialRemote,
} from "../core/remotes";

export interface RemotesEditorHost {
  /** Obsidian `App` — needed for the removal confirm modal. */
  app: App;
  /** Absolute path of the vault (the git work tree root or a directory inside it). */
  vaultRoot(): string;
  /** Re-render the settings tab from git state (after save / reload). */
  refresh(): void;
}

/** The git-annex special-remotes documentation index. */
export const SPECIAL_REMOTES_DOC_URL = "https://git-annex.branchable.com/special_remotes/";

const SECTION_TITLE = "Remotes";
const SAVE_HINT =
  "Read from .git/config. Changes are written back to git only when you click Save; " +
  "closing the settings page discards them.";
const NO_REPO_TEXT = "This vault is not a git repo yet. Run Initialize gallery first.";
const MULTI_URL_LABEL = "multiple URLs - edit with git";
const SAVE_DISABLED_HINT = "No changes to save.";
const ADD_REMOTE_TEXT = "Add remote";
const SAVE_TEXT = "Save";
const RELOAD_TEXT = "Reload";

const ROW_STATE_CLASSES = ["is-new", "is-changed", "is-renamed", "is-deleted"];
const MARK_STATE_CLASSES = ["is-new", "is-changed", "is-renamed", "is-deleted"];

/** A draft row: the contract row plus the editor-only pending-delete flag. */
interface DraftRow extends RemoteRow {
  /** Pending delete — toggled in the draft only; git is untouched until Save. */
  deleted: boolean;
}

/** DOM handles for one draft row, so markers / disabled state can update without a full re-render. */
interface RowRefs {
  el: HTMLElement;
  mark: HTMLElement;
  nameInput: HTMLInputElement;
  fetchInput: HTMLInputElement;
  pushInput: HTMLInputElement | null;
  deleteButton: HTMLButtonElement;
  errorEl: HTMLElement;
}

/** One remote listed in the removal confirm modal. */
interface RemovalInfo {
  name: string;
  hasAnnexUuid: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePush(value: string | null): string {
  // `null` = no push URL configured, `""` = an empty (revealed) push field: both mean
  // "no push URL" for the dirty check; the plan decides whether a cleared URL needs a delete.
  return value ?? "";
}

/** Documentation link for a special remote, falling back to the index page. */
function docUrlFor(remote: SpecialRemote): string {
  try {
    return specialRemoteDocUrl(remote);
  } catch {
    return SPECIAL_REMOTES_DOC_URL;
  }
}

/** Confirm dialog for removals (DESIGN 4): lists the removals, warns about annex-uuid. */
class RemoveRemotesModal extends Modal {
  constructor(
    app: App,
    private readonly removals: RemovalInfo[],
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Remove git remotes?");
    this.contentEl.createEl("p", { text: "Saving removes these remotes from .git/config:" });
    const list = this.contentEl.createEl("ul", { cls: "annex-remotes-confirm-list" });
    for (const removal of this.removals) list.createEl("li", { text: removal.name });

    const withUuid = this.removals.filter((removal) => removal.hasAnnexUuid);
    if (withUuid.length > 0) {
      const names = withUuid.map((removal) => removal.name).join(", ");
      this.contentEl.createEl("p", {
        cls: "annex-remotes-confirm-warning",
        text:
          `Warning: git-annex uses ${names} (annex-uuid). Removing ` +
          `${withUuid.length === 1 ? "it" : "them"} disconnects the git-annex repository from this vault; ` +
          "the annex data on the remote itself is not deleted.",
      });
    }

    this.contentEl.createEl("p", {
      cls: "annex-remotes-confirm-hint",
      text: "Only the remote entry in .git/config is removed — nothing is deleted on the remote.",
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Remove")
          .setDestructive()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class RemotesEditor {
  /** The git state this draft was rendered from (the staleness baseline). */
  private snapshot: RemotesSnapshot | null = null;
  /** Draft rows — memory only; never persisted anywhere. */
  private rows: DraftRow[] = [];
  /** DOM handles, index-aligned with `rows`. */
  private refs: RowRefs[] = [];
  /** Draft index of each non-deleted row, index-aligned with the rows passed to the plan. */
  private activeIndices: number[] = [];
  private saveButton: HTMLButtonElement | null = null;
  private summaryEl: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly host: RemotesEditorHost,
  ) {}

  /** Read git and render the section. Draft edits are discarded on every render. */
  render(): void {
    this.container.empty();
    this.resetDomState();
    this.snapshot = null;

    let snapshot: RemotesSnapshot;
    try {
      snapshot = readRemotes(this.host.vaultRoot());
    } catch (error) {
      const card = this.container.createDiv({ cls: "annex-remotes-card" });
      card.createEl("h3", { cls: "annex-remotes-title", text: SECTION_TITLE });
      card.createDiv({
        cls: "annex-remotes-error",
        text: `Could not read git remotes: ${errorText(error)}`,
      });
      return;
    }
    this.snapshot = snapshot;

    if (!snapshot.hasRepo) {
      const card = this.container.createDiv({ cls: "annex-remotes-card" });
      card.createEl("h3", { cls: "annex-remotes-title", text: SECTION_TITLE });
      card.createDiv({ cls: "annex-remotes-no-repo", text: NO_REPO_TEXT });
      return;
    }

    this.rows = rowsFromSnapshot(snapshot).map((row) => ({ ...row, deleted: false }));
    this.buildCard();
  }

  /** Drop the DOM handles (the container itself is cleared by render / buildCard). */
  private resetDomState(): void {
    this.refs = [];
    this.activeIndices = [];
    this.saveButton = null;
    this.summaryEl = null;
  }

  /** Build the editor card from the in-memory draft (no git read). */
  private buildCard(): void {
    const snapshot = this.snapshot;
    if (snapshot === null || !snapshot.hasRepo) return;

    this.container.empty();
    this.resetDomState();
    const card = this.container.createDiv({ cls: "annex-remotes-card" });
    card.createEl("h3", { cls: "annex-remotes-title", text: SECTION_TITLE });
    card.createDiv({ cls: "annex-remotes-hint", text: SAVE_HINT });
    this.summaryEl = card.createDiv({ cls: "annex-remotes-summary" });

    this.renderEditableRows(card);
    this.renderMultiUrlRemotes(card, snapshot);
    this.renderSpecialRemotes(card, snapshot);
  }

  // ── editable git remotes ────────────────────────────────────────────────────

  private renderEditableRows(card: HTMLElement): void {
    const list = card.createDiv({ cls: "annex-remote-list" });
    if (this.rows.length === 0) {
      list.createDiv({
        cls: "annex-remotes-empty",
        text: "No git remotes yet. Use Add remote to configure one.",
      });
    }
    this.rows.forEach((_row, index) => this.renderRow(list, index));

    const toolbar = card.createDiv({ cls: "annex-remotes-toolbar" });
    const addButton = toolbar.createEl("button", { cls: "annex-remote-add", text: ADD_REMOTE_TEXT });
    addButton.addEventListener("click", () => this.addRow());

    this.saveButton = toolbar.createEl("button", { cls: "annex-remotes-save mod-cta", text: SAVE_TEXT });
    this.saveButton.setAttr("title", SAVE_DISABLED_HINT);
    this.saveButton.addEventListener("click", () => this.save());

    const reloadButton = toolbar.createEl("button", { cls: "annex-remotes-reload", text: RELOAD_TEXT });
    reloadButton.setAttr("title", "Re-read git and discard the draft (also acts as Revert).");
    reloadButton.addEventListener("click", () => this.reload());

    this.refreshToolbar();
  }

  private renderRow(list: HTMLElement, index: number): void {
    const row = this.rows[index];
    const el = list.createDiv({ cls: "annex-remote-row" });
    el.setAttr("data-row", String(index));
    el.setAttr("data-remote", row.originalName);

    const nameInput = el.createEl("input", { cls: "annex-remote-name", type: "text" });
    nameInput.setAttr("placeholder", "Remote name");
    nameInput.setAttr("aria-label", "Remote name");
    nameInput.value = row.name;
    nameInput.disabled = row.deleted;
    nameInput.addEventListener("input", () => {
      row.name = nameInput.value;
      this.refreshRowState(index);
      this.refreshToolbar();
    });

    const fetchInput = el.createEl("input", { cls: "annex-remote-url annex-remote-fetch", type: "text" });
    fetchInput.setAttr("placeholder", "Fetch URL");
    fetchInput.setAttr("aria-label", "Fetch URL");
    fetchInput.value = row.fetchUrl;
    fetchInput.disabled = row.deleted;
    fetchInput.addEventListener("input", () => {
      row.fetchUrl = fetchInput.value;
      this.refreshRowState(index);
      this.refreshToolbar();
    });

    let pushInput: HTMLInputElement | null = null;
    if (row.pushUrl === null) {
      const pushAdd = el.createEl("button", { cls: "annex-remote-push-add", text: "+ push URL" });
      pushAdd.setAttr("title", "Add a separate push URL (defaults to the fetch URL).");
      pushAdd.disabled = row.deleted;
      pushAdd.addEventListener("click", () => {
        row.pushUrl = "";
        this.buildCard();
      });
    } else {
      pushInput = el.createEl("input", { cls: "annex-remote-url annex-remote-push-url", type: "text" });
      pushInput.setAttr("placeholder", "Push URL (optional)");
      pushInput.setAttr("aria-label", "Push URL");
      pushInput.value = row.pushUrl;
      pushInput.disabled = row.deleted;
      pushInput.addEventListener("input", () => {
        row.pushUrl = pushInput === null ? null : pushInput.value;
        this.refreshRowState(index);
        this.refreshToolbar();
      });
    }

    const mark = el.createSpan({ cls: "annex-remote-mark" });

    const deleteButton = el.createEl("button", { cls: "annex-remote-del" });
    deleteButton.setText(row.deleted ? "Undo" : "Delete");
    deleteButton.setAttr(
      "title",
      row.deleted ? "Undo the pending delete." : "Mark this remote for removal on Save (git is not touched yet).",
    );
    deleteButton.addEventListener("click", () => {
      row.deleted = !row.deleted;
      this.buildCard();
    });

    const errorEl = el.createDiv({ cls: "annex-remote-error" });

    this.refs[index] = { el, mark, nameInput, fetchInput, pushInput, deleteButton, errorEl };
    this.refreshRowState(index);
  }

  private addRow(): void {
    this.rows.push({ originalName: "", name: "", fetchUrl: "", pushUrl: null, deleted: false });
    this.buildCard();
  }

  /** The rows handed to the plan: pending deletes are dropped, originals preserved. */
  private activeRows(): RemoteRow[] {
    this.activeIndices = [];
    const active: RemoteRow[] = [];
    this.rows.forEach((row, index) => {
      if (row.deleted) return;
      this.activeIndices.push(index);
      active.push({
        originalName: row.originalName,
        name: row.name,
        fetchUrl: row.fetchUrl,
        // A blank (revealed) push field means "no push URL": clearing an existing one must
        // become `--delete --push`, and an untouched reveal is not a validation error.
        pushUrl: row.pushUrl === "" ? null : row.pushUrl,
      });
    });
    return active;
  }

  private originalOf(originalName: string): GitRemote | undefined {
    if (this.snapshot === null || originalName === "") return undefined;
    return this.snapshot.gitRemotes.find((remote) => remote.name === originalName);
  }

  /** Recompute the pending markers / strike-through / disabled inputs for one row. */
  private refreshRowState(index: number): void {
    const refs = this.refs[index];
    const row = this.rows[index];
    if (refs === undefined || row === undefined) return;

    for (const cls of ROW_STATE_CLASSES) refs.el.removeClass(cls);
    for (const cls of MARK_STATE_CLASSES) refs.mark.removeClass(cls);
    refs.mark.setText("");

    const original = this.originalOf(row.originalName);
    const marks: string[] = [];
    if (row.deleted) {
      refs.el.addClass("is-deleted");
      marks.push("pending delete");
      refs.mark.addClass("is-deleted");
    } else if (original === undefined) {
      refs.el.addClass("is-new");
      marks.push("new");
      refs.mark.addClass("is-new");
    } else {
      if (row.name !== row.originalName) {
        refs.el.addClass("is-renamed");
        marks.push("renamed");
        refs.mark.addClass("is-renamed");
      }
      const fetchChanged = row.fetchUrl !== (original.fetchUrls[0] ?? "");
      const pushChanged = normalizePush(row.pushUrl) !== normalizePush(original.pushUrls[0] ?? null);
      if (fetchChanged || pushChanged) {
        refs.el.addClass("is-changed");
        marks.push("URL changed");
        refs.mark.addClass("is-changed");
      }
    }
    refs.mark.setText(marks.join(", "));
  }

  private refreshToolbar(): void {
    if (this.saveButton === null) return;
    const dirty = this.isDirty();
    this.saveButton.disabled = !dirty;
    this.saveButton.setAttr("aria-disabled", String(!dirty));
    this.saveButton.setAttr("title", dirty ? "Write the changes to .git/config." : SAVE_DISABLED_HINT);
  }

  /** Deep compare the live draft with the snapshot the page was rendered from. */
  private isDirty(): boolean {
    if (this.snapshot === null) return false;
    const baseline = rowsFromSnapshot(this.snapshot);
    const active = this.rows.filter((row) => !row.deleted);
    if (active.length !== baseline.length) return true;
    return active.some((row, index) => {
      const original = baseline[index];
      return (
        row.name !== original.name ||
        row.fetchUrl !== original.fetchUrl ||
        normalizePush(row.pushUrl) !== normalizePush(original.pushUrl)
      );
    });
  }

  // ── save / reload ───────────────────────────────────────────────────────────

  private reload(): void {
    // A fresh git read first (so a caller whose refresh() is a no-op still sees git state),
    // then let the settings tab rebuild itself from git as well.
    this.render();
    this.host.refresh();
  }

  private save(): void {
    if (this.snapshot === null) return;
    const root = this.host.vaultRoot();

    // 1. Staleness: apply nothing if `.git/config` changed after this page was rendered.
    let fresh: RemotesSnapshot;
    try {
      fresh = readRemotes(root);
    } catch (error) {
      new Notice(`Could not re-read git remotes: ${errorText(error)}`, 8000);
      return;
    }
    if (!fresh.hasRepo || !sameRemoteConfig(fresh, this.snapshot)) {
      new Notice("Remotes changed outside settings - reloaded. Re-apply your edits.", 8000);
      this.host.refresh();
      return;
    }

    // 2. Validate the whole draft before running anything.
    const plan = planRemoteChanges(this.activeRows(), this.snapshot);
    this.clearIssues();
    if (plan.issues.length > 0) {
      this.showIssues(plan.issues);
      return;
    }

    // 3. Nothing to do (e.g. only cosmetic edits the plan ignores).
    if (plan.steps.length === 0) {
      this.host.refresh();
      return;
    }

    // 4. Removals need explicit confirmation (extra warning for annex-uuid remotes).
    if (plan.steps.some((step) => step.kind === "remove")) {
      const removals = plan.steps
        .filter((step) => step.kind === "remove")
        .map((step) => ({
          name: step.name,
          hasAnnexUuid: this.snapshot?.gitRemotes.find((remote) => remote.name === step.name)?.hasAnnexUuid ?? false,
        }));
      new RemoveRemotesModal(this.host.app, removals, () => this.applyPlan(root, plan)).open();
      return;
    }

    // 5. Apply.
    this.applyPlan(root, plan);
  }

  private applyPlan(root: string, plan: RemotePlan): void {
    let result: RemoteApplyResult;
    try {
      result = applyRemotePlan(root, plan);
    } catch (error) {
      new Notice(
        `Remotes not fully saved: ${errorText(error)}. Applied 0 of ${plan.steps.length} commands.`,
        12000,
      );
      this.host.refresh();
      return;
    }

    if (!result.ok) {
      const applied = result.results.filter((entry) => entry.ok).length;
      const detail =
        result.results.find((entry) => !entry.ok)?.detail?.trim() ||
        result.failed?.args.join(" ") ||
        "git failed";
      const describe = result.failed?.describe ?? "change";
      new Notice(
        `Remotes not fully saved: ${describe} failed (${detail}). ` +
          `Applied ${applied} of ${plan.steps.length} commands.`,
        12000,
      );
      this.host.refresh();
      return;
    }

    new Notice(`Saved remotes (${plan.steps.length} change${plan.steps.length === 1 ? "" : "s"}).`, 4000);
    this.host.refresh();
  }

  // ── validation feedback ─────────────────────────────────────────────────────

  private clearIssues(): void {
    if (this.summaryEl !== null) this.summaryEl.setText("");
    for (const refs of this.refs) {
      if (refs === undefined) continue;
      refs.el.removeClass("annex-remote-row-invalid");
      refs.nameInput.removeClass("annex-remote-field-invalid");
      refs.fetchInput.removeClass("annex-remote-field-invalid");
      refs.pushInput?.removeClass("annex-remote-field-invalid");
      refs.errorEl.setText("");
    }
  }

  private showIssues(issues: RemoteIssue[]): void {
    if (this.summaryEl !== null) {
      this.summaryEl.setText(issues.map((issue) => issue.message).join(" "));
    }
    for (const issue of issues) {
      if (issue.row === null) continue;
      const draftIndex = this.activeIndices[issue.row];
      const refs = this.refs[draftIndex];
      if (refs === undefined) continue;
      refs.el.addClass("annex-remote-row-invalid");
      const input =
        issue.field === "name"
          ? refs.nameInput
          : issue.field === "fetchUrl"
            ? refs.fetchInput
            : issue.field === "pushUrl"
              ? refs.pushInput
              : null;
      input?.addClass("annex-remote-field-invalid");
      refs.errorEl.setText(issue.message);
    }
  }

  // ── read-only sections ──────────────────────────────────────────────────────

  /** Multi-URL remotes: shown for transparency only; edit them with `git remote` in a terminal. */
  private renderMultiUrlRemotes(card: HTMLElement, snapshot: RemotesSnapshot): void {
    const multiUrl = snapshot.gitRemotes.filter((remote) => remote.kind === "multi-url");
    if (multiUrl.length === 0) return;

    const section = card.createDiv({ cls: "annex-remotes-multi" });
    section.createEl("h4", { cls: "annex-remotes-subtitle", text: "Read-only remotes" });
    section.createDiv({
      cls: "annex-remotes-hint",
      text: "These remotes have more than one URL; the editor only handles single-URL remotes.",
    });
    const list = section.createDiv({ cls: "annex-remote-readonly-list" });
    for (const remote of multiUrl) {
      const row = list.createDiv({ cls: "annex-remote-readonly-row" });
      row.setAttr("data-remote", remote.name);
      row.createSpan({ cls: "annex-remote-readonly-name", text: remote.name });
      for (const url of remote.fetchUrls) {
        row.createSpan({ cls: "annex-remote-readonly-url", text: `fetch: ${url}` });
      }
      for (const url of remote.pushUrls) {
        row.createSpan({ cls: "annex-remote-readonly-url", text: `push: ${url}` });
      }
      row.createSpan({ cls: "annex-remote-readonly-badge", text: MULTI_URL_LABEL });
    }
  }

  /** git-annex special remotes: read-only; managed with `git annex initremote` / `enableremote`. */
  private renderSpecialRemotes(card: HTMLElement, snapshot: RemotesSnapshot): void {
    const section = card.createDiv({ cls: "annex-special-remotes" });
    section.createEl("h4", { cls: "annex-special-remotes-title", text: "git-annex special remotes" });

    const hint = section.createDiv({ cls: "annex-special-remotes-hint" });
    hint.createSpan({ text: "Special remotes are managed with " });
    hint.createEl("code", { text: "git annex initremote" });
    hint.createSpan({ text: " / " });
    hint.createEl("code", { text: "git annex enableremote" });
    hint.createSpan({
      text: " in a terminal — the plugin never creates, edits or removes them. Documentation: ",
    });
    const link = hint.createEl("a", {
      cls: "annex-special-remotes-doc-link",
      text: "git-annex special remotes",
    });
    link.setAttr("href", SPECIAL_REMOTES_DOC_URL);
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    const list = section.createDiv({ cls: "annex-special-remote-list" });
    if (snapshot.specialRemotes.length === 0) {
      list.createDiv({ cls: "annex-special-remotes-empty", text: "No git-annex special remotes." });
      return;
    }

    for (const remote of snapshot.specialRemotes) {
      const row = list.createDiv({ cls: "annex-special-remote-row" });
      row.setAttr("data-remote", remote.name);
      row.createSpan({ cls: "annex-special-remote-name", text: remote.name });

      const docUrl = docUrlFor(remote);
      const typeLink = row.createEl("a", {
        cls: "annex-special-remote-type",
        text: remote.type === "" ? "unknown type" : remote.type,
      });
      typeLink.setAttr("href", docUrl);
      typeLink.setAttr("target", "_blank");
      typeLink.setAttr("rel", "noopener");

      if (remote.mainSetting !== null) {
        row.createSpan({
          cls: "annex-special-remote-setting",
          text: `${remote.mainSetting.key}: ${remote.mainSetting.value}`,
        });
      }
      if (remote.hasAnnexUuid) {
        row.createSpan({ cls: "annex-special-remote-uuid", text: "annex-uuid" });
      }
    }
  }
}
