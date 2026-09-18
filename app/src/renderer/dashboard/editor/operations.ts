/**
 * Every edit the layout editor can make, as a pure function on the document.
 *
 * Nothing here touches the DOM, the host or the registry, which is what makes
 * the editing rules testable without a browser. Each operation takes a
 * document and returns a new one, and returns **the input unchanged** when
 * there is nothing to do -- a missing panel, a value already at its bound, a
 * cap already reached. The caller uses that identity check to tell a real edit
 * from a no-op, which is how the editor knows whether to announce "moved" or
 * "already first" and whether to push an undo entry.
 *
 * Panels whose widget type this build does not know are ordinary panels here.
 * They are copied, moved, resized and counted like any other, and no operation
 * inspects `widget` except to generate an id -- a layout written by a newer
 * build must survive being edited by an older one.
 */

import {
  createDefaultDashboardDocument,
  dashboardFromPreset,
  MAX_DASHBOARDS,
  MAX_PANELS,
  MAX_ROWS,
  MIN_ROWS,
} from "../../../../../shared/dashboard-contract.js";
import type {
  Dashboard,
  DashboardDocument,
  DashboardPanel,
  PanelOrigin,
  PanelSpan,
} from "../../../../../shared/dashboard-contract.js";

/** Row heights the schema accepts, under the names the editor already uses. */
export const MIN_PANEL_ROWS = MIN_ROWS;
export const MAX_PANEL_ROWS = MAX_ROWS;

const DEFAULT_LAYOUT = { span: 1 as PanelSpan, rows: 2 };

export interface AddPanelOptions {
  title?: string;
  span?: PanelSpan;
  rows?: number;
  config?: Record<string, unknown>;
  /** Where to insert. Appended when omitted or out of range. */
  index?: number;
  addedBy?: PanelOrigin;
  reason?: string;
}

export interface NewDashboardOptions {
  title?: string;
  /** Start from a shipped preset instead of an empty dashboard. */
  presetId?: string;
}

function copy<T>(value: T): T {
  // The validator bounds config depth and node count, so the document reaching
  // an operation is always JSON-round-trippable.
  return JSON.parse(JSON.stringify(value)) as T;
}

function findDashboard(doc: DashboardDocument, dashboardId: string): Dashboard | undefined {
  return doc.dashboards.find((d) => d.id === dashboardId);
}

function clampRows(rows: number): number {
  if (!Number.isFinite(rows)) return DEFAULT_LAYOUT.rows;
  return Math.min(MAX_PANEL_ROWS, Math.max(MIN_PANEL_ROWS, Math.round(rows)));
}

