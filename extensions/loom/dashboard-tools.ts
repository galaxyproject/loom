/**
 * Dashboard tools -- how "show me my running jobs next to the plan" becomes a
 * layout.
 *
 * Two tools: one reads the layout document, one changes it. Both are
 * shell-neutral. The document is the same JSON the shells persist, validated by
 * the same `shared/dashboard-contract` validator, and writing it IS the
 * transport (see `dashboard-store.ts`) -- there is no separate widget message
 * for layout, and in the CLI the write simply happens with nothing attached to
 * read it.
 *
 * Two rules shape everything here, both from the curation design:
 *
 *   1. The agent changes the dashboard when the user asks, and never on its own
 *      initiative. That is stated in the tool description, where the model
 *      reads it.
 *   2. A panel the user placed or pinned is not the agent's to remove, move or
 *      rewrite. `provenanceViolations` enforces that on the finished document,
 *      so it holds for a wholesale replace exactly as it does for a patch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import {
  DASHBOARD_PRESETS,
  KNOWN_WIDGET_TYPES,
  MAX_DASHBOARDS,
  MAX_PANELS,
  dashboardFromPreset,
  parseDashboardDocument,
  validateDashboardDocument,
} from "../../shared/dashboard-contract.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  DashboardProblem,
} from "../../shared/dashboard-contract.js";
import { appendActivityEvent } from "./activity";
import { readDashboardDocument, updateDashboardDocument } from "./dashboard-store";
import { isDesktopShell } from "../../shared/orbit-env.js";

/** More than this in one call is a rewrite, and a rewrite should say so. */
const MAX_ACTIONS = 20;

/**
 * How much of the document `dashboard_read` will put in front of the model.
 *
 * The file may be up to 256 KB and a panel config can hold whatever a previous
 * write put there, so returning it whole would let one layout eat the context
 * window. Past this the summary carries the panel ids, which is what a write
 * actually needs.
 */
export const MAX_READ_CHARS = 20_000;

/**
 * And how much of everything else.
 *
 * Swapping the document out for the summary bounds nothing on its own: the
 * summary is built from ids and titles the agent itself writes into the file,
 * and nothing caps their length, so a 261 KB layout came back as a 170,866-
 * character tool result of which 170,014 was summary. The validation problems
 * are worse -- one of them quotes the rejected `activeId` back, so a 240,000-
 * character id becomes a 240,000-character diagnostic about a call that failed.
 *
 * Each of these is one budget spent across its whole field rather than a
 * per-entry cap: twenty problems at a thousand characters each is twenty
 * thousand characters, which is the cap over again.
 */
const MAX_SUMMARY_CHARS = 4_000;
const MAX_PROBLEM_CHARS = 2_000;
const MAX_PROBLEMS = 20;
const MAX_ERROR_CHARS = 2_000;
/** No dashboard's line is squeezed below this, however many there are. */
const MIN_SUMMARY_LINE_CHARS = 200;

/** Keep the head of one string, and say how much was dropped. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... (${text.length - max} more characters)`;
}

/** Keep whole lines until the budget runs out, then say how many were dropped. */
function capLines(lines: string[], budget: number, noun: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used >= budget) {
      kept.push(`... ${lines.length - kept.length} more ${noun} not shown`);
      return kept;
    }
    const capped = capText(line, budget - used);
    kept.push(capped);
    used += capped.length;
  }
  return kept;
}

/**
 * The summary as the model should see it: every dashboard, and a bound.
 *
 * Every dashboard, deliberately. Spending one budget head-first lets a single
 * crowded dashboard eat all of it and collapses the rest into "9 more not
 * shown" -- and when the document has been omitted too, the response tells the
 * model to work from the summary while `dashboard_read` takes no arguments, so
 * there is no second call that would fetch the rest. Each line gets its share
 * and loses its own tail instead.
 */
function cappedSummary(document: DashboardDocument): string[] {
  const lines = summarizeDocument(document);
  const share = Math.max(
    MIN_SUMMARY_LINE_CHARS,
    Math.floor(MAX_SUMMARY_CHARS / Math.max(1, lines.length)),
  );
  return capLines(
    lines.map((line) => capText(line, share)),
    MAX_SUMMARY_CHARS,
    "dashboard(s)",
  );
}

/**
 * Validation diagnostics as the model should see them, inside one shared
 * budget. Both fields are capped: a problem's `path` is structural, but its
 * `message` quotes the input.
 */
function cappedProblems(problems: DashboardProblem[]): DashboardProblem[] {
  const kept: DashboardProblem[] = [];
  let used = 0;
  for (const problem of problems.slice(0, MAX_PROBLEMS)) {
    if (used >= MAX_PROBLEM_CHARS) break;
    const left = MAX_PROBLEM_CHARS - used;
    const path = capText(problem.path, left);
    const message = capText(problem.message, Math.max(0, left - path.length));
    kept.push({ path, message });
    used += path.length + message.length;
  }
  const dropped = problems.length - kept.length;
  if (dropped > 0) kept.push({ path: "", message: `... ${dropped} more problem(s)` });
  return kept;
}

