/**
 * ArtifactPanel renders the right-hand pane: the live analysis notebook.
 *
 * The notebook is a markdown file on disk (maintained by the Loom brain) that
 * records the plan, steps, decisions, and Galaxy references. The panel simply
 * renders whatever markdown the brain emits via the Notebook widget.
 */

import { marked } from "marked";

const EMPTY_STATE_HTML = `
  <div class="empty-state">
    <p>The notebook is the running log of your analysis — plan, steps, decisions, and Galaxy references — persisted to a markdown file in your working directory and committed to git on every change.</p>
    <p>It'll appear here once you start a plan. Type <code>/notebook</code> anytime to refresh.</p>
  </div>
`;

export class ArtifactPanel {
  private viewEl: HTMLElement;

  constructor() {
    this.viewEl = document.getElementById("notebook-view")!;
  }

  /** Replace the notebook view with rendered markdown. */
  setNotebookMarkdown(markdown: string): void {
    this.viewEl.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "result-block notebook-dump";
    const content = document.createElement("div");
    content.className = "result-markdown";
    content.innerHTML = marked.parse(markdown || "", { async: false }) as string;
    wrapper.appendChild(content);
    this.viewEl.appendChild(wrapper);
  }

  /** Reset to the initial empty state. */
  clear(): void {
    this.viewEl.innerHTML = EMPTY_STATE_HTML;
  }
}
