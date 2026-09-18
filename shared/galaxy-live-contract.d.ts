export const GALAXY_LIVE_SCHEMA_VERSION: 1;
export const GALAXY_LIVE_MAX_ITEMS: number;
export const GALAXY_LIVE_MAX_NAME: number;
export const GALAXY_LIVE_MAX_TOKEN: number;

export type GalaxyLiveState =
  | "new"
  | "upload"
  | "queued"
  | "running"
  | "ok"
  | "empty"
  | "error"
  | "paused"
  | "setting_metadata"
  | "failed_metadata"
  | "deferred"
  | "discarded"
  | "other";

export const GALAXY_LIVE_STATES: readonly GalaxyLiveState[];
export const GALAXY_LIVE_ACTIVE_STATES: readonly GalaxyLiveState[];

export type GalaxyLiveUnavailable =
  | "not-configured"
  | "no-history"
  | "unreachable"
  /** 401 -- Galaxy rejected the key itself. */
  | "unauthorized"
  /** 403 -- the key is valid but this history is not the user's. */
  | "forbidden";
export const GALAXY_LIVE_UNAVAILABLE: readonly GalaxyLiveUnavailable[];

export interface GalaxyLiveItem {
  /** Galaxy encoded id. Opaque to the renderer; used only as a DOM key. */
  id: string;
  hid: number;
  name: string;
  state: GalaxyLiveState;
  extension: string;
  kind: "dataset" | "collection";
  /** Present for collections only. */
  elementCount?: number;
}

export interface GalaxyLiveHistory {
  id: string;
  name: string;
  /** Galaxy's own update_time, used for change detection and staleness. */
  updateTime: string;
  /**
   * state -> count over exactly the rows in `items`, never a server-side
   * histogram. Galaxy's `contents_states` scores a collection by the
   * collection's own state while the row beneath it is scored by the worst job
   * inside it, which put "10 failed" above a list of 19 red rows on a real
   * history. Counting the rows keeps the header and the list honest.
   */
  counts: Partial<Record<GalaxyLiveState, number>>;
  /** False when `items` is a page of a longer history, so `counts` is a page count. */
  countsComplete: boolean;
  /** Newest-first, capped at GALAXY_LIVE_MAX_ITEMS. */
  items: GalaxyLiveItem[];
  /** How many further items exist beyond `items`. */
  truncated: number;
  /** False when `truncated` is a lower bound rather than the real figure. */
  truncatedExact: boolean;
}

export interface GalaxyLivePayload {
  version: 1;
  /** Host only. Never the full URL, never credentials. */
  serverHost: string | null;
  history: GalaxyLiveHistory | null;
  unavailable?: GalaxyLiveUnavailable;
  /**
   * When this payload was produced (ISO). On a successful read that is when
   * the brain last heard from Galaxy, which is what the panel's "checked N ago"
   * line reports -- a number nobody has refreshed and a number that has not
   * changed look identical otherwise.
   */
  updatedAt: string;
}

export function normalizeState(s: unknown): GalaxyLiveState;
export function isActiveState(s: GalaxyLiveState): boolean;
export function clampText(v: unknown, max?: number): string;
/**
 * Coerce a decoded payload into something drawable, or null. Never throws.
 * The brain ships independently of the shell, so a payload this build does not
 * recognise is a thing that happens rather than a thing that cannot.
 */
export function normalizeGalaxyLivePayload(raw: unknown): GalaxyLivePayload | null;