/** Lowercase, hyphen-separated, safe to use as an id. Empty input gets a fallback. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/** `base`, or `base-2`, `base-3`... whichever is free among this document's dashboards. */
export function uniqueDashboardId(doc: DashboardDocument, base: string): string {
  const taken = new Set(doc.dashboards.map((d) => d.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/**
 * Panel ids are unique within a dashboard, not across them -- the shipped
 * presets deliberately reuse `p-notebook` -- so uniqueness is scoped here too.
 */
export function uniquePanelId(dashboard: Dashboard, base: string): string {
  const taken = new Set(dashboard.panels.map((p) => p.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// ── Panels ───────────────────────────────────────────────────────────────────

export function addPanel(
  doc: DashboardDocument,
  dashboardId: string,
  widget: string,
  opts: AddPanelOptions = {},
): DashboardDocument {
  if (typeof widget !== "string" || widget.trim() === "") return doc;
  const source = findDashboard(doc, dashboardId);
  if (!source || source.panels.length >= MAX_PANELS) return doc;

  const next = copy(doc);
  const dashboard = findDashboard(next, dashboardId);
  if (!dashboard) return doc;

  const panel: DashboardPanel = {
    id: uniquePanelId(dashboard, `p-${slugify(widget, "panel")}`),
    widget: widget.trim(),
    config: opts.config ? copy(opts.config) : {},
    layout: {
      span: opts.span === 2 ? 2 : DEFAULT_LAYOUT.span,
      rows: clampRows(opts.rows ?? DEFAULT_LAYOUT.rows),
    },
    addedBy: opts.addedBy ?? "user",
  };
  if (opts.title && opts.title.trim()) panel.title = opts.title.trim();
  if (opts.reason && opts.reason.trim()) panel.reason = opts.reason.trim();

  const at =
    opts.index === undefined || opts.index < 0 || opts.index > dashboard.panels.length
      ? dashboard.panels.length
      : opts.index;
  dashboard.panels.splice(at, 0, panel);
  return next;
}

export function removePanel(
  doc: DashboardDocument,
  dashboardId: string,
  panelId: string,
): DashboardDocument {
  const source = findDashboard(doc, dashboardId);
  if (!source || !source.panels.some((p) => p.id === panelId)) return doc;
  const next = copy(doc);
  const dashboard = findDashboard(next, dashboardId);
  if (!dashboard) return doc;
  dashboard.panels = dashboard.panels.filter((p) => p.id !== panelId);
  return next;
}

/** Move a panel `delta` places in document order. A move past either end is a no-op. */
export function movePanel(
  doc: DashboardDocument,
  dashboardId: string,
  panelId: string,
  delta: number,
): DashboardDocument {
  const source = findDashboard(doc, dashboardId);
  if (!source) return doc;
  const from = source.panels.findIndex((p) => p.id === panelId);
  if (from === -1) return doc;
  const to = from + Math.trunc(delta);
  if (to === from || to < 0 || to >= source.panels.length) return doc;

  const next = copy(doc);
  const dashboard = findDashboard(next, dashboardId);
  if (!dashboard) return doc;
  const [panel] = dashboard.panels.splice(from, 1);
  dashboard.panels.splice(to, 0, panel);
  return next;
}

/** Width in columns and height in row units. Out-of-range values clamp; no change is a no-op. */
export function resizePanel(
  doc: DashboardDocument,
  dashboardId: string,
  panelId: string,
  patch: { span?: PanelSpan; rows?: number },
): DashboardDocument {
  const source = findDashboard(doc, dashboardId);
  const current = source?.panels.find((p) => p.id === panelId);
  if (!current) return doc;

  const span = patch.span === undefined ? current.layout.span : patch.span === 2 ? 2 : 1;
  const rows = patch.rows === undefined ? current.layout.rows : clampRows(patch.rows);
  if (span === current.layout.span && rows === current.layout.rows) return doc;

  const next = copy(doc);
  const panel = findDashboard(next, dashboardId)?.panels.find((p) => p.id === panelId);
  if (!panel) return doc;
  panel.layout = { span, rows };
  return next;
}

/** A blank or whitespace-only title clears the override and the widget's own label shows. */
export function renamePanel(
  doc: DashboardDocument,
  dashboardId: string,
  panelId: string,
  title: string,
): DashboardDocument {
  const source = findDashboard(doc, dashboardId);
  const current = source?.panels.find((p) => p.id === panelId);
  if (!current) return doc;
  const trimmed = title.trim();
  if ((current.title ?? "") === trimmed) return doc;

  const next = copy(doc);
  const panel = findDashboard(next, dashboardId)?.panels.find((p) => p.id === panelId);
  if (!panel) return doc;
  if (trimmed) panel.title = trimmed;
  else delete panel.title;
  return next;
}

/** Replace a panel's config wholesale. The settings form and the JSON editor both land here. */
export function configurePanel(
  doc: DashboardDocument,
  dashboardId: string,
  panelId: string,
  config: Record<string, unknown>,
): DashboardDocument {
  const source = findDashboard(doc, dashboardId);
  const current = source?.panels.find((p) => p.id === panelId);
  if (!current) return doc;
  if (JSON.stringify(current.config) === JSON.stringify(config)) return doc;

  const next = copy(doc);
  const panel = findDashboard(next, dashboardId)?.panels.find((p) => p.id === panelId);
  if (!panel) return doc;
  panel.config = copy(config);
  return next;
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/** A new dashboard, blank or from a preset, selected. */
export function createDashboard(
  doc: DashboardDocument,
  opts: NewDashboardOptions = {},
): DashboardDocument {
  if (doc.dashboards.length >= MAX_DASHBOARDS) return doc;
  const preset = opts.presetId ? dashboardFromPreset(opts.presetId) : null;
  if (opts.presetId && !preset) return doc;

  const next = copy(doc);
  const title = (opts.title ?? preset?.title ?? "New dashboard").trim() || "New dashboard";
  const dashboard: Dashboard = {
    id: uniqueDashboardId(next, slugify(title, preset?.id ?? "dashboard")),
    title,
    panels: preset ? preset.panels : [],
  };
  next.dashboards.push(dashboard);
  next.activeId = dashboard.id;
  return next;
}

/** A copy of one dashboard, placed after it and selected. */
export function duplicateDashboard(doc: DashboardDocument, dashboardId: string): DashboardDocument {
  if (doc.dashboards.length >= MAX_DASHBOARDS) return doc;
  const index = doc.dashboards.findIndex((d) => d.id === dashboardId);
  if (index === -1) return doc;

  const next = copy(doc);
  const original = next.dashboards[index];
  const clone: Dashboard = {
    id: uniqueDashboardId(next, `${original.id}-copy`),
    title: `${original.title} (copy)`.slice(0, 200),
    // Panel ids only have to be unique inside their own dashboard, so the copy
    // keeps them: a config write is addressed by dashboard id and panel id.
    // The array itself is copied, or the two dashboards would share it and an
    // edit to one would show up in the other.
    panels: copy(original.panels),
  };
  next.dashboards.splice(index + 1, 0, clone);
  next.activeId = clone.id;
  return next;
}

export function renameDashboard(
  doc: DashboardDocument,
  dashboardId: string,
  title: string,
): DashboardDocument {
  const current = findDashboard(doc, dashboardId);
  const trimmed = title.trim();
  if (!current || !trimmed || current.title === trimmed) return doc;
  const next = copy(doc);
  const dashboard = findDashboard(next, dashboardId);
  if (!dashboard) return doc;
  dashboard.title = trimmed;
  return next;
}

/**
 * Remove a dashboard. Removing the last one is a no-op: a document with no
 * dashboards is repaired back to the default by the validator, which would
 * look like the delete silently did something else. "Reset to default" is the
 * operation for that, and it says so.
 */
export function deleteDashboard(doc: DashboardDocument, dashboardId: string): DashboardDocument {
  if (doc.dashboards.length <= 1) return doc;
  const index = doc.dashboards.findIndex((d) => d.id === dashboardId);
  if (index === -1) return doc;

  const next = copy(doc);
  next.dashboards.splice(index, 1);
  if (next.activeId === dashboardId) {
    next.activeId = next.dashboards[Math.min(index, next.dashboards.length - 1)].id;
  }
  return next;
}

export function selectDashboard(doc: DashboardDocument, dashboardId: string): DashboardDocument {
  if (doc.activeId === dashboardId) return doc;
  if (!doc.dashboards.some((d) => d.id === dashboardId)) return doc;
  const next = copy(doc);
  next.activeId = dashboardId;
  return next;
}

/** The document a fresh workspace gets: one dashboard, the current-analysis preset. */
export function resetDocument(): DashboardDocument {
  return createDefaultDashboardDocument();
}