/** Widget types the agent is allowed to create. */
function creatableWidgetTypes(): string[] {
  return KNOWN_WIDGET_TYPES.slice();
}

/**
 * The widget vocabulary the tool description advertises, derived from the
 * shared contract rather than typed out a second time: the types come from
 * `KNOWN_WIDGET_TYPES` and each one's example config from the first shipped
 * preset that uses it. Anything richer -- a human label, a description of what
 * a widget draws -- lives only in the renderer's registry, which the brain
 * cannot see.
 */
export function widgetCatalogLines(): string[] {
  const example = new Map<string, string>();
  for (const preset of DASHBOARD_PRESETS) {
    for (const panel of preset.dashboard.panels) {
      if (!example.has(panel.widget)) example.set(panel.widget, JSON.stringify(panel.config));
    }
  }
  return creatableWidgetTypes().map((type) => `${type} (config ${example.get(type) ?? "{}"})`);
}

/** The shipped presets, for the tool description and for `create_dashboard`. */
export function presetLines(): string[] {
  return DASHBOARD_PRESETS.map((preset) => `${preset.id} -- ${preset.description}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A panel the agent must leave alone.
 *
 * `pinned` is the user saying so outright. Absent provenance counts as the
 * user's too: the only panels that arrive without it are hand-written ones, and
 * treating an unlabelled panel as the agent's own would make a hand-edited
 * layout the one case where curation quietly deletes work.
 */
export function isProtectedPanel(panel: DashboardPanel): boolean {
  if (panel.pinned === true) return true;
  return panel.addedBy !== "agent" && panel.addedBy !== "preset";
}

/** Key-order-independent comparison, so a merged config is not a false change. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function samePanel(a: DashboardPanel, b: DashboardPanel): boolean {
  return (
    a.widget === b.widget &&
    (a.title ?? "") === (b.title ?? "") &&
    a.layout.span === b.layout.span &&
    a.layout.rows === b.layout.rows &&
    a.pinned === b.pinned &&
    a.addedBy === b.addedBy &&
    // `reason` is the user-visible "why is this here". Leaving it out of the
    // comparison let an update_panel rewrite it on a panel the user pinned.
    (a.reason ?? "") === (b.reason ?? "") &&
    stableJson(a.config) === stableJson(b.config)
  );
}

function reasonProtected(panel: DashboardPanel): string {
  if (panel.pinned === true) return "is pinned";
  return panel.addedBy === "user" ? "was placed by the user" : "was not added by the agent";
}

/**
 * What an agent-proposed document would do to panels that are not its to touch.
 *
 * Checked on the finished document rather than per action, so the wholesale
 * replace and the patch path get the same guarantee and a future action cannot
 * quietly escape it. Adding panels is always fine; curation appends.
 */
export function provenanceViolations(
  before: DashboardDocument,
  after: DashboardDocument,
): string[] {
  const violations: string[] = [];
  for (const dashboard of before.dashboards) {
    const protectedPanels = dashboard.panels.filter(isProtectedPanel);
    if (protectedPanels.length === 0) continue;

    const target = after.dashboards.find((d) => d.id === dashboard.id);
    if (!target) {
      violations.push(
        `dashboard "${dashboard.id}" holds ${protectedPanels.length} panel(s) the user placed or pinned, so it cannot be removed`,
      );
      continue;
    }

    for (const panel of protectedPanels) {
      const kept = target.panels.find((p) => p.id === panel.id);
      if (!kept) {
        violations.push(`panel "${panel.id}" ${reasonProtected(panel)}, so it cannot be removed`);
      } else if (!samePanel(panel, kept)) {
        violations.push(`panel "${panel.id}" ${reasonProtected(panel)}, so it cannot be changed`);
      }
    }

    // Relative order of the protected panels, compared as a subsequence: new
    // panels may land between them, but they may not be shuffled past each
    // other. Displacing a panel the user merely placed is allowed -- placing is
    // not pinning.
    const expected = protectedPanels
      .map((p) => p.id)
      .filter((id) => target.panels.some((p) => p.id === id));
    const actual = target.panels.map((p) => p.id).filter((id) => expected.includes(id));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      violations.push(
        `reordering the panels the user placed in "${dashboard.id}" is not the agent's to do`,
      );
    }

    // A pin, though, holds a panel's place as well as its content.
    //
    // The subsequence check above compares protected panels only against each
    // other, so with one pinned panel and three agent panels it saw the same
    // one-element sequence however far the pinned panel moved: `move_panel`
    // pushed a pinned panel from the top to the bottom and reported success.
    // A pin that does not survive one tool call is not much of a pin, and
    // "keep this where I can see it" is most of why someone pins a panel.
    //
    // So for a pinned panel, the already-existing panels ahead of it must stay
    // the same. New panels may still be inserted anywhere, and unprotected
    // panels may still be removed.
    const surviving = new Set(
      dashboard.panels.map((p) => p.id).filter((id) => target.panels.some((q) => q.id === id)),
    );
    const aheadIn = (panels: { id: string }[], id: string): Set<string> => {
      const ahead = new Set<string>();
      for (const p of panels) {
        if (p.id === id) break;
        if (surviving.has(p.id)) ahead.add(p.id);
      }
      return ahead;
    };
    const sameSet = (a: Set<string>, b: Set<string>): boolean =>
      a.size === b.size && [...a].every((id) => b.has(id));

    for (const panel of protectedPanels) {
      if (panel.pinned !== true || !surviving.has(panel.id)) continue;
      if (!sameSet(aheadIn(dashboard.panels, panel.id), aheadIn(target.panels, panel.id))) {
        violations.push(`panel "${panel.id}" is pinned, so the agent cannot move it`);
      }
    }
  }
  return violations;
}

