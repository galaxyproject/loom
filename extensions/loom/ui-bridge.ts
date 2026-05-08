/**
 * UI bridge — emits the Notebook widget when notebook.md changes.
 *
 * The Activity tab in shells is now driven directly by the renderer's
 * own shell + proc-monitor streams (Orbit) or terminal output (Loom CLI),
 * so no Activity widget is emitted from here. activity.jsonl is still
 * written on disk by the activity-hooks module for debug.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { onNotebookChange, getNotebookPath } from "./state.js";
import { LoomWidgetKey, encodeMarkdownWidget } from "../../shared/loom-shell-contract.js";

export function setupUIBridge(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | null = null;
  const last = { notebookMd: "" };

  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
  });

  onNotebookChange((content) => {
    if (!latestCtx) return;
    if (content === last.notebookMd) return;
    last.notebookMd = content;
    const nbPath = getNotebookPath();
    const header = nbPath ? `> \`${nbPath}\`\n\n` : "";
    latestCtx.ui.setWidget(LoomWidgetKey.Notebook, encodeMarkdownWidget(header + content));
  });
}
