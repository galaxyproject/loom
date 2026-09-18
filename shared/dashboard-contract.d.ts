export const DASHBOARD_SCHEMA_VERSION: 1;

/** Per-analysis layout file, beside notebook.md in the working directory. */
export const DASHBOARD_FILENAME: ".loom-dashboard.json";

/** Refuse to persist anything larger. Layout, not a blob store. */
export const DASHBOARD_MAX_BYTES: number;

/**
 * Advisory list used to build presets and to give the brain a vocabulary. It is
 * deliberately not the set of renderable widgets -- the renderer's registry is
 * that, and it includes flag-gated widgets this list should not advertise.
 * Validation never consults either.
 */
export const KNOWN_WIDGET_TYPES: readonly string[];

/**
 * Caps the validator enforces by truncating. A caller that would rather refuse
 * a click than silently drop what it just added reads them from here.
 */
export const MAX_DASHBOARDS: number;
export const MAX_PANELS: number;

/** Panel height bounds, in grid row units. */
export const MIN_ROWS: number;
export const MAX_ROWS: number;

export type PanelSpan = 1 | 2;

export interface DashboardPanelLayout {
  /** Grid columns this panel occupies. */
  span: PanelSpan;
  /** Height in grid row units, 1..6. */
  rows: number;
}

/** Who put this panel here. Recorded, preserved, and not yet rendered. */
export type PanelOrigin = "user" | "agent" | "preset";

export interface DashboardPanel {
  id: string;
  /** Widget type key. An unrecognised value is preserved, not dropped. */
  widget: string;
  /** Overrides the widget's own label when set. */
  title?: string;
  config: Record<string, unknown>;
  layout: DashboardPanelLayout;
  /**
   * Provenance. Carried in v1 so that an agent curating the dashboard later can
   * say who added a panel and why, and so the user can pin one against being
   * re-curated away, without a schema migration. The validator preserves these;
   * the host ignores them.
   *
   * **Absent reads as the user's.** The only panels that arrive with no
   * provenance are hand-written ones, so anything deciding what an agent may
   * touch has to treat an unlabelled panel as protected -- otherwise a
   * hand-edited layout is the one case where curation quietly deletes work.
   */
  addedBy?: PanelOrigin;
  /** Short note on why this panel is here. Capped at 280 characters. */
  reason?: string;
  /** Set by the user to mean "leave this one alone". */
  pinned?: boolean;
}

export interface Dashboard {
  id: string;
  title: string;
  panels: DashboardPanel[];
}

export interface DashboardDocument {
  version: number;
  /** id of the dashboard shown by default. Always present in a validated document. */
  activeId: string;
  dashboards: Dashboard[];
}

export interface DashboardProblem {
  /** Dotted path into the input, "" for the document itself. */
  path: string;
  message: string;
}

export type DashboardValidation =
  | { ok: true; document: DashboardDocument; problems: DashboardProblem[] }
  | { ok: false; problems: DashboardProblem[] };

export interface DashboardPreset {
  id: string;
  label: string;
  description: string;
  dashboard: Dashboard;
}

export const DASHBOARD_PRESETS: readonly DashboardPreset[];

/** A fresh copy of a preset's dashboard, or null if there is no such preset. */
export function dashboardFromPreset(presetId: string): Dashboard | null;

/** The document a workspace starts with: one dashboard, the current-analysis preset. */
export function createDefaultDashboardDocument(): DashboardDocument;

export function serializeDashboardDocument(document: DashboardDocument): string;

/**
 * A short content fingerprint for the layout file: the compare-and-swap token a
 * save carries to prove which version it was based on. Returns null for a
 * non-string (i.e. no file).
 */
export function dashboardRevision(raw: unknown): string | null;

/**
 * Normalize an untrusted value into a dashboard document. Never throws.
 *
 * `ok: true` carries the document plus every repair that was made. `ok: false`
 * means the input could not be repaired: not an object, no usable version, or a
 * version newer than this build understands.
 */
export function validateDashboardDocument(input: unknown): DashboardValidation;

/** JSON text -> validated document. Same total-function guarantee. */
export function parseDashboardDocument(raw: unknown): DashboardValidation;
