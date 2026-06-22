/**
 * ArtifactPanel renders the right-hand pane with three tabs:
 *   Notebook, Activity, File.
 *
 * - Notebook tab: the analysis notebook, shown either as locally-rendered
 *   markdown (default — fast, offline, always available) or as the server-side
 *   Galaxy page in a locked-down <webview> (full fidelity). A segmented control
 *   toggles between them; the choice persists in localStorage. Galaxy mode
 *   degrades to a guiding fallback when not connected / not bound.
 * - Activity tab: live shell stream + proc-monitor table. The DOM for both
 *   sub-sections lives in index.html and is driven by app.ts (ShellPanel,
 *   renderProcs); this class only owns tab visibility.
 * - File tab: hidden until a file is opened from the files sidebar.
 */

import { Marked } from "marked";
import { renderMarkdown } from "../chat/markdown.js";
import { GALAXY_EMBED_PARTITION } from "../../main/embed-partition.js";
import {
  NOTEBOOK_VIEW_MODE_KEY,
  canUseGalaxyView,
  parseStoredViewMode,
  resolveNotebookView,
  shouldReloadEmbed,
  type NotebookEmbedState,
  type NotebookViewMode,
} from "./notebook-view-model.js";
import type { NotebookEmbedPayload } from "../../../../shared/loom-shell-contract.js";

// Dedicated Marked instance for the notebook pane. Relative image srcs (e.g.
// `10_figures/foo.png`) are rewritten to the `orbit-artifact://` scheme served
// by the main process out of the current analysis cwd. Chat messages keep the
// default `marked` so agent-authored URLs aren't touched.
const notebookMarked = new Marked({
  renderer: {
    image({ href, title, text }) {
      const rewritten = rewriteArtifactHref(href);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(rewritten)}" alt="${escapeAttr(text)}"${titleAttr}>`;
    },
    link({ href, title, tokens }) {
      const rewritten = rewriteArtifactHref(href);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      // Render inner text the same way marked does by default — parse the
      // token stream recursively so nested emphasis / code survives.
      const inner = this.parser.parseInline(tokens);
      return `<a href="${escapeAttr(rewritten)}"${titleAttr}>${inner}</a>`;
    },
  },
});

function rewriteArtifactHref(href: string): string {
  // Leave absolute URLs and protocol-relative URLs alone.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
  return `orbit-artifact://cwd/${href.replace(/^\/+/, "")}`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const NOTEBOOK_EMPTY_HTML = `
  <div class="empty-state">
    <p>The notebook is the running log of your analysis — plan, steps, decisions, and Galaxy references — persisted to a markdown file in your working directory and committed to git on every change.</p>
    <p>It'll appear here once you start a plan. Type <code>/notebook</code> anytime to refresh.</p>
  </div>
`;

const FALLBACK_HTML: Record<"disconnected" | "unbound" | "error", string> = {
  disconnected: `
    <div class="empty-state">
      <p>Connect to Galaxy to view the server-rendered notebook here, with live dataset displays and visualizations.</p>
      <p>The <strong>Markdown</strong> view above is always available offline.</p>
    </div>`,
  unbound: `
    <div class="empty-state">
      <p>This notebook isn't synced to a Galaxy page yet.</p>
      <p>Run <code>/sync push</code> to publish it, then switch to the <strong>Galaxy</strong> view for full fidelity.</p>
    </div>`,
  error: `
    <div class="empty-state">
      <p>Couldn't load the Galaxy view.</p>
      <p><button type="button" class="nb-galaxy-retry">Retry</button> or use the <strong>Markdown</strong> view.</p>
    </div>`,
};

type TabKey = "notebook" | "activity" | "file";

/** Minimal slice of Electron's <webview> element we drive. */
interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
}

export class ArtifactPanel {
  private notebookEl: HTMLElement;
  private notebookContentEl: HTMLElement;
  private notebookToolbarEl: HTMLElement;
  private modeButtons: HTMLButtonElement[];
  private activityEl: HTMLElement;
  private fileEl: HTMLElement;
  private fileTabBtn: HTMLButtonElement;
  private tabButtons: HTMLButtonElement[];
  private activeTab: TabKey = "notebook";
  private lastNotebookMarkdown: string | null = null;

  private viewMode: NotebookViewMode;
  private embedState: NotebookEmbedState = { payload: null, connected: false };
  private galaxyWebview: WebviewElement | null = null;

  /** Optional callback fired when the user clicks the File-tab close (×). */
  onFileTabClose: (() => void) | null = null;

