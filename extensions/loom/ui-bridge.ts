/**
 * UI bridge — emits the Notebook widget when notebook.md changes.
 *
 * The Activity tab in shells is now driven directly by the renderer's
 * own shell + proc-monitor streams (Orbit) or terminal output (Loom CLI),
 * so no Activity widget is emitted from here. activity.jsonl is still
 * written on disk by the activity-hooks module for debug.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  onNotebookChange,
  getNotebookPath,
  getNotebookWidgetMode,
  setNotebookWidgetMode,
  readCurrentNotebook,
} from "./state.js";
import {
  LoomWidgetKey,
  encodeMarkdownWidget,
  encodeNotebookEmbed,
} from "../../shared/loom-shell-contract.js";
import { findGalaxyPageBlocks, stripGalaxyPageBlocks } from "./galaxy-page-binding.js";
import { stripSessionSummaryBlocks } from "./notebook-writer.js";
import { buildNotebookEmbed } from "./galaxy-embed.js";

/**
 * Project notebook.md to its human-facing display form by removing the
 * machine-housekeeping blocks: `loom-session` (durable session-lifecycle
 * history) and `loom-galaxy-page` (the Galaxy page binding). These are local
 * state, not content; the server-side Galaxy view already strips them on push
 * (galaxy-pages-sync.ts), so strip them here too — every shell that renders the
 * Notebook widget then shows only the narrative, not the bookkeeping. The blocks
 * stay on disk; only the rendered view hides them, and the binding is surfaced
 * separately via the NotebookEmbed widget.
 */
export function stripHousekeepingBlocks(content: string): string {
  return stripGalaxyPageBlocks(stripSessionSummaryBlocks(content));
}

/**
 * A notebook write that lands after session teardown fires the watcher
 * callback with a ctx pi has since invalidated; touching `ctx.ui` throws
 * "ctx is stale after session replacement or reload". Callers drop the
 * captured ctx and no-op on this. The deterministic fix closes the watcher on
 * shutdown; this guards any late-firing callback. #271
 */
function isStaleCtxError(err: unknown): boolean {
  return err instanceof Error && /ctx is stale/i.test(err.message);
}

export function setupUIBridge(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | null = null;
  const last = { notebookMd: "", embed: "" };

  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
  });

  // Resume gap (Bug 3): an already-bound notebook (e.g. a `--continue` resume)
  // must paint without waiting for a change. The root cause was ctx timing:
  // `initSessionArtifacts` already replays via `notifyNotebookChange` on every
  // session_start, but that fired before any ctx was captured (we only set it in
  // before_agent_start) so `emitNotebook` early-returned on `!latestCtx`.
  // Capturing ctx here lets that init-driven replay land. The explicit
  // `emitNotebook(readCurrentNotebook())` is the order-independent belt: if this
  // handler runs before init (notebookPath not yet set) it no-ops and init's
  // later replay emits; if it runs after, it emits and init's replay is deduped
  // (`last`). Either way the embed widget + Notebook pane paint exactly once.
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    const content = readCurrentNotebook();
    if (content !== null) emitNotebook(content);
  });

  function emitNotebook(content: string): void {
    if (!latestCtx) return;
    if (content === last.notebookMd) return;
    last.notebookMd = content;

    // Embed widget — binding/embed state for the server-side Galaxy iframe
    // view. Derived purely from the notebook's `loom-galaxy-page` block (one
    // per notebook today; take the first, null → unbound). Emitted on every
    // distinct notebook write, which covers connect / change / sync since each
    // routes through this same watcher. Independent of the Notebook pane's
    // hidden state — separate panes — so it runs before that gate. Shell-
    // neutral: no `embed_origin` baked in (the shell appends its own origin),
    // and the embed token is never in this payload (delivered out of band).
    const binding = findGalaxyPageBlocks(content)[0] ?? null;
    const embedLines = encodeNotebookEmbed(buildNotebookEmbed(binding));
    const embedKey = embedLines.join("\n");
    if (embedKey !== last.embed) {
      try {
        latestCtx.ui.setWidget(LoomWidgetKey.NotebookEmbed, embedLines);
        last.embed = embedKey;
      } catch (err) {
        if (!isStaleCtxError(err)) {
          console.error("notebook embed widget update failed:", err);
        }
        latestCtx = null;
        return;
      }
    }

    // Respect an explicit close: if the user hid the panel via /notebook,
    // don't reopen it on the next notebook write.
    if (getNotebookWidgetMode() === "hidden") return;
    const nbPath = getNotebookPath();
    const header = nbPath ? `> \`${nbPath}\`\n\n` : "";
    // Display projection: hide housekeeping blocks from the rendered Notebook
    // pane (the binding/session metadata is bookkeeping, not content).
    const displayContent = stripHousekeepingBlocks(content);
    try {
      latestCtx.ui.setWidget(LoomWidgetKey.Notebook, encodeMarkdownWidget(header + displayContent));
    } catch (err) {
      // Only the stale-ctx throw is expected here; surface anything else so a
      // genuine setWidget failure during an active session isn't hidden.
      if (!isStaleCtxError(err)) {
        console.error("notebook widget update failed:", err);
      }
      latestCtx = null;
      return;
    }
    setNotebookWidgetMode("open");
  }

  onNotebookChange(emitNotebook);
}
