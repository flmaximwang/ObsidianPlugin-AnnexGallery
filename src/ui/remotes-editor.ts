/**
 * Remotes editor — the settings-page section that reads `.git/config` and writes back
 * only on an explicit Save.
 *
 * Contract (implemented by the UI slice, consumed by the settings tab):
 *   `new RemotesEditor(container, host).render()`
 *     - reads the snapshot synchronously via `readRemotes(host.vaultRoot())`;
 *     - keeps the draft rows in memory only — no data.json, no plugin settings;
 *     - rebuilds **only this card** after a save / Reload / staleness abort, so the
 *       metadata-preset and gallery-template editors keep their half-typed input.
 *
 * The settings tab mounts it with:
 *   new RemotesEditor(container, {
 *     app: this.app,
 *     vaultRoot: () => this.host.vaultRoot(),
 *   }).render();
 *
 * Behaviour (annex-gallery-10m DESIGN 3/4/5/6/7/8/9):
 *   - `.git/config` is the single source of truth: the editor never persists rows.
 *   - Save re-reads git first (staleness check), validates the whole draft, then runs the
 *     ordered plan from `planRemoteChanges` — removals only after a confirm modal.
 *   - Multi-URL remotes and git-annex special remotes are read-only: the plugin never
 *     creates, edits or removes them (manage those with `git remote` / `git annex initremote`
 *     in a terminal). No transfer operation is ever started from here.
 *   - A `.git/config` git cannot parse is a read error, not "no remotes": the card shows
 *     git's stderr and a Reload button, and no editor is rendered (annex-gallery-0sn).
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
}

/** The git-annex special-remotes documentation index. */
export const SPECIAL_REMOTES_DOC_URL = "https://git-annex.branchable.com/special_remotes/";

const SECTION_TITLE = "Remotes";
const SAVE_HINT =
  "Read from .git/config. Changes are written back to git only when you click Save; " +
  "closing the settings page discards them.";
const NO_REPO_TEXT = "This vault is not a git repo yet. Run Initialize gallery first.";
const CONFIG_ERROR_HINT =
  "Fix .git/config (or restore it from a backup), then click Reload. " +
  "Remote editing stays disabled until git can read the config again.";
const MULTI_URL_LABEL = "multiple URLs - edit with git";
const NO_FETCH_URL_LABEL = "no fetch URL - edit with git";
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

/**
 * The special remote's type, read leniently: the core model may expose it as `type`
 * (plain / external) or as `baseType` / `externalType`.
 */