/**
 * Take provenance out of the model's hands.
 *
 * `actions` cannot set `addedBy` or `pinned` -- the schema has no field for
 * them -- but a whole-document replace hands the model the raw JSON, and a
 * panel it stamps `addedBy: "user"` or `pinned: true` is a panel it has
 * laundered into one nothing here will ever touch again, including the user's
 * own reading of who put it there. So: a panel that was already in this
 * dashboard keeps exactly the provenance it had, and a panel this write
 * introduces is the agent's, with the agent's reason.
 */
export function reassertProvenance(
  before: DashboardDocument,
  candidate: DashboardDocument,
  reason: string,
): DashboardDocument {
  for (const dashboard of candidate.dashboards) {
    const previous = before.dashboards.find((d) => d.id === dashboard.id);
    for (const panel of dashboard.panels) {
      const existing = previous?.panels.find((p) => p.id === panel.id);
      if (existing && existing.widget === panel.widget) {
        if (existing.addedBy === undefined) delete panel.addedBy;
        else panel.addedBy = existing.addedBy;
        if (existing.pinned === undefined) delete panel.pinned;
        else panel.pinned = existing.pinned;
        // The reason is the one provenance field the agent may legitimately
        // refresh -- it is the sentence the user reads to decide whether the
        // panel belongs there -- but only on a panel that is the agent's to
        // change at all. On a protected one it is the user's words.
        if (isProtectedPanel(existing)) {
          if (existing.reason === undefined) delete panel.reason;
          else panel.reason = existing.reason;
        } else if (panel.reason === undefined && existing.reason !== undefined) {
          panel.reason = existing.reason;
        }
      } else {
        panel.addedBy = "agent";
        panel.reason = reason;
        delete panel.pinned;
      }
    }
  }
  return candidate;
}

/**
 * Widget types this change brings into the document: a panel id the dashboard
 * did not have, or one whose widget type changed. Panels already on disk are
 * left alone even when their type is unknown to this build, because that is how
 * a layout written by a newer build survives being opened by an older one.
 */
export function introducedWidgetTypes(
  before: DashboardDocument,
  after: DashboardDocument,
): string[] {
  const introduced = new Set<string>();
  for (const dashboard of after.dashboards) {
    const previous = before.dashboards.find((d) => d.id === dashboard.id);
    for (const panel of dashboard.panels) {
      const existing = previous?.panels.find((p) => p.id === panel.id);
      if (!existing || existing.widget !== panel.widget) introduced.add(panel.widget);
    }
  }
  return [...introduced];
}

/**
 * What the validator had to throw away to fit its own caps.
 *
 * The build step produces a well-formed document either way -- the action path
 * from typed inputs, the document path from an already-validated one -- so a
 * panel or dashboard that comes out the far side missing was truncated at the
 * 20-dashboard or 40-panel ceiling, not repaired. Counts rather than ids,
 * because the validator also renames duplicates and a by-id comparison would
 * call that a loss.
 *
 * It matters because truncation keeps the FIRST N: an insert at position 0 into
 * a full dashboard pushes the last panel off the end, and the model would
 * otherwise be told its add succeeded.
 */
export function truncatedByValidation(
  proposed: DashboardDocument,
  validated: DashboardDocument,
): string | null {
  if (validated.dashboards.length < proposed.dashboards.length) {
    return `this layout already holds the most dashboards a layout can have (${validated.dashboards.length}), so the new one would not fit`;
  }
  const count = (document: DashboardDocument): number =>
    document.dashboards.reduce((total, d) => total + d.panels.length, 0);
  const kept = count(validated);
  if (kept < count(proposed)) {
    return `that dashboard is full (${kept} panels), so adding to it would push another panel off the end`;
  }
  return null;
}

/**
 * Did the model's document exceed a cap, so that saving it would drop panels?
 *
 * The actions path catches this by comparing the proposal with the validated
 * result, but a whole-document replace is validated on the way in, so there is
 * nothing un-truncated left to compare against -- `commitDashboardChange` ends
 * up comparing the truncated document with itself and finding nothing missing.
 * That is why prepending one panel to a full dashboard reported success and
 * deleted the last one.
 *
 * Tested against the caps rather than by counting survivors, because the
 * validator also drops genuinely malformed panels, and that is a repair to
 * report rather than a refusal to raise.
 */
