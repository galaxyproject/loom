/**
 * `/dashboard` -- the user's own handle on the layout.
 *
 * Deterministic and model-free on purpose. Asking the agent to reset a layout
 * costs a turn, can be misread, and is refused outright when the panels in the
 * way are the user's own -- which is exactly right for the agent and exactly
 * wrong for the person whose dashboard it is. So the destructive operations
 * live here, where the user types them, and the provenance guard the tools run
 * under does not apply: the user is allowed to throw away their own panels.
 *
 * `undo` is here for the same reason. The pane has its own undo, but the
 * terminal has no pane at all, and an agent change the user cannot reverse
 * without one is not undoable in any sense that matters.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DASHBOARD_PRESETS,
  createDefaultDashboardDocument,
  dashboardFromPreset,
} from "../../shared/dashboard-contract.js";
import type { DashboardDocument } from "../../shared/dashboard-contract.js";
import {
  commitDashboardChange,
  countPanels,
  isProtectedPanel,
  landedLine,
  logDashboardChange,
  summarizeDocument,
} from "./dashboard-tools";
import {
  readDashboardDocument,
  replaceDashboardDocument,
  undoDashboardChange,
} from "./dashboard-store";

const USAGE =
  "Usage: /dashboard (show the layout) | /dashboard preset <name> | /dashboard reset | /dashboard undo";

function presetList(): string {
  return DASHBOARD_PRESETS.map((p) => `  ${p.id} -- ${p.description}`).join("\n");
}

/** How many of the panels about to be discarded were the user's own. */
function userPanelsIn(document: DashboardDocument): number {
  return document.dashboards.reduce(
    (total, d) => total + d.panels.filter(isProtectedPanel).length,
    0,
  );
}

function discardNote(before: DashboardDocument): string {
  const count = userPanelsIn(before);
  if (count === 0) return "";
  return `\nThis replaced ${count} panel(s) you had placed. /dashboard undo puts them back.`;
}

async function showLayout(ctx: ExtensionContext): Promise<void> {
  const read = await readDashboardDocument();
  if (!read.ok) {
    ctx.ui.notify(read.error, "warning");
    return;
  }
  const lines = [
    read.exists
      ? `Dashboard layout (${countPanels(read.document)} panel(s)) -- ${read.path}`
      : "No layout file yet. This is the default you would see:",
    ...summarizeDocument(read.document),
  ];
  if (read.problems.length > 0) {
    lines.push(
      "",
      "The file on disk had problems and was left alone:",
      ...read.problems.map((p) => `  ${p.path || "document"}: ${p.message}`),
    );
  }
  lines.push("", `Presets:\n${presetList()}`, USAGE);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function applyPreset(ctx: ExtensionContext, presetId: string): Promise<void> {
  if (!presetId) {
    ctx.ui.notify(`Which preset?\n${presetList()}`, "warning");
    return;
  }
  if (!dashboardFromPreset(presetId)) {
    ctx.ui.notify(`No preset "${presetId}".\n${presetList()}`, "error");
    return;
  }

  let discarded = "";
  const outcome = await commitDashboardChange(
    (current) => {
      const preset = dashboardFromPreset(presetId);
      if (!preset) return { ok: false, error: `No preset "${presetId}".` };
      const existing = current.dashboards.findIndex((d) => d.id === preset.id);
      const next: DashboardDocument = {
        ...current,
        dashboards: current.dashboards.slice(),
      };
      if (existing >= 0) {
        discarded = discardNote({ ...current, dashboards: [current.dashboards[existing]] });
        next.dashboards[existing] = preset;
      } else {
        next.dashboards.push(preset);
      }
      next.activeId = preset.id;
      return { ok: true, document: next, notes: [`applied the ${preset.id} preset`] };
    },
    { asUser: true },
  );

  if (!outcome.ok) {
    ctx.ui.notify(outcome.error, "error");
    return;
  }
  logDashboardChange(outcome.path, outcome.notes, "/dashboard preset");
  ctx.ui.notify(
    [`Dashboard set to the ${presetId} preset.`, ...summarizeDocument(outcome.document)].join(
      "\n",
    ) +
      discarded +
      `\n${landedLine()}`,
    "info",
  );
}

/**
 * The documented way out of a layout nothing else can cope with, so it must not
 * depend on being able to read that layout: a file past the size cap, or
 * corrupt in a way the validator refuses, is exactly when someone types this.
 * That means no compare-and-swap either -- "whatever is there, give me the
 * default" has nothing to conflict with.
 */
async function resetLayout(ctx: ExtensionContext): Promise<void> {
  const before = await readDashboardDocument();
  const discarded = before.ok ? discardNote(before.document) : "";

  const outcome = await replaceDashboardDocument(createDefaultDashboardDocument());
  if (!outcome.ok) {
    ctx.ui.notify(outcome.error, "error");
    return;
  }
  logDashboardChange(outcome.path, ["reset to the default layout"], "/dashboard reset");
  ctx.ui.notify(
    ["Dashboard reset to the default layout.", ...summarizeDocument(outcome.document)].join("\n") +
      discarded +
      (outcome.undoable === false
        ? "\nThe layout it replaced was too large to hold, so this one cannot be undone."
        : "") +
      `\n${landedLine()}`,
    "info",
  );
}

async function undoLayout(ctx: ExtensionContext): Promise<void> {
  const outcome = await undoDashboardChange();
  if (!outcome.ok) {
    ctx.ui.notify(outcome.error, "warning");
    return;
  }
  ctx.ui.notify(
    outcome.restored === "none"
      ? `Undone: the dashboard is back to the default layout.\n${landedLine()}`
      : `Undone: the previous dashboard layout is back.\n${landedLine()}`,
    "info",
  );
}

export function registerDashboardCommands(pi: ExtensionAPI): void {
  pi.registerCommand("dashboard", {
    description:
      "Show the dashboard layout. Subcommands: preset <name> | reset | undo (the last change).",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      try {
        if (!sub) return await showLayout(ctx);
        if (sub === "preset") return await applyPreset(ctx, parts[1] ?? "");
        if (sub === "reset") return await resetLayout(ctx);
        if (sub === "undo") return await undoLayout(ctx);
        ctx.ui.notify(`Unknown /dashboard subcommand: ${sub}.\n${USAGE}`, "warning");
      } catch (err) {
        ctx.ui.notify(
          `/dashboard ${sub}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