function specialRemoteType(remote: SpecialRemote): string {
  const raw = remote as unknown as Record<string, unknown>;
  for (const key of ["type", "baseType", "externalType"]) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** The special remote's main setting (e.g. the directory path), when the model provides one. */
function specialRemoteMainSetting(remote: SpecialRemote): { key: string; value: string } | null {
  const raw = remote as unknown as Record<string, unknown>;
  const main = raw["mainSetting"];
  if (main !== null && typeof main === "object") {
    const entry = main as { key?: unknown; value?: unknown };
    if (typeof entry.key === "string" && entry.key !== "") {
      return { key: entry.key, value: typeof entry.value === "string" ? entry.value : "" };
    }
  }
  return null;
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

    // A broken `.git/config` is a real read error: show git's stderr instead of an empty
    // editor that would claim "No git remotes yet" and keep Save permanently disabled.
    if (snapshot.configError !== undefined) {
      this.renderConfigError(snapshot.configError);
      return;
    }

    if (!snapshot.hasRepo) {
      const card = this.container.createDiv({ cls: "annex-remotes-card" });
      card.createEl("h3", { cls: "annex-remotes-title", text: SECTION_TITLE });
      card.createDiv({ cls: "annex-remotes-no-repo", text: NO_REPO_TEXT });
      return;
    }

    this.rows = rowsFromSnapshot(snapshot)
      // A remote without exactly one fetch URL (multi-URL / pushurl-only) is read-only.
      .filter((row) => {
        const remote = snapshot.gitRemotes.find((entry) => entry.name === row.originalName);
        return remote === undefined || remote.fetchUrls.length === 1;
      })
      .map((row) => ({ ...row, deleted: false }));
    this.buildCard();
  }

  /** Drop the DOM handles (the container itself is cleared by render / buildCard). */
  private resetDomState(): void {
    this.refs = [];
    this.activeIndices = [];
    this.saveButton = null;
    this.summaryEl = null;
  }

  /**
   * The broken-`.git/config` state: git's stderr, a recovery hint and Reload only.
   *
   * No editable rows, no Save / Add remote and no "No git remotes yet": when the config
   * cannot be read the remotes are unknown, so an empty list would be a lie. Reload
   * re-reads git, which is the way back once the config is repaired (annex-gallery-0sn).
   */
  private renderConfigError(message: string): void {
    const card = this.container.createDiv({ cls: "annex-remotes-card" });
    card.createEl("h3", { cls: "annex-remotes-title", text: SECTION_TITLE });
    card.createDiv({ cls: "annex-remotes-error", text: `Could not read git remotes: ${message}` });
    card.createDiv({ cls: "annex-remotes-hint", text: CONFIG_ERROR_HINT });

    const toolbar = card.createDiv({ cls: "annex-remotes-toolbar" });
    const reloadButton = toolbar.createEl("button", { cls: "annex-remotes-reload", text: RELOAD_TEXT });
    reloadButton.setAttr("title", "Re-read git after fixing .git/config.");
    reloadButton.addEventListener("click", () => this.reload());
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
    this.renderReadOnlyRemotes(card, snapshot);
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

  /**
   * Identity-based dirty check (never positional): the draft is dirty when it adds a remote,
   * drops one, or changes a kept remote's name / fetch URL / push URL.
   *
   * Comparing by position was wrong: deleting "a" and adding a new "a" with the same URL
   * lined up with the snapshot and left Save disabled, although the plan would have run
   * `git remote remove a` + `git remote add a …` (real work).
   */
  private isDirty(): boolean {
    if (this.snapshot === null) return false;
    const baseline = new Map<string, GitRemote>();
    for (const remote of this.snapshot.gitRemotes) {
      if (remote.kind === "git") baseline.set(remote.name, remote);
    }

    const kept = new Set<string>();
    for (const row of this.rows) {
      if (row.deleted) {
        // A new row that was dropped again is net zero; an existing remote is a removal.
        if (row.originalName !== "") return true;
        continue;
      }
      if (row.originalName === "") return true; // a new remote to add
      const original = baseline.get(row.originalName);
      if (original === undefined) return true;
      kept.add(row.originalName);
      if (row.name.trim() !== original.name.trim()) return true;
      if (row.fetchUrl.trim() !== (original.fetchUrls[0] ?? "").trim()) return true;
      if (normalizePush(row.pushUrl).trim() !== normalizePush(original.pushUrls[0] ?? null).trim()) return true;
    }

    // Every remote the snapshot had must still be represented by a kept row.
    if (kept.size !== baseline.size) return true;
    for (const name of baseline.keys()) if (!kept.has(name)) return true;
    return false;
  }

  // ── save / reload ───────────────────────────────────────────────────────────

  /** Reload = Revert: re-read git and rebuild this card (other editors are untouched). */
  private reload(): void {
    this.render();
  }

  private save(): void {
    if (this.snapshot === null) return;
    const root = this.host.vaultRoot();

    // 1. Staleness: apply nothing if `.git/config` changed after this page was rendered.
    const fresh = this.readSnapshot(root);
    if (fresh === null) return;
    if (!fresh.hasRepo || !sameRemoteConfig(fresh, this.snapshot)) {
      this.abortStale();
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
      this.render();
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
      new RemoveRemotesModal(this.host.app, removals, () => this.confirmRemoval(root)).open();
      return;
    }

    // 5. Apply.
    this.applyPlan(root, plan);
  }

  /**
   * Confirm handler of the removal dialog.
   *
   * The dialog can stay open indefinitely, so git is re-read and the plan is rebuilt here:
   * a terminal edit during the dialog must not lead to a stale `git remote remove` /
   * `git remote rename` (annex-gallery-vps). Nothing is written when the config changed.
   */
  private confirmRemoval(root: string): void {
    if (this.snapshot === null) return;

    const fresh = this.readSnapshot(root);
    if (fresh === null) return;
    if (!fresh.hasRepo || !sameRemoteConfig(fresh, this.snapshot)) {
      this.abortStale();
      return;
    }

    const plan = planRemoteChanges(this.activeRows(), this.snapshot);
    this.clearIssues();
    if (plan.issues.length > 0) {
      // The draft no longer validates (the repository changed underneath): write nothing.
      this.abortStale();
      return;
    }
    this.applyPlan(root, plan);
  }

  /** Re-read git; null when the read failed (a notice explains why). */
  private readSnapshot(root: string): RemotesSnapshot | null {
    try {
      return readRemotes(root);
    } catch (error) {
      new Notice(`Could not re-read git remotes: ${errorText(error)}`, 8000);
      return null;
    }
  }

  /** Staleness abort: nothing is applied, this card is rebuilt from git. */
  private abortStale(): void {
    new Notice("Remotes changed outside settings - reloaded. Re-apply your edits.", 8000);
    this.render();
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
      this.render();
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
      this.render();
      return;
    }

    new Notice(`Saved remotes (${plan.steps.length} change${plan.steps.length === 1 ? "" : "s"}).`, 4000);
    this.render();
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

  /**
   * Remotes the editor cannot edit, shown for transparency only:
   *   - multi-URL remotes (more than one fetch URL or more than one push URL);
   *   - pushurl-only remotes (no fetch URL at all).
   * Both are edited with `git remote` in a terminal.
   */
  private renderReadOnlyRemotes(card: HTMLElement, snapshot: RemotesSnapshot): void {
    const readOnly = snapshot.gitRemotes.filter(
      (remote) => remote.kind !== "git" || remote.fetchUrls.length === 0,
    );
    if (readOnly.length === 0) return;

    const section = card.createDiv({ cls: "annex-remotes-multi" });
    section.createEl("h4", { cls: "annex-remotes-subtitle", text: "Read-only remotes" });
    section.createDiv({
      cls: "annex-remotes-hint",
      text: "These remotes have no single fetch URL; the editor only handles single-URL remotes.",
    });
    const list = section.createDiv({ cls: "annex-remote-readonly-list" });
    for (const remote of readOnly) {
      const row = list.createDiv({ cls: "annex-remote-readonly-row" });
      row.setAttr("data-remote", remote.name);
      row.createSpan({ cls: "annex-remote-readonly-name", text: remote.name });
      for (const url of remote.fetchUrls) {
        row.createSpan({ cls: "annex-remote-readonly-url", text: `fetch: ${url}` });
      }
      for (const url of remote.pushUrls) {
        row.createSpan({ cls: "annex-remote-readonly-url", text: `push: ${url}` });
      }
      // A remote without any fetch URL gets its own label: it is not a "multiple URLs" case.
      const label = remote.fetchUrls.length === 0 ? NO_FETCH_URL_LABEL : MULTI_URL_LABEL;
      row.createSpan({ cls: "annex-remote-readonly-badge", text: label });
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
      const type = specialRemoteType(remote);
      const typeLink = row.createEl("a", {
        cls: "annex-special-remote-type",
        text: type === "" ? "unknown type" : type,
      });
      typeLink.setAttr("href", docUrl);
      typeLink.setAttr("target", "_blank");
      typeLink.setAttr("rel", "noopener");

      const mainSetting = specialRemoteMainSetting(remote);
      if (mainSetting !== null) {
        row.createSpan({
          cls: "annex-special-remote-setting",
          text: `${mainSetting.key}: ${mainSetting.value}`,
        });
      }
      if (remote.hasAnnexUuid) {
        row.createSpan({ cls: "annex-special-remote-uuid", text: "annex-uuid" });
      }
    }
  }
}