export function documentOverflow(documentText: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(documentText);
  } catch {
    return null; // Unparseable text never got this far.
  }
  const dashboards = (raw as { dashboards?: unknown } | null)?.dashboards;
  if (!Array.isArray(dashboards)) return null;

  if (dashboards.length > MAX_DASHBOARDS) {
    return `Nothing was changed: a layout holds at most ${MAX_DASHBOARDS} dashboards and that one has ${dashboards.length}, so ${dashboards.length - MAX_DASHBOARDS} would have been dropped.`;
  }
  for (const dashboard of dashboards) {
    const panels = (dashboard as { panels?: unknown } | null)?.panels;
    if (!Array.isArray(panels) || panels.length <= MAX_PANELS) continue;
    const id = (dashboard as { id?: unknown })?.id;
    const name = typeof id === "string" ? `"${id}"` : "a dashboard";
    return `Nothing was changed: ${name} holds at most ${MAX_PANELS} panels and that one has ${panels.length}, so ${panels.length - MAX_PANELS} would have been dropped. Remove some first.`;
  }
  return null;
}

/** Refuse a widget type the agent is not allowed to create. */
export function unsupportedWidgetMessage(type: string): string | null {
  if (creatableWidgetTypes().includes(type)) return null;
  return `"${type}" is not a widget this build can draw. Available: ${creatableWidgetTypes().join(", ")}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One change, as the model sent it.
 *
 * Every field is `unknown` on purpose. The schema asks for strings and
 * integers, but nothing between the model and this function enforces that, and
 * a `null` where a string was promised must come back as a refusal the model
 * can read rather than as a TypeError out of the tool.
 */
export type DashboardAction = {
  action?: unknown;
  dashboardId?: unknown;
  panelId?: unknown;
  widget?: unknown;
  title?: unknown;
  config?: unknown;
  span?: unknown;
  rows?: unknown;
  position?: unknown;
  preset?: unknown;
};

export type ApplyResult =
  | { ok: true; document: DashboardDocument; notes: string[]; problems?: DashboardProblem[] }
  | { ok: false; error: string };

function fail(error: string): ApplyResult {
  return { ok: false, error };
}

function cloneDocument(document: DashboardDocument): DashboardDocument {
  return JSON.parse(JSON.stringify(document)) as DashboardDocument;
}

function findDashboard(document: DashboardDocument, id: unknown): Dashboard | null {
  const wanted = asText(id) || document.activeId;
  return document.dashboards.find((d) => d.id === wanted) ?? null;
}

function dashboardIds(document: DashboardDocument): string {
  return document.dashboards.map((d) => d.id).join(", ");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniquePanelId(dashboard: Dashboard, base: string): string {
  const slug = slugify(base) || "panel";
  if (!dashboard.panels.some((p) => p.id === `p-${slug}`)) return `p-${slug}`;
  let n = 2;
  while (dashboard.panels.some((p) => p.id === `p-${slug}-${n}`)) n++;
  return `p-${slug}-${n}`;
}

function uniqueDashboardId(document: DashboardDocument, base: string): string {
  const slug = slugify(base) || "dashboard";
  if (!document.dashboards.some((d) => d.id === slug)) return slug;
  let n = 2;
  while (document.dashboards.some((d) => d.id === `${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/**
 * A model-supplied string field, or "" for anything else.
 *
 * The schema says these are strings, but nothing between the model and here
 * enforces that: a `null` title or a numeric reason arrives as-is and used to
 * take `.trim()` with it, throwing out of `execute` instead of coming back as
 * something the model could correct.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Whether the model supplied this field at all, ignoring how badly. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return undefined;
}

type ParsedConfig = { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(raw: unknown): ParsedConfig {
  if (raw === undefined || raw === null) return { ok: true, config: {} };
  // The schema asks for JSON text because a free-form object parameter is not
  // portable across every provider's function-calling schema, but a model that
  // sends the object itself is being reasonable and should not be punished for
  // it.
  if (isConfigObject(raw)) return { ok: true, config: raw };
  if (typeof raw !== "string") {
    return { ok: false, error: 'config must be a JSON object, e.g. {"follow":false}' };
  }
  if (raw.trim() === "") return { ok: true, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isConfigObject(parsed)) {
    return { ok: false, error: 'config must be a JSON object, e.g. {"follow":false}' };
  }
  return { ok: true, config: parsed };
}

function clampRows(rows: unknown): number {
  const value = asInteger(rows);
  return value === undefined ? 2 : Math.min(6, Math.max(1, value));
}

/**
 * Where an insert lands, clamped to the grid and to the panels the user pinned.
 *
 * `pinned` is the user saying "leave this one alone", and a panel that keeps
 * its contents but loses the top-left slot has not been left alone. So an agent
 * insert never goes above a pinned panel, however the model numbers it. Panels
 * merely placed by the user are not protected this way -- they did not ask for
 * a fixed spot, and a dashboard that can only ever grow at the bottom is worse.
 */
function clampPosition(position: unknown, panels: DashboardPanel[]): number {
  const floor = panels.reduce((last, panel, i) => (panel.pinned === true ? i + 1 : last), 0);
  const value = asInteger(position);
  if (value === undefined) return panels.length;
  return Math.min(panels.length, Math.max(floor, value));
}

type Located = { dashboard: Dashboard; panel: DashboardPanel; index: number } | { error: string };

function locatePanel(document: DashboardDocument, action: DashboardAction): Located {
  const panelId = asText(action.panelId);
  if (!panelId) return { error: `${action.action} needs a panelId.` };
  const wanted = asText(action.dashboardId) || undefined;
  if (wanted && !document.dashboards.some((d) => d.id === wanted)) {
    return { error: `no dashboard "${wanted}". Have: ${dashboardIds(document)}.` };
  }
  // Panel ids are unique per dashboard, not per document, and the shipped
  // presets reuse "p-jobs" and "p-notebook" deliberately. Without the active
  // dashboard first, an unqualified action edits whichever dashboard happens to
  // be first in the file -- one the user is not even looking at.
  const scoped = wanted
    ? document.dashboards.filter((d) => d.id === wanted)
    : [...document.dashboards].sort((a, b) => {
        if (a.id === document.activeId) return -1;
        if (b.id === document.activeId) return 1;
        return 0;
      });
  for (const dashboard of scoped) {
    const index = dashboard.panels.findIndex((p) => p.id === panelId);
    if (index >= 0) return { dashboard, panel: dashboard.panels[index], index };
  }
  return { error: `no panel "${panelId}". Call dashboard_read to see the panel ids.` };
}

/**
 * Apply the agent's actions to a copy of the document.
 *
 * Nothing here enforces provenance or the widget allowlist; both are checked
 * against the finished document by the caller, so the patch path and the
 * wholesale-replace path cannot diverge.
 */
export function applyDashboardActions(
  document: DashboardDocument,
  actions: DashboardAction[],
  reason: string,
): ApplyResult {
  if (!Array.isArray(actions)) return fail("actions must be a list of changes.");
  if (actions.length === 0) return fail("No actions given.");
  if (actions.length > MAX_ACTIONS) {
    return fail(`${actions.length} actions in one call; at most ${MAX_ACTIONS}.`);
  }

  const next = cloneDocument(document);
  const notes: string[] = [];

  for (const [index, action] of actions.entries()) {
    const at = `actions[${index}]`;
    if (action === null || typeof action !== "object") {
      return fail(`${at}: expected an object describing one change.`);
    }
    switch (asText(action.action)) {
      case "add_panel": {
        const dashboard = findDashboard(next, action.dashboardId);
        if (!dashboard) {
          return fail(
            `${at}: no dashboard "${asText(action.dashboardId)}". Have: ${dashboardIds(next)}.`,
          );
        }
        const widget = asText(action.widget);
        if (!widget) return fail(`${at}: add_panel needs a widget type.`);
        const config = parseConfig(action.config);
        if (!config.ok) return fail(`${at}: ${config.error}`);
        const panel: DashboardPanel = {
          id: uniquePanelId(dashboard, widget),
          widget,
          config: config.config,
          layout: { span: asInteger(action.span) === 2 ? 2 : 1, rows: clampRows(action.rows) },
          addedBy: "agent",
          reason,
        };
        const title = asText(action.title);
        if (title) panel.title = title;
        const insertAt = clampPosition(action.position, dashboard.panels);
        dashboard.panels.splice(insertAt, 0, panel);
        notes.push(`added ${widget} as "${panel.id}" in "${dashboard.id}"`);
        break;
      }

      case "remove_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        found.dashboard.panels.splice(found.index, 1);
        notes.push(`removed "${found.panel.id}" from "${found.dashboard.id}"`);
        break;
      }

      case "update_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        if (
          !given(action.widget) &&
          !given(action.title) &&
          !given(action.config) &&
          !given(action.span) &&
          !given(action.rows)
        ) {
          // Reporting "updated" for a call that changed nothing would have the
          // model tell the user their dashboard moved when it did not.
          return fail(`${at}: update_panel needs something to change.`);
        }
        const panel = found.panel;
        const newWidget = asText(action.widget);
        if (newWidget) panel.widget = newWidget;
        if (given(action.title)) {
          const title = asText(action.title);
          if (title) panel.title = title;
          else delete panel.title;
        }
        if (given(action.config)) {
          const config = parseConfig(action.config);
          if (!config.ok) return fail(`${at}: ${config.error}`);
          // Merge: a model changing one setting should not silently drop the
          // rest of a panel's config.
          panel.config = { ...panel.config, ...config.config };
        }
        if (given(action.span)) panel.layout.span = asInteger(action.span) === 2 ? 2 : 1;
        if (given(action.rows)) panel.layout.rows = clampRows(action.rows);
        panel.reason = reason;
        notes.push(`updated "${panel.id}" in "${found.dashboard.id}"`);
        break;
      }

      case "move_panel": {
        const found = locatePanel(next, action);
        if ("error" in found) return fail(`${at}: ${found.error}`);
        if (asInteger(action.position) === undefined) {
          return fail(`${at}: move_panel needs a position.`);
        }
        const [panel] = found.dashboard.panels.splice(found.index, 1);
        const to = clampPosition(action.position, found.dashboard.panels);
        found.dashboard.panels.splice(to, 0, panel);
        notes.push(`moved "${panel.id}" to position ${to} in "${found.dashboard.id}"`);
        break;
      }

      case "create_dashboard": {
        const fromPreset = asText(action.preset) || undefined;
        let dashboard: Dashboard;
        if (fromPreset) {
          const preset = dashboardFromPreset(fromPreset);
          if (!preset) {
            return fail(
              `${at}: no preset "${fromPreset}". Have: ${DASHBOARD_PRESETS.map((p) => p.id).join(", ")}.`,
            );
          }
          dashboard = preset;
        } else {
          dashboard = { id: "", title: "", panels: [] };
        }
        const title = asText(action.title) || asText(dashboard.title);
        if (!title) return fail(`${at}: create_dashboard needs a title or a preset.`);
        dashboard.title = title;
        dashboard.id = uniqueDashboardId(next, asText(action.dashboardId) || fromPreset || title);
        next.dashboards.push(dashboard);
        notes.push(`created dashboard "${dashboard.id}"`);
        break;
      }

      case "switch_dashboard": {
        const dashboard = findDashboard(next, action.dashboardId);
        if (!dashboard) {
          return fail(
            `${at}: no dashboard "${asText(action.dashboardId)}". Have: ${dashboardIds(next)}.`,
          );
        }
        next.activeId = dashboard.id;
        notes.push(`showing "${dashboard.id}"`);
        break;
      }

      default:
        return fail(
          `${at}: unknown action "${asText(action.action)}". Use add_panel, remove_panel, update_panel, move_panel, create_dashboard or switch_dashboard.`,
        );
    }
  }

  return { ok: true, document: next, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The write, end to end
// ─────────────────────────────────────────────────────────────────────────────

export type CommitOutcome =
  | {
      ok: true;
      document: DashboardDocument;
      problems: DashboardProblem[];
      notes: string[];
      path: string;
    }
  | { ok: false; error: string; problems?: DashboardProblem[] };

type Refusal = { error: string; problems?: DashboardProblem[] };

/**
 * Validate the candidate, check it against what it is replacing, and persist it.
 *
 * Shared by the tool's patch path, the tool's replace path and the parts of
 * `/dashboard` that write, so every one of them gets the same refusals. The
 * checks run inside the store's compare-and-swap callback, so they are made
 * against the document as it is on disk at the moment of the write, not against
 * a copy read earlier.
 */
export async function commitDashboardChange(
  build: (current: DashboardDocument, exists: boolean) => ApplyResult,
  options: { asUser?: boolean; reason?: string } = {},
): Promise<CommitOutcome> {
  // `asUser` means a person typed this, so the panels they placed are theirs to
  // discard. It does NOT relax the widget allowlist: whether this build can
  // draw a widget is a fact about the build, not about who asked, and a preset
  // that one day carries a flag-gated widget must not install it through the
  // slash command either.
  const enforce = options.asUser !== true;
  const buildReason = options.reason ?? "";
  // A holder rather than plain locals: the callback below runs inside the
  // store's retry loop, and what it learns has to survive back out here.
  const seen: { problems: DashboardProblem[]; notes: string[]; refusal: Refusal | null } = {
    problems: [],
    notes: [],
    refusal: null,
  };

  const written = await updateDashboardDocument((current, exists) => {
    seen.problems = [];
    seen.notes = [];
    seen.refusal = null;

    const built = build(current, exists);
    if (!built.ok) {
      seen.refusal = { error: built.error };
      return { ok: false, error: built.error };
    }

    const proposed = enforce
      ? reassertProvenance(current, built.document, buildReason)
      : built.document;
    const validated = validateDashboardDocument(proposed);
    if (!validated.ok) {
      seen.refusal = {
        error: "That layout is not a valid dashboard document.",
        problems: validated.problems,
      };
      return { ok: false, error: seen.refusal.error };
    }
    // Repairs the build step already made -- a panel the model's document was
    // missing a widget for, say -- are the model's to hear about, and they are
    // gone by the time the result is re-validated.
    seen.problems = [...(built.problems ?? []), ...validated.problems];
    seen.notes = built.notes;

    const truncated = truncatedByValidation(proposed, validated.document);
    if (truncated) {
      seen.refusal = {
        error: `Nothing was changed: ${truncated}. Remove something first.`,
      };
      return { ok: false, error: seen.refusal.error };
    }

    for (const type of introducedWidgetTypes(current, validated.document)) {
      const message = unsupportedWidgetMessage(type);
      if (message) {
        seen.refusal = { error: `${message} Nothing was changed.` };
        return { ok: false, error: seen.refusal.error };
      }
    }

    if (enforce) {
      const violations = provenanceViolations(current, validated.document);
      if (violations.length > 0) {
        seen.refusal = {
          error: `Nothing was changed: ${violations.join("; ")}. Ask the user to make that change in the dashboard's own controls.`,
        };
        return { ok: false, error: seen.refusal.error };
      }
    }

    return { ok: true, document: validated.document };
  });

  if (!written.ok) {
    return seen.refusal
      ? { ok: false, error: seen.refusal.error, problems: seen.refusal.problems }
      : { ok: false, error: written.error };
  }
  return {
    ok: true,
    document: written.document,
    problems: seen.problems,
    notes: seen.notes,
    path: written.path,
  };
}

/** One line per dashboard, for a tool result or a slash command. */
export function summarizeDocument(document: DashboardDocument): string[] {
  return document.dashboards.map((dashboard) => {
    const mark = dashboard.id === document.activeId ? "* " : "  ";
    const panels = dashboard.panels.length
      ? dashboard.panels.map(describePanel).join(", ")
      : "no panels";
    return `${mark}${dashboard.id} (${dashboard.title}): ${panels}`;
  });
}

function describePanel(panel: DashboardPanel): string {
  const marks: string[] = [];
  if (panel.pinned) marks.push("pinned");
  if (panel.addedBy && panel.addedBy !== "preset") marks.push(`added by ${panel.addedBy}`);
  return `${panel.id} [${panel.widget}]${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

/** True when a shell with a dashboard pane is attached. */
function hasPane(): boolean {
  return isDesktopShell();
}

/** Where the change landed, said in one line, honestly, in either shell. */
export function landedLine(): string {
  return hasPane()
    ? "The Dashboard tab picks this up within a few seconds."
    : "There is no dashboard pane in the terminal; the layout file is updated and the next Orbit session will show it.";
}

/**
 * Note the change in the activity log. The only durable trace that the agent,
 * rather than the user, rearranged what they are looking at.
 */
export function logDashboardChange(filePath: string, notes: string[], source: string): void {
  try {
    appendActivityEvent(path.dirname(filePath), {
      timestamp: new Date().toISOString(),
      kind: "dashboard.changed",
      source,
      payload: { changes: notes },
    });
  } catch {
    // The layout is written; failing to note it is not worth failing the call.
  }
}

export function countPanels(document: DashboardDocument): number {
  return document.dashboards.reduce((total, d) => total + d.panels.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

const UPDATE_DESCRIPTION = [
  "Change the analysis dashboard: the panels the user sees beside the chat.",
  "",
  "Only when the user asks. Do not add, remove or rearrange panels on your own",
  "initiative -- not to be helpful, not because a run started, not because you",
  "think another view would suit them better. A panel the user placed or pinned",
  "is refused outright; ask them to change that one in the dashboard's own controls.",
  "",
  "Call dashboard_read first so you use the real panel ids. Pass EITHER `actions`",
  "(add_panel, remove_panel, update_panel, move_panel, create_dashboard,",
  "switch_dashboard) or `document` (the whole layout as JSON text), never both.",
  "`reason` is required and is recorded on every panel you add or change, so the",
  'user can see why it is there -- name the fact, e.g. "you asked to watch the',
  'alignment run".',
  "",
  `Widget types: ${widgetCatalogLines().join("; ")}.`,
  "Presets for create_dashboard:",
  ...presetLines().map((line) => `  ${line}`),
  "Panels sit in a two-column grid: span is 1 or 2 columns, rows is 1-6 height",
  "units, position is the index within the dashboard (omit it to append).",
].join("\n");

const ActionSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add_panel"),
      Type.Literal("remove_panel"),
      Type.Literal("update_panel"),
      Type.Literal("move_panel"),
      Type.Literal("create_dashboard"),
      Type.Literal("switch_dashboard"),
    ],
    { description: "What to do." },
  ),
  dashboardId: Type.Optional(
    Type.String({ description: "Which dashboard. Defaults to the one on screen." }),
  ),
  panelId: Type.Optional(
    Type.String({ description: "Panel to act on, for remove_panel/update_panel/move_panel." }),
  ),
  widget: Type.Optional(Type.String({ description: "Widget type, for add_panel." })),
  title: Type.Optional(
    Type.String({ description: "Panel or dashboard title. Omit to use the widget's own label." }),
  ),
  config: Type.Optional(
    Type.String({
      description:
        'Widget config as a JSON object in a string, e.g. {"follow":false}. On update_panel it is merged into the panel\'s existing config.',
    }),
  ),
  span: Type.Optional(Type.Integer({ minimum: 1, maximum: 2, description: "Columns: 1 or 2." })),
  rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Height units: 1-6." })),
  position: Type.Optional(
    Type.Integer({ minimum: 0, description: "Index within the dashboard. Omit to append." }),
  ),
  preset: Type.Optional(
    Type.String({ description: "Preset id to build a new dashboard from, for create_dashboard." }),
  ),
});

function toolFailure(error: string, problems?: DashboardProblem[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: capText(error, MAX_ERROR_CHARS),
            ...(problems ? { problems: cappedProblems(problems) } : {}),
          },
          null,
          2,
        ),
      },
    ],
    details: { error: true } as Record<string, unknown>,
  };
}

export function registerDashboardTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dashboard_read",
    label: "Read Dashboard Layout",
    description:
      "Read the analysis dashboard: the named dashboards, their panels, which one is on screen " +
      "and who put each panel there. Call this before dashboard_update so you change panels by " +
      "their real ids.",
    parameters: Type.Object({}),
    async execute() {
      const read = await readDashboardDocument();
      if (!read.ok) return toolFailure(read.error);
      // Measured the way it is emitted. The response is written with two-space
      // indentation a few lines below, which roughly doubles it, so comparing
      // the compact form against the cap let a document that just squeaked
      // under land in front of the model at twice the size.
      const serialized = JSON.stringify(read.document, null, 2);
      const tooBig = serialized.length > MAX_READ_CHARS;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                exists: read.exists,
                ...(tooBig
                  ? {
                      documentOmitted: `The layout is ${serialized.length} characters, too large to show in full. Work from the summary below -- it carries the panel ids -- and change panels with actions rather than replacing the whole document.`,
                    }
                  : { document: read.document }),
                summary: cappedSummary(read.document),
                widgetTypes: widgetCatalogLines(),
                presets: presetLines(),
                ...(read.problems.length ? { problems: cappedProblems(read.problems) } : {}),
                ...(read.exists
                  ? {}
                  : { note: "No layout file yet; this is the default the user sees." }),
              },
              null,
              2,
            ),
          },
        ],
        details: { panels: countPanels(read.document) },
      };
    },
    renderResult: (result) => {
      const d = result.details as { panels?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("Could not read the dashboard");
      return new Text(`Dashboard: ${d?.panels ?? 0} panel(s)`);
    },
  });

  pi.registerTool({
    name: "dashboard_update",
    label: "Update Dashboard Layout",
    description: UPDATE_DESCRIPTION,
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        description:
          "Why this change, in the user's terms. Recorded on every panel you add or change.",
      }),
      actions: Type.Optional(
        Type.Array(ActionSchema, {
          minItems: 1,
          maxItems: MAX_ACTIONS,
          description: "The changes to make, applied in order.",
        }),
      ),
      document: Type.Optional(
        Type.String({
          description:
            "The whole layout as JSON text, replacing what is there. Use actions instead unless the user asked for a wholesale rebuild.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const raw = params as Record<string, unknown>;
      const reason = asText(raw.reason);
      if (!reason) return toolFailure("reason is required: say why the user wants this change.");

      if (given(raw.actions) && !Array.isArray(raw.actions)) {
        return toolFailure("actions must be a list of changes.");
      }
      if (given(raw.document) && typeof raw.document !== "string") {
        return toolFailure("document must be the whole layout as JSON text.");
      }
      const actions = (Array.isArray(raw.actions) ? raw.actions : []) as DashboardAction[];
      const documentText = typeof raw.document === "string" ? raw.document : undefined;

      if (actions.length > 0 && documentText !== undefined) {
        return toolFailure("Pass either actions or document, not both.");
      }
      if (actions.length === 0 && documentText === undefined) {
        return toolFailure("Nothing to do: pass actions or document.");
      }

      const outcome = await commitDashboardChange(
        (current) => {
          if (documentText !== undefined) {
            const parsed = parseDashboardDocument(documentText);
            if (!parsed.ok) {
              return {
                ok: false,
                error: `document could not be read: ${parsed.problems
                  .map((p) => `${p.path || "document"}: ${p.message}`)
                  .join("; ")}`,
              };
            }
            // The caps have already been applied by the time we get here: the
            // validator enforces them by keeping the first N and calling it a
            // repair, so `commitDashboardChange` would compare this truncated
            // document against itself and find nothing missing. That is why
            // prepending one panel to a full dashboard reported success and
            // deleted the last one -- the guard that exists for exactly this
            // is unreachable on this path. Count what the model actually sent.
            const overflow = documentOverflow(documentText);
            if (overflow) return { ok: false, error: overflow };
            return {
              ok: true,
              document: parsed.document,
              notes: ["replaced the whole layout"],
              problems: parsed.problems,
            };
          }
          return applyDashboardActions(current, actions, reason);
        },
        { reason },
      );

      if (!outcome.ok) return toolFailure(outcome.error, outcome.problems);

      logDashboardChange(outcome.path, outcome.notes, "dashboard_update");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                changes: capLines(outcome.notes, MAX_SUMMARY_CHARS, "change(s)"),
                summary: cappedSummary(outcome.document),
                where: landedLine(),
                undo: "The user can put this back with /dashboard undo.",
                ...(outcome.problems.length ? { repairs: cappedProblems(outcome.problems) } : {}),
              },
              null,
              2,
            ),
          },
        ],
        details: { changes: outcome.notes.length },
      };
    },
    renderResult: (result) => {
      const d = result.details as { changes?: number; error?: boolean } | undefined;
      if (d?.error) return new Text("Dashboard unchanged");
      return new Text(`Dashboard updated (${d?.changes ?? 0} change(s))`);
    },
  });
}
