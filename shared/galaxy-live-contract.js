// Shell-neutral wire shape for the live Galaxy history panel.
//
// The brain is the only process that holds GALAXY_URL/GALAXY_API_KEY in every
// shell -- Orbit injects them after decrypting safeStorage, the CLI resolves
// them from a profile, the web server forwards them from its env -- so it is
// the only place a Galaxy read can happen once and reach both renderers. What
// crosses to a renderer is this projection and nothing else: no key, no full
// server URL, no dataset bytes, and no Galaxy-authored HTML (notably `peek`,
// which is HTML, is deliberately absent).

export const GALAXY_LIVE_SCHEMA_VERSION = 1;

/** Cap on rows crossing the channel. A 5k-dataset history must not become a
 *  5k-element setWidget push on a 15s timer. */
export const GALAXY_LIVE_MAX_ITEMS = 200;

/** Cap on a single dataset name. Galaxy names are user-supplied and unbounded. */
export const GALAXY_LIVE_MAX_NAME = 200;

/**
 * Cap on every other Galaxy-supplied string on the wire: encoded ids, the
 * update_time, the extension.
 *
 * Capping the row COUNT is not capping the payload. A server that answers with
 * a hundred-thousand-character id per row turns 200 rows into twenty megabytes
 * on one stdout line, every tick -- the cap the row limit was written to
 * enforce, defeated by a field nobody thought of as text. Everything from
 * Galaxy that reaches the wire goes through a clamp.
 */
export const GALAXY_LIVE_MAX_TOKEN = 64;

/**
 * Galaxy dataset states we model. Anything else collapses to "other" so a new
 * server-side state never crashes a widget written against an older build.
 * Source: galaxy.model.Dataset.states.
 * @typedef {"new"|"upload"|"queued"|"running"|"ok"|"empty"|"error"|"paused"|"setting_metadata"|"failed_metadata"|"deferred"|"discarded"|"other"} GalaxyLiveState
 */

export const GALAXY_LIVE_STATES = /** @type {const} */ ([
  "new",
  "upload",
  "queued",
  "running",
  "ok",
  "empty",
  "error",
  "paused",
  "setting_metadata",
  "failed_metadata",
  "deferred",
  "discarded",
  "other",
]);

/** States that mean Galaxy is still working. Drives the "is anything running"
 *  headline and the poll cadence. */
export const GALAXY_LIVE_ACTIVE_STATES = /** @type {const} */ ([
  "new",
  "upload",
  "queued",
  "running",
  "setting_metadata",
]);

/** Why there is nothing to show. The renderer maps these to a sentence; the
 *  brain never sends prose, so the two shells cannot drift. */
export const GALAXY_LIVE_UNAVAILABLE = /** @type {const} */ ([
  "not-configured",
  "no-history",
  "unreachable",
  // 401: the key itself is rejected. 403: the key is fine, this history is not
  // yours. Telling someone to re-enter a working key is its own kind of wrong.
  "unauthorized",
  "forbidden",
]);

/** @param {unknown} s @returns {GalaxyLiveState} */
export function normalizeState(s) {
  return typeof s === "string" && /** @type {readonly string[]} */ (GALAXY_LIVE_STATES).includes(s)
    ? /** @type {GalaxyLiveState} */ (s)
    : "other";
}

/** @param {GalaxyLiveState} s */
export function isActiveState(s) {
  return /** @type {readonly string[]} */ (GALAXY_LIVE_ACTIVE_STATES).includes(s);
}

/**
 * Clamp a Galaxy-authored string to a fixed length. Not a security control --
 * the renderer must still use textContent -- but it keeps one pathological
 * name from dominating the payload.
 * @param {unknown} v @param {number} max @returns {string}
 */
export function clampText(v, max = GALAXY_LIVE_MAX_NAME) {
  if (typeof v !== "string") return "";
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
}

/**
 * Make an arbitrary decoded value into a payload the renderer can draw, or
 * null if it cannot be made into one. Never throws.
 *
 * The brain ships on npm independently of the Orbit build, so a newer brain
 * talking to an older shell is a supported configuration and a payload that
 * does not match this build's idea of the shape is a thing that will happen.
 * Without this, `history.items` arriving as a string threw out of the render
 * and the host turned the panel into a sticky error card that only a click
 * recovers. Same reasoning as `normalizeState`, one level up.
 *
 * @param {unknown} raw
 * @returns {import("./galaxy-live-contract.js").GalaxyLivePayload | null}
 */
export function normalizeGalaxyLivePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = /** @type {Record<string, unknown>} */ (raw);
  if (p.version !== GALAXY_LIVE_SCHEMA_VERSION) return null;

  const unavailable =
    typeof p.unavailable === "string" &&
    /** @type {readonly string[]} */ (GALAXY_LIVE_UNAVAILABLE).includes(p.unavailable)
      ? /** @type {import("./galaxy-live-contract.js").GalaxyLiveUnavailable} */ (p.unavailable)
      : undefined;
  // A reason this build has never heard of is still a reason: keep the panel
  // out of the rows branch rather than dropping the payload on the floor.
  const unknownReason = p.unavailable !== undefined && unavailable === undefined;

  return {
    version: GALAXY_LIVE_SCHEMA_VERSION,
    serverHost:
      typeof p.serverHost === "string" ? clampText(p.serverHost, GALAXY_LIVE_MAX_TOKEN) : null,
    history: normalizeHistory(p.history, unknownReason),
    ...(unavailable ? { unavailable } : unknownReason ? { unavailable: "unreachable" } : {}),
    updatedAt: typeof p.updatedAt === "string" ? clampText(p.updatedAt, GALAXY_LIVE_MAX_TOKEN) : "",
  };
}

/** @param {unknown} raw @param {boolean} forceNull */
function normalizeHistory(raw, forceNull) {
  if (forceNull || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = /** @type {Record<string, unknown>} */ (raw);
  const items = Array.isArray(h.items) ? h.items.map(normalizeItem).filter(Boolean) : [];
  const counts = {};
  if (h.counts && typeof h.counts === "object" && !Array.isArray(h.counts)) {
    for (const [state, n] of Object.entries(h.counts)) {
      if (normalizeState(state) === state && typeof n === "number" && Number.isFinite(n)) {
        counts[state] = Math.max(0, Math.floor(n));
      }
    }
  }
  return {
    id: clampText(h.id, GALAXY_LIVE_MAX_TOKEN),
    name: clampText(h.name) || "Untitled history",
    updateTime: clampText(h.updateTime, GALAXY_LIVE_MAX_TOKEN),
    counts,
    countsComplete: h.countsComplete !== false,
    items: items.slice(0, GALAXY_LIVE_MAX_ITEMS),
    truncated: typeof h.truncated === "number" && h.truncated > 0 ? Math.floor(h.truncated) : 0,
    truncatedExact: h.truncatedExact !== false,
  };
}

/** @param {unknown} raw */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const i = /** @type {Record<string, unknown>} */ (raw);
  /** @type {import("./galaxy-live-contract.js").GalaxyLiveItem} */
  const item = {
    id: clampText(i.id, GALAXY_LIVE_MAX_TOKEN),
    hid: typeof i.hid === "number" && Number.isFinite(i.hid) ? i.hid : 0,
    name: clampText(i.name),
    state: normalizeState(i.state),
    extension: clampText(i.extension, 32),
    kind: i.kind === "collection" ? "collection" : "dataset",
  };
  if (typeof i.elementCount === "number" && Number.isFinite(i.elementCount)) {
    item.elementCount = i.elementCount;
  }
  return item;
}