  constructor() {
    this.notebookEl = document.getElementById("notebook-view")!;
    this.notebookContentEl = document.getElementById("notebook-view-content")!;
    this.notebookToolbarEl = document.getElementById("notebook-view-toolbar")!;
    this.modeButtons = Array.from(
      this.notebookToolbarEl.querySelectorAll<HTMLButtonElement>("[data-nb-mode]"),
    );
    this.activityEl = document.getElementById("activity-view")!;
    this.fileEl = document.getElementById("file-view")!;
    this.tabButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#artifact-tabs .pane-tab"),
    );
    const fileBtn = this.tabButtons.find((b) => b.dataset.tab === "file");
    if (!fileBtn) throw new Error("artifact pane: missing File tab button");
    this.fileTabBtn = fileBtn;

    this.viewMode = parseStoredViewMode(localStorage.getItem(NOTEBOOK_VIEW_MODE_KEY));

    for (const btn of this.tabButtons) {
      btn.addEventListener("click", (e) => {
        // Don't switch to the file tab if the user clicked the close (×).
        const target = e.target as HTMLElement | null;
        if (target?.classList.contains("pane-tab-close")) return;
        const tab = btn.dataset.tab as TabKey | undefined;
        if (tab) this.selectTab(tab);
      });
    }

    for (const btn of this.modeButtons) {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.nbMode as NotebookViewMode | undefined;
        if (mode) this.setViewMode(mode);
      });
    }

    const fileTabClose = document.getElementById("file-tab-close");
    fileTabClose?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideFileTab();
      this.onFileTabClose?.();
    });

    this.syncModeButtons();
  }

  /** Returns the File tab container so the FileViewer can mount its DOM. */
  getFileViewContainer(): HTMLElement {
    return this.fileEl;
  }

  /** Reveal the File tab (if hidden) and switch to it. */
  showFileTab(): void {
    this.fileTabBtn.hidden = false;
    this.selectTab("file");
  }

  /**
   * Hide the File tab. If the File tab is currently active, switch back to
   * the notebook tab.
   */
  hideFileTab(): void {
    this.fileTabBtn.hidden = true;
    if (this.activeTab === "file") {
      this.selectTab("notebook");
    }
  }

  /** Replace the notebook markdown content (cached for the Markdown view). */
  setNotebookMarkdown(markdown: string): void {
    // Only cache non-empty content so a blank early widget doesn't clobber
    // a real notebook on the next display:resume re-render.
    if (markdown.trim()) this.lastNotebookMarkdown = markdown;
    this.updateToolbarVisibility();
    // Galaxy mode keeps showing the webview; markdown is just cached for the
    // switch back. Only re-paint when Markdown is the active view.
    if (this.viewMode === "markdown") this.renderNotebookView();
  }

  /** Latest NotebookEmbed widget payload (binding/embed state). */
  setNotebookEmbed(payload: NotebookEmbedPayload | null): void {
    const prev = this.embedState.payload;
    const wasAvailable = canUseGalaxyView(this.embedState);
    this.embedState = { ...this.embedState, payload };
    this.updateToolbarVisibility();
    this.syncModeButtons();
    // Only repaint Galaxy mode when availability flips or the embed target
    // actually changed (e.g. a /sync push advanced the revision → fresh &rev=),
    // so a no-op re-emit doesn't reload the webview mid-scroll.
    if (
      this.viewMode === "galaxy" &&
      (canUseGalaxyView(this.embedState) !== wasAvailable || shouldReloadEmbed(prev, payload))
    ) {
      this.renderNotebookView();
    }
  }

  /** Galaxy connection state — gates the Galaxy view's availability. */
  setGalaxyConnected(connected: boolean): void {
    if (this.embedState.connected === connected) return;
    this.embedState = { ...this.embedState, connected };
    this.syncModeButtons();
    if (this.viewMode === "galaxy") this.renderNotebookView();
  }

  /** Re-render the last known non-empty notebook content. No-op if never set. */
  reRenderNotebook(): void {
    if (this.lastNotebookMarkdown) this.renderNotebookView();
  }

  /**
   * Called on cwd change so a wake-from-sleep after switching projects
   * doesn't re-render the prior project's notebook over the new session.
   */
  clearNotebook(): void {
    this.lastNotebookMarkdown = null;
    this.embedState = { ...this.embedState, payload: null };
    this.teardownGalaxyWebview();
    this.notebookContentEl.innerHTML = "";
    this.updateToolbarVisibility();
    this.syncModeButtons();
  }

  hasNotebookContent(): boolean {
    return this.lastNotebookMarkdown !== null;
  }

  /** Switch the visible tab without touching the stored content. */
  selectTab(tab: TabKey): void {
    this.activeTab = tab;
    for (const btn of this.tabButtons) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    this.notebookEl.classList.toggle("hidden", tab !== "notebook");
    this.activityEl.classList.toggle("hidden", tab !== "activity");
    this.fileEl.classList.toggle("hidden", tab !== "file");
  }

  /**
   * Reset notebook to its empty placeholder + switch to the Notebook tab.
   * Must null the cache too -- a later display:resume would otherwise re-
   * render the cleared session's stale notebook via reRenderNotebook.
   */
  clear(): void {
    this.lastNotebookMarkdown = null;
    this.embedState = { ...this.embedState, payload: null };
    this.teardownGalaxyWebview();
    this.notebookContentEl.innerHTML = NOTEBOOK_EMPTY_HTML;
    this.updateToolbarVisibility();
    this.syncModeButtons();
    this.selectTab("notebook");
  }

  // ── Notebook view mode (Markdown ↔ Galaxy) ──────────────────────────────────

  private setViewMode(mode: NotebookViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    localStorage.setItem(NOTEBOOK_VIEW_MODE_KEY, mode);
    this.syncModeButtons();
    this.renderNotebookView();
  }

  private syncModeButtons(): void {
    const galaxyEnabled = canUseGalaxyView(this.embedState);
    for (const btn of this.modeButtons) {
      const mode = btn.dataset.nbMode as NotebookViewMode;
      btn.classList.toggle("active", mode === this.viewMode);
      // Galaxy is always clickable (it shows a guiding fallback when not ready);
      // mark it disabled-looking only for affordance.
      if (mode === "galaxy") btn.classList.toggle("seg-btn-unavailable", !galaxyEnabled);
    }
  }

  private updateToolbarVisibility(): void {
    const hasContent =
      this.lastNotebookMarkdown !== null || Boolean(this.embedState.payload?.bound);
    this.notebookToolbarEl.classList.toggle("hidden", !hasContent);
  }

  /** Paint the notebook content area according to the current mode + state. */
  private renderNotebookView(): void {
    const view = resolveNotebookView(this.viewMode, this.embedState);
    if (view.kind === "galaxy") {
      this.showGalaxyWebview(view.embedUrl);
      return;
    }
    // Any non-Galaxy view tears down the remote content.
    this.teardownGalaxyWebview();
    if (view.kind === "markdown") {
      this.renderMarkdownContent();
    } else {
      this.renderFallback(view.reason);
    }
  }

  private renderMarkdownContent(): void {
    this.notebookContentEl.innerHTML = "";
    if (this.lastNotebookMarkdown === null) {
      this.notebookContentEl.innerHTML = NOTEBOOK_EMPTY_HTML;
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "result-block notebook-dump";
    const content = document.createElement("div");
    content.className = "result-markdown";
    content.innerHTML = renderMarkdown(this.lastNotebookMarkdown, notebookMarked);
    wrapper.appendChild(content);
    this.notebookContentEl.appendChild(wrapper);
  }

  private renderFallback(reason: "disconnected" | "unbound" | "error"): void {
    this.notebookContentEl.innerHTML = FALLBACK_HTML[reason];
    const retry = this.notebookContentEl.querySelector<HTMLButtonElement>(".nb-galaxy-retry");
    retry?.addEventListener("click", () => this.renderNotebookView());
  }

  private showGalaxyWebview(embedUrl: string): void {
    let wv = this.galaxyWebview;
    if (!wv) {
      this.notebookContentEl.innerHTML = "";
      wv = document.createElement("webview") as WebviewElement;
      wv.className = "notebook-galaxy-webview";
      wv.setAttribute("partition", GALAXY_EMBED_PARTITION);
      // Cross-origin remote content: do not allow it to reach our preload world.
      wv.setAttribute("allowpopups", "false");
      wv.addEventListener("did-fail-load", (e) => {
        // Ignore aborted in-flight loads (e.g. a src swap); surface real errors.
        const ev = e as unknown as { errorCode?: number; isMainFrame?: boolean };
        if (ev.errorCode === -3) return; // ERR_ABORTED
        if (ev.isMainFrame === false) return;
        this.teardownGalaxyWebview();
        this.renderFallback("error");
      });
      this.notebookContentEl.appendChild(wv);
      this.galaxyWebview = wv;
    }
    if (wv.getAttribute("src") !== embedUrl) {
      wv.setAttribute("src", embedUrl);
    }
  }

  private teardownGalaxyWebview(): void {
    if (this.galaxyWebview) {
      this.galaxyWebview.remove();
      this.galaxyWebview = null;
    }
  }
}
