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
 */
import type { App } from "obsidian";

export interface RemotesEditorHost {
  /** Obsidian `App` — needed for the removal confirm modal. */
  app: App;
  /** Absolute path of the vault (the git work tree root or a directory inside it). */
  vaultRoot(): string;
  /** Re-render the settings tab from git state (after save / reload). */
  refresh(): void;
}

export class RemotesEditor {
  constructor(
    private readonly container: HTMLElement,
    private readonly host: RemotesEditorHost,
  ) {}

  /** TODO(ui): render the editor. */
  render(): void {
    void this.host;
    this.container.empty();
    this.container.createDiv({
      cls: "annex-remotes-card",
    }).createDiv({ cls: "annex-remotes-hint", text: "Remote settings are being rebuilt." });
  }
}
