/**
 * ArtifactPanel renders the right-hand pane with three tabs:
 *   Notebook, Activity, File.
 *
 * - Notebook tab: live notebook.md markdown emitted by the brain.
 * - Activity tab: live shell stream + proc-monitor table. The DOM for both
 *   sub-sections lives in index.html and is driven by app.ts (ShellPanel,
 *   renderProcs); this class only owns tab visibility.
 * - File tab: hidden until a file is opened from the files sidebar.
 */

import { Marked } from "marked";
import { renderMarkdown } from "../chat/markdown.js";

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

type TabKey = "notebook" | "activity" | "file";

export class ArtifactPanel {
  private notebookEl: HTMLElement;
  private activityEl: HTMLElement;
  private fileEl: HTMLElement;
  private fileTabBtn: HTMLButtonElement;
  private tabButtons: HTMLButtonElement[];
  private activeTab: TabKey = "notebook";
  private lastNotebookMarkdown: string | null = null;

  /** Optional callback fired when the user clicks the File-tab close (×). */
  onFileTabClose: (() => void) | null = null;

  constructor() {
    this.notebookEl = document.getElementById("notebook-view")!;
    this.activityEl = document.getElementById("activity-view")!;
    this.fileEl = document.getElementById("file-view")!;
    this.tabButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#artifact-tabs .pane-tab"),
    );
    const fileBtn = this.tabButtons.find((b) => b.dataset.tab === "file");
    if (!fileBtn) throw new Error("artifact pane: missing File tab button");
    this.fileTabBtn = fileBtn;

    for (const btn of this.tabButtons) {
      btn.addEventListener("click", (e) => {
        // Don't switch to the file tab if the user clicked the close (×).
        const target = e.target as HTMLElement | null;
        if (target?.classList.contains("pane-tab-close")) return;
        const tab = btn.dataset.tab as TabKey | undefined;
        if (tab) this.selectTab(tab);
      });
    }

    const fileTabClose = document.getElementById("file-tab-close");
    fileTabClose?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideFileTab();
      this.onFileTabClose?.();
    });
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

  /** Replace the notebook view with rendered markdown. */
  setNotebookMarkdown(markdown: string): void {
    // Only cache non-empty content so a blank early widget doesn't clobber
    // a real notebook on the next display:resume re-render.
    if (markdown.trim()) this.lastNotebookMarkdown = markdown;
    this.notebookEl.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "result-block notebook-dump";
    const content = document.createElement("div");
    content.className = "result-markdown";
    content.innerHTML = renderMarkdown(markdown || "", notebookMarked);
    wrapper.appendChild(content);
    this.notebookEl.appendChild(wrapper);
  }

  /** Re-render the last known non-empty notebook content. No-op if never set. */
  reRenderNotebook(): void {
    if (this.lastNotebookMarkdown) this.setNotebookMarkdown(this.lastNotebookMarkdown);
  }

  /**
   * Called on cwd change so a wake-from-sleep after switching projects
   * doesn't re-render the prior project's notebook over the new session.
   */
  clearNotebook(): void {
    this.lastNotebookMarkdown = null;
    this.notebookEl.innerHTML = "";
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
    this.notebookEl.innerHTML = NOTEBOOK_EMPTY_HTML;
    this.selectTab("notebook");
  }
}
