/**
 * Live Galaxy history snapshot for the dashboard's Galaxy panel.
 *
 * Why the brain and not a shell: the brain is the only process that can obtain
 * GALAXY_URL/GALAXY_API_KEY from all three places they come from -- an env var
 * Orbit injects after decrypting safeStorage, an env var a developer exported,
 * and a plaintext profile on disk. A shell-side proxy would have to be written
 * once per shell and would still be dead in whichever one the user happened to
 * be in. Reading here and pushing the projection over the existing
 * `ctx.ui.setWidget` channel costs no new credential surface and no new IPC.
 *
 * Cost control, measured against usegalaxy.org and usegalaxy.eu on 2026-09-18:
 *   1. The summary probe is 179 bytes and already carries the headline -- name,
 *      update_time, overall state and the active/hidden/deleted counts. A tick
 *      where nothing moved never touches the contents endpoint.
 *   2. The contents index IGNORES `keys=` and `view=`: it returns the full
 *      serialization of every item including deleted and hidden ones (547 KB
 *      for one real history). The `q`/`qv` filters are what actually work
 *      (deleted=False, visible=True -> 17.5 KB), and `order=hid-dsc` puts the
 *      newest first so `limit` caps at the server rather than after half a
 *      megabyte is already on the wire.
 *   3. Contents are refetched only when Galaxy's own update_time moves.
 *
 * Galaxy 26.1 is the floor. The `v=dev` behaviour above was not checked against
 * anything older; on a server that ignores `v=dev` the endpoint fails the other
 * way (the deprecated filters apply and `limit` does not), so the result is
 * over-fetching rather than showing deleted rows as live.
 */

import * as fsp from "node:fs/promises";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GALAXY_LIVE_MAX_ITEMS,
  GALAXY_LIVE_MAX_TOKEN,
  GALAXY_LIVE_SCHEMA_VERSION,
  clampText,
  normalizeState,
} from "../../shared/galaxy-live-contract.js";
import type {
  GalaxyLiveHistory,
  GalaxyLiveItem,
  GalaxyLivePayload,
  GalaxyLiveState,
} from "../../shared/galaxy-live-contract.js";
import { LoomWidgetKey, encodeJsonWidget } from "../../shared/loom-shell-contract.js";
import {
  GalaxyApiError,
  galaxyGet,
  galaxyGetMostRecentHistory,
  getGalaxyConfig,
  sameGalaxyServer,
  type GalaxyHistorySummary,
} from "./galaxy-api.js";
import { findGalaxyPageBlocks } from "./galaxy-page-binding.js";
import { findJobBlocks } from "./galaxy-job-block.js";
import { findInvocationBlocks } from "./notebook-writer.js";
import { setPollTickHook } from "./galaxy-poller.js";
import { getDashboardPath, readDashboardDocument } from "./dashboard-store.js";
import { isDesktopShell } from "../../shared/orbit-env.js";

/** The only Galaxy reads this source is allowed to make. Anything not built by
 *  these two functions never leaves the module, so there is no path from a
 *  renderer-supplied string to an arbitrary Galaxy path. */
const SUMMARY_KEYS = "name,update_time,state,contents_active";

function historySummaryPath(historyId: string): string {
  return `/histories/${encodeURIComponent(historyId)}?keys=${SUMMARY_KEYS}`;
}

/**
 * Ask for one row more than we intend to keep. Without the extra row a history
 * with exactly `limit` items and a history with ten thousand are
 * indistinguishable, and `truncated` silently reports 0 on the second -- which
 * is the panel telling the user there is nothing more to see.
 */
function historyContentsPath(historyId: string, limit: number): string {
  // Every value here is a literal. Nothing a renderer or a model supplies ever
  // reaches the query string -- the only caller-supplied value is historyId,
  // which is checked against ENCODED_ID_RE first.
  const query = [
    "v=dev",
    "q=deleted&qv=False",
    "q=visible&qv=True",
    "order=hid-dsc",
    `limit=${limit}`,
  ].join("&");
  return `/histories/${encodeURIComponent(historyId)}/contents?${query}`;
}

/**
 * Galaxy encoded ids are hex, and are a multiple of 16 characters.
 *
 * The guard is not decoration. A value like `.` survives encodeURIComponent,
 * and URL normalization turns the SUMMARY path `/api/histories/.` into
 * `/api/histories/` -- the *collection* endpoint, which answers 200 with `[]`
 * (verified against usegalaxy.org). Without this check the probe would take
 * that 200 as a real history and the panel would draw an empty "Untitled
 * history" for an id that does not exist. The contents path behaves
 * differently -- `/api/histories/./contents` is a 400 -- which is exactly why
 * checking only the second call would miss it.
 *
 * The length bound keeps a megabyte of hex from being pasted into a URL;
 * Galaxy rejects a non-multiple-of-16 id itself, so this only avoids asking.
 */
const ENCODED_ID_RE = /^[0-9a-fA-F]{16,64}$/;

interface HistorySummary {
  name?: unknown;
  update_time?: unknown;
  state?: unknown;
  /** {active, hidden, deleted} over the history's items. Used ONLY to decide
   *  whether rows were left behind, never to count states -- see projectHistory. */
  contents_active?: unknown;
}

interface ContentsRow {
  id?: unknown;
  hid?: unknown;
  name?: unknown;
  state?: unknown;
  extension?: unknown;
  deleted?: unknown;
  visible?: unknown;
  history_content_type?: unknown;
  element_count?: unknown;
  populated_state?: unknown;
  job_state_summary?: unknown;
}

/** Host only -- the panel shows "usegalaxy.org", never a URL that could carry a
 *  query string, and never the key. */
export function serverHostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Collapse a collection's per-element job states into one state for the row.
 * Galaxy reports `job_state_summary` counts; the panel wants the worst thing
 * happening inside. Error beats paused beats running beats queued beats ok,
 * because the point of the row is "is this going well".
 */
function collectionState(row: ContentsRow): GalaxyLiveState {
  const summary = row.job_state_summary;
  if (summary && typeof summary === "object") {
    const counts = summary as Record<string, unknown>;
    const n = (k: string): number => (typeof counts[k] === "number" ? (counts[k] as number) : 0);
    if (n("error") > 0 || n("failed") > 0) return "error";
    if (n("paused") > 0) return "paused";
    if (n("running") > 0) return "running";
    if (n("new") > 0 || n("queued") > 0) return "queued";
  }
  // populated_state is the collection's own build state; "new" means Galaxy is
  // still filling it in.
  if (row.populated_state === "failed") return "error";
  if (row.populated_state === "new") return "new";
  return "ok";
}

/**
 * Project one Galaxy contents row into a panel row. Returns null for rows the
 * panel never shows (deleted, hidden) so the caller's cap applies to visible
 * rows rather than being eaten by invisible ones.
 */
export function projectRow(raw: unknown): GalaxyLiveItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as ContentsRow;
  if (row.deleted === true) return null;
  if (row.visible === false) return null;
  if (typeof row.id !== "string" || !row.id) return null;
  const isCollection = row.history_content_type === "dataset_collection";
  const item: GalaxyLiveItem = {
    // Clamped like every other Galaxy-supplied string. Capping the row count is
    // not capping the payload: a server answering with a hundred-thousand-
    // character id per row turns 200 rows into twenty megabytes on one line.
    id: clampText(row.id, GALAXY_LIVE_MAX_TOKEN),
    hid: typeof row.hid === "number" ? row.hid : 0,
    name: clampText(row.name),
    state: isCollection ? collectionState(row) : normalizeState(row.state),
    extension: clampText(typeof row.extension === "string" ? row.extension : "", 32),
    kind: isCollection ? "collection" : "dataset",
  };
  if (isCollection && typeof row.element_count === "number") {
    item.elementCount = row.element_count;
  }
  return item;
}

/** A JSON object, as opposed to null, an array, or a string a proxy sent. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function activeCount(raw: unknown): number | null {
  if (!isPlainObject(raw)) return null;
  const active = raw.active;
  return typeof active === "number" && active >= 0 ? active : null;
}

/** A positive, finite row cap. `slice(0, NaN)` keeps nothing, which would turn a
 *  full history into an empty panel. */
function keepCount(keep: number): number {
  return Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : GALAXY_LIVE_MAX_ITEMS;
}

/**
 * Build the history projection from the two raw responses. Pure, so the shape
 * the renderer sees is testable without a network.
 *
 * **Counts are computed from the rows, deliberately.** Galaxy hands you a
 * ready-made histogram in `contents_states`, and using it was the first thing
 * this did; it is wrong here. `contents_states` scores a dataset collection by
 * the collection's own state, while the row below it is scored by the worst job
 * inside it -- so on a real usegalaxy.org history the header read "10 failed"
 * above a list showing 19 red rows, 9 of them collections. A summary that
 * disagrees with the list under it is worse than one that counts a smaller set
 * correctly. So the header counts exactly the rows that were fetched,
 * `countsComplete` says whether that was all of them, and `contents_active` is
 * used for nothing except working out how many were left behind.
 */
export function projectHistory(
  historyId: string,
  summary: unknown,
  contents: unknown,
  keep: number = GALAXY_LIVE_MAX_ITEMS,
): GalaxyLiveHistory {
  const s = (
    summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {}
  ) as HistorySummary;
  const rows = Array.isArray(contents) ? contents : [];
  const items: GalaxyLiveItem[] = [];
  for (const raw of rows) {
    const item = projectRow(raw);
    if (item) items.push(item);
  }
  // Galaxy is asked for hid-descending, but an older server that ignores
  // `order` would hand back ascending; sort so the newest row is first either
  // way. The thing a user is waiting on is the thing they just launched.
  items.sort((a, b) => b.hid - a.hid);
  const capped = items.slice(0, keepCount(keep));

  const counts: Partial<Record<GalaxyLiveState, number>> = {};
  for (const item of capped) counts[item.state] = (counts[item.state] ?? 0) + 1;

  // Two independent ways to know rows were left behind, and the answer is the
  // larger of them rather than whichever one happens to be present.
  // `contents_active.active` is exact but absent on a server that silently
  // drops the `keys=` we asked for (it answers 200 either way). The overflow
  // row -- we request keep+1 and keep `keep` -- is always available but only
  // proves "at least one more". Preferring the server's count outright was
  // wrong: the summary and the contents are two requests a second apart, so a
  // history that grew in between returns more rows than the count admits to,
  // and the panel then reports nothing hidden while rows are missing.
  const active = activeCount(s.contents_active);
  const overflow = Math.max(0, items.length - capped.length);
  const fromServer = active !== null ? Math.max(0, active - capped.length) : 0;
  const truncated = Math.max(fromServer, overflow);
  const truncatedExact = active !== null ? fromServer >= overflow : overflow === 0;

  return {
    id: historyId,
    name: clampText(s.name) || "Untitled history",
    updateTime: clampText(s.update_time, GALAXY_LIVE_MAX_TOKEN),
    counts,
    countsComplete: truncated === 0,
    items: capped,
    truncated,
    truncatedExact,
  };
}

/** Per-tick wall-clock bound. Comfortably above the ~1 s a cold contents fetch
 *  took against usegalaxy.org, well under the 15 s poller interval. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How many contents rows we will project, whatever Galaxy sends.
 *
 * We request `GALAXY_LIVE_MAX_ITEMS + 1`; a server that honours `limit` never
 * reaches this. One that ignores it hands back the whole history, and then
 * `projectRow` and the sort run over the lot on the brain's 15 s timer, every
 * 15 s, for as long as the session lasts.
 *
 * Extra rows are dropped rather than refused. Refusing pins the panel on
 * "Galaxy did not answer" for the rest of the session -- the next tick gets the
 * same oversized answer and the one after that too -- while Galaxy is in fact
 * answering, and the user can see their history perfectly well in Galaxy's own
 * UI. Ten of what we asked for is enough slack that this only fires on a server
 * that is genuinely ignoring us.
 *
 * This bounds the work, NOT the transfer -- by the time it is consulted the
 * body has already been buffered and parsed, because `galaxyGet` ends in
 * `resp.json()`. A real byte bound has to go there, which is outside this file.
 */
const MAX_CONTENTS_ROWS = GALAXY_LIVE_MAX_ITEMS * 10;

/**
 * The rows worth projecting, from the end of the list that holds them.
 *
 * We ask for `order=hid-dsc`, so the newest are at the head -- but an older
 * server that ignored `order` hands back ascending, and `projectHistory` only
 * sorts what it is given. Cutting the head there would hand it the oldest rows
 * in the history and the panel would confidently show a user work they finished
 * last year. Read the direction off the rows instead of trusting the query.
 */
function boundContentsRows(rows: unknown[]): unknown[] {
  if (rows.length <= MAX_CONTENTS_ROWS) return rows;
  const hid = (row: unknown): number | null => {
    const value = (row as { hid?: unknown } | null)?.hid;
    return typeof value === "number" ? value : null;
  };
  const first = hid(rows[0]);
  const last = hid(rows[rows.length - 1]);
  const ascending = first !== null && last !== null && last > first;
  return ascending ? rows.slice(-MAX_CONTENTS_ROWS) : rows.slice(0, MAX_CONTENTS_ROWS);
}

/**
 * Which failure the user is looking at. The split that matters is 401 from
 * 403: Galaxy answers 401 for a key it rejects, and 403 for a good key on a
 * history that is not yours. Collapsing them sends someone to rotate a
 * credential that is fine.
 */
function classifyError(err: unknown): NonNullable<GalaxyLivePayload["unavailable"]> {
  if (!(err instanceof GalaxyApiError)) return "unreachable";
  if (err.status === 401) return "unauthorized";
  if (err.status === 403) return "forbidden";
  if (err.status === 400 || err.status === 404) return "no-history";
  return "unreachable";
}

export interface GalaxyLiveDeps {
  /** Injected so the whole source is testable without a network or env. */
  get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  config: () => { url: string; apiKey: string } | null;
  now: () => Date;
}

const defaultDeps: GalaxyLiveDeps = {
  get: galaxyGet,
  config: getGalaxyConfig,
  now: () => new Date(),
};

export interface SnapshotOptions {
  /** The update_time the caller already has. When it still matches, contents
   *  are not refetched and the result carries no payload. */
  knownUpdateTime?: string;
  signal?: AbortSignal;
  /**
   * Wall-clock bound per tick. `galaxyGet` is a bare fetch with no timeout of
   * its own, and this runs on a repeating timer -- without a bound, one hung
   * Galaxy stacks in-flight requests until something falls over.
   */
  timeoutMs?: number;
}

export interface SnapshotResult {
  /**
   * null means "do not push anything" -- either Galaxy said nothing moved, or
   * the tick was aborted. Making it null rather than a history-less payload is
   * the point: the alternative shape renders as "No history yet.", so a caller
   * that forwarded an unchanged result would blank a populated panel and tell
   * the user their analysis has no history.
   */
  payload: GalaxyLivePayload | null;
  /** Galaxy answered and nothing had changed since `knownUpdateTime`. */
  unchanged: boolean;
  /** The caller's signal fired. Not a Galaxy failure and must not be shown as one. */
  aborted: boolean;
}

/**
 * One read: probe, and refetch contents only if Galaxy says the history moved.
 *
 * Never throws. A Galaxy failure becomes an `unavailable` payload, because the
 * panel's job is to say "I cannot see Galaxy right now" rather than to vanish.
 */
export async function fetchGalaxyLiveSnapshot(
  historyId: string,
  opts: SnapshotOptions = {},
  deps: GalaxyLiveDeps = defaultDeps,
): Promise<SnapshotResult> {
  const cfg = deps.config();
  const host = serverHostOf(cfg?.url);

  // Stamped when the payload is built, not when the tick started, so
  // `updatedAt` means what the contract says it means.
  const bare = (unavailable: GalaxyLivePayload["unavailable"]): SnapshotResult => ({
    payload: {
      version: GALAXY_LIVE_SCHEMA_VERSION,
      serverHost: host,
      history: null,
      unavailable,
      updatedAt: deps.now().toISOString(),
    },
    unchanged: false,
    aborted: false,
  });
  const quiet = (aborted: boolean): SnapshotResult => ({
    payload: null,
    unchanged: !aborted,
    aborted,
  });

  if (!cfg) return bare("not-configured");
  if (!historyId || !ENCODED_ID_RE.test(historyId)) return bare("no-history");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
  /** A caller-cancelled tick is not a Galaxy failure; a timeout is. */
  const cancelled = (): boolean => Boolean(opts.signal?.aborted);

  let raw: unknown;
  try {
    raw = await deps.get<unknown>(historySummaryPath(historyId), signal);
  } catch (err) {
    if (cancelled()) return quiet(true);
    return bare(classifyError(err));
  }
  // A 200 is not an answer. Galaxy returning JSON `null` here -- which a proxy
  // in front of it can do too -- used to throw straight out of a function whose
  // whole contract is that it does not, so the tick died in the poller's catch
  // with no payload and no backoff. Anything that is not an object is the same
  // problem: unreadable, retry, say so.
  if (!isPlainObject(raw)) return bare("unreachable");
  const summary = raw as HistorySummary;

  const updateTime = typeof summary.update_time === "string" ? summary.update_time : "";
  if (opts.knownUpdateTime && updateTime && opts.knownUpdateTime === updateTime) {
    return quiet(false);
  }

  let contents: unknown;
  try {
    contents = await deps.get<unknown>(
      historyContentsPath(historyId, GALAXY_LIVE_MAX_ITEMS + 1),
      signal,
    );
  } catch (err) {
    if (cancelled()) return quiet(true);
    return bare(classifyError(err));
  }
  // `projectHistory` turns a non-array into no rows, which is indistinguishable
  // from an empty history -- so a server answering 200 with an error object, or
  // an HTML login page a proxy substituted, drew a confident "No datasets yet"
  // over an analysis that has them. Refuse the shape instead.
  if (!Array.isArray(contents)) return bare("unreachable");

  return {
    payload: {
      version: GALAXY_LIVE_SCHEMA_VERSION,
      serverHost: host,
      history: projectHistory(historyId, summary, boundContentsRows(contents)),
      updatedAt: deps.now().toISOString(),
    },
    unchanged: false,
    aborted: false,
  };
}

// ── Which history ────────────────────────────────────────────────────────────

/**
 * The history this analysis is attached to, as Loom already tracks it. No
 * user-typed ids: the widget cannot ask for one anyway (the widget channel is
 * push-only) and every id that reaches a request has to be one Loom wrote down.
 *
 * The notebook's `loom-galaxy-page` binding wins, and only when it names the
 * server we are actually talking to -- a notebook carried over from another
 * Galaxy would otherwise have us probe a stranger's id and render "this history
 * belongs to another account" forever.
 *
 * `getCurrentHistoryId()` from state.ts is deliberately not used: nothing in
 * production calls `setGalaxyConnection`, so it is null in a real session.
 */
export function historyIdFromNotebook(content: string | null, serverUrl: string): string | null {
  if (!content) return null;
  const bindings = findGalaxyPageBlocks(content).filter((b) =>
    sameGalaxyServer(b.galaxyServerUrl, serverUrl),
  );
  const last = bindings[bindings.length - 1];
  return last?.historyId || null;
}

/** Is anything Loom launched still going? Drives the poll cadence, nothing else. */
export function notebookHasLiveWork(content: string | null): boolean {
  if (!content) return false;
  if (findInvocationBlocks(content).some((b) => b.status === "in_progress")) return true;
  return findJobBlocks(content).some((b) => b.status === "in_progress");
}

// ── Cadence ──────────────────────────────────────────────────────────────────

/**
 * Cadences, in milliseconds. The ticker does not own a timer: it is driven by
 * the existing Galaxy poller's 15 s tick and these are minimum spacings
 * measured against that tick, so there is one interval in the process, one
 * place that knows whether anything is in flight, and one thing to stop.
 */
const ACTIVE_INTERVAL_MS = 15_000;
/** Nothing Loom launched is running. The history can still move -- a user can
 *  upload in Galaxy's own UI -- so we keep looking, just not four times a minute. */
const IDLE_INTERVAL_MS = 60_000;
/** Consecutive failures widen the gap from ACTIVE up to this. */
const MAX_BACKOFF_MS = 300_000;
/** Re-push an unchanged payload this often so the panel's "checked N ago" line
 *  cannot claim we have stopped asking when we have not. */
const STALE_REFRESH_MS = 60_000;
/** How long a resolved most-recently-used history is reused before re-asking.
 *  Only consulted when the notebook carries no binding. */
const HISTORY_RESOLVE_TTL_MS = 300_000;

export interface GalaxyLiveTickerDeps {
  snapshot: typeof fetchGalaxyLiveSnapshot;
  config: () => { url: string; apiKey: string } | null;
  mostRecentHistory: (signal?: AbortSignal) => Promise<GalaxyHistorySummary | null>;
  /** Hand a payload to the shell. Must not throw. */
  push: (payload: GalaxyLivePayload) => void;
  now: () => number;
  /**
   * Is there a panel to draw this? Checked at the top of every tick, before
   * the cadence, so a session whose dashboards never include the live history
   * asks Galaxy nothing at all. Absent means always.
   */
  wanted?: () => Promise<boolean>;
}

/** Everything except `updatedAt`, which moves on every read and would defeat
 *  the comparison it is supposed to take part in. */
function payloadFingerprint(payload: GalaxyLivePayload): string {
  const { updatedAt: _ignored, ...rest } = payload;
  return JSON.stringify(rest);
}

/**
 * Decides when to ask Galaxy and what to push, given the notebook the poller
 * already read. Separate from the fetch so the cadence rules can be tested
 * with a clock and no network.
 */
export class GalaxyLiveTicker {
  private running = false;
  private lastAttemptAt = 0;
  private lastPushAt = 0;
  private lastFingerprint: string | null = null;
  /**
   * The last payload that actually carried a history. Deliberately NOT "the
   * last payload": an `unchanged` tick re-stamps this to refresh the staleness
   * clock, and re-stamping an error payload wedged the panel on "Galaxy did not
   * answer" for the rest of the session. One dropped packet, and a settled
   * history whose `update_time` never moves again could never clear it.
   */
  private lastHistoryPayload: GalaxyLivePayload | null = null;
  private knownUpdateTime: string | null = null;
  private historyId: string | null = null;
  private failures = 0;
  private resolved: { id: string; at: number; server: string } | null = null;
  /** Whether the previous tick found a panel. Starts false so the first tick
   *  that finds one is treated as the panel appearing. */
  private panelWanted = false;
  /**
   * Everything this ticker asks Galaxy hangs off this, so `stop()` abandons
   * whatever is in flight. Without it a `session_shutdown` landing on a read
   * held the loop open for as long as the read took -- and `galaxyGet` is a
   * bare fetch with no timeout of its own, which against a stalling server
   * measured 301 seconds before it threw.
   */
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(private deps: GalaxyLiveTickerDeps) {}

  /** Stop ticking and abandon anything already in flight. Not reversible. */
  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /**
   * A signal for one tick, aborted when the session is.
   *
   * Deliberately NOT `AbortSignal.any([this.abort.signal, ...])`: `any`
   * registers the composite on each source for as long as that source lives and
   * Node never takes it off again, so hanging one off a signal that lives for
   * the whole session grows a list nothing empties -- measured at one retained
   * entry per call. This holds a single listener instead, and `done()` removes
   * it. Anything downstream may compose onto the returned signal freely: it
   * dies with the tick.
   */
  private tickSignal(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const onStop = (): void => controller.abort();
    this.abort.signal.addEventListener("abort", onStop, { once: true });
    return {
      signal: controller.signal,
      done: () => this.abort.signal.removeEventListener("abort", onStop),
    };
  }

  /** Minimum spacing for the next attempt, given what the notebook says. */
  private interval(live: boolean): number {
    const base = live ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    if (this.failures === 0) return base;
    // Doubling from the active cadence, not from the idle one: a server that is
    // down should be asked about at the same widening rate either way.
    const backoff = Math.min(MAX_BACKOFF_MS, ACTIVE_INTERVAL_MS * 2 ** this.failures);
    return Math.max(base, backoff);
  }

  private emit(payload: GalaxyLivePayload, now: number): void {
    const fingerprint = payloadFingerprint(payload);
    // Only a payload the panel draws a "checked N ago" line under is worth
    // re-sending unchanged. An `unavailable` sentence has no clock on it, so
    // re-pushing it every minute would be a wire message that changes nothing.
    const stale = Boolean(payload.history) && now - this.lastPushAt >= STALE_REFRESH_MS;
    if (fingerprint === this.lastFingerprint && !stale) return;
    this.lastFingerprint = fingerprint;
    if (payload.history) this.lastHistoryPayload = payload;
    this.lastPushAt = now;
    this.deps.push(payload);
  }

  private async resolveHistoryId(
    content: string | null,
    serverUrl: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const bound = historyIdFromNotebook(content, serverUrl);
    if (bound) return bound;
    const cached = this.resolved;
    if (
      cached &&
      cached.server === serverUrl &&
      this.deps.now() - cached.at < HISTORY_RESOLVE_TTL_MS
    ) {
      return cached.id;
    }
    // Deliberately not caught here. Returning null for a failed lookup would
    // report "this analysis is not attached to a Galaxy history yet" when the
    // truth is that Galaxy did not answer or rejected the key -- two sentences
    // that send the user somewhere completely different. Galaxy answering
    // "you have no histories" is the only real no-history, and that is the
    // null below.
    //
    // The resolve goes straight to `galaxyGet`, which is a bare fetch with no
    // timeout of its own, so the wall clock has to come from here. Composing
    // onto the tick's signal rather than the session's is what keeps it from
    // accumulating; both sources die with the tick.
    const summary = await this.deps.mostRecentHistory(
      AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
    );
    if (!summary?.id) return null;
    this.resolved = { id: summary.id, at: this.deps.now(), server: serverUrl };
    return summary.id;
  }

  /**
   * One poller tick. `content` is the notebook as the poller just read it, or
   * null when there is no notebook to read. Never throws.
   */
  async tick(content: string | null): Promise<void> {
    // The poller fires this without awaiting it, so nothing outside stops two
    // ticks overlapping while Galaxy is slow. This does.
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.runTick(content);
    } catch (err) {
      console.error("[galaxy-live] tick failed:", err);
    } finally {
      this.running = false;
    }
  }

  /** The payload for "Galaxy answered, and there is nothing to draw". */
  private unavailable(
    reason: NonNullable<GalaxyLivePayload["unavailable"]>,
    serverUrl: string | undefined,
    now: number,
  ): GalaxyLivePayload {
    return {
      version: GALAXY_LIVE_SCHEMA_VERSION,
      serverHost: serverHostOf(serverUrl),
      history: null,
      unavailable: reason,
      updatedAt: new Date(now).toISOString(),
    };
  }

  private async runTick(content: string | null): Promise<void> {
    const wanted = this.deps.wanted ? await this.deps.wanted() : true;
    if (!wanted) {
      this.panelWanted = false;
      return;
    }
    if (!this.panelWanted) {
      // The panel just appeared, or this is the first tick. Ask now rather than
      // up to a minute from now, and push whatever comes back even if it is
      // what was pushed before the panel went away: the widget that was just
      // added has never seen it.
      this.panelWanted = true;
      this.lastAttemptAt = 0;
      this.lastFingerprint = null;
    }
    const now = this.deps.now();
    const cfg = this.deps.config();
    if (!cfg) {
      // No credentials is a steady state, not a failure: say it once and stop
      // asking. The fingerprint check means a disconnected session costs one
      // push for the whole session.
      this.emit(this.unavailable("not-configured", undefined, now), now);
      return;
    }

    const live = notebookHasLiveWork(content);
    if (now - this.lastAttemptAt < this.interval(live)) return;
    this.lastAttemptAt = now;

    // One signal for everything this tick asks, released when it is done.
    const tick = this.tickSignal();
    try {
      await this.askGalaxy(content, cfg, now, tick.signal);
    } finally {
      tick.done();
    }
  }

  /** The half of a tick that talks to Galaxy, once the cadence has allowed it. */
  private async askGalaxy(
    content: string | null,
    cfg: { url: string; apiKey: string },
    now: number,
    signal: AbortSignal,
  ): Promise<void> {
    let historyId: string | null;
    try {
      historyId = await this.resolveHistoryId(content, cfg.url, signal);
    } catch (err) {
      // A stop that aborted the request mid-flight is not something to report
      // or to back off from; the session is over.
      if (this.stopped) return;
      // Asking Galaxy which history is current failed. That is the same class
      // of problem as the read below failing, and it reads the same way.
      this.failures++;
      this.emit(this.unavailable(classifyError(err), cfg.url, this.deps.now()), this.deps.now());
      return;
    }
    // The resolve may have come back after the session ended, either because it
    // was aborted or because it finished first. Either way there is nothing to
    // draw on and nothing worth asking Galaxy for.
    if (this.stopped) return;
    if (historyId !== this.historyId) {
      // A different history: the update_time we were comparing against belongs
      // to the old one, and reusing it would suppress the first real read.
      this.knownUpdateTime = null;
      this.historyId = historyId;
    }
    if (!historyId) {
      // Galaxy answered and said there is no history here. Not a failure, so
      // no backoff: the user creating one should show up on the next tick.
      this.failures = 0;
      this.emit(this.unavailable("no-history", cfg.url, now), now);
      return;
    }

    const result = await this.deps.snapshot(historyId, {
      knownUpdateTime: this.knownUpdateTime ?? undefined,
      // The snapshot applies its own timeout and reads this one as "the caller
      // gave up", which is the right reading only for a stop.
      signal,
    });
    if (result.aborted || this.stopped) return;

    if (result.unchanged) {
      this.failures = 0;
      // Galaxy answered and nothing moved. Re-stamp the history we already have
      // so the panel's staleness line reflects when we last asked, not when the
      // history last changed -- otherwise a quiet run looks abandoned.
      if (this.lastHistoryPayload) {
        this.emit(
          { ...this.lastHistoryPayload, updatedAt: new Date(this.deps.now()).toISOString() },
          this.deps.now(),
        );
      }
      return;
    }

    const payload = result.payload;
    if (!payload) return;
    if (payload.unavailable) {
      this.failures++;
      // Forget what we were comparing against. Otherwise the next healthy tick
      // sees an unmoved `update_time`, takes the cheap "nothing changed" path,
      // and never refetches the contents that would put the history back on
      // screen in place of the error.
      this.knownUpdateTime = null;
    } else {
      this.failures = 0;
      this.knownUpdateTime = payload.history?.updateTime || null;
    }
    this.emit(payload, this.deps.now());
  }
}

// ── Arming ───────────────────────────────────────────────────────────────────

const GALAXY_HISTORY_WIDGET = "galaxy-history";

/** The last answer, keyed on the layout file's identity, so a tick that finds
 *  the file unchanged pays one lstat and no parse. */
let wantedCache: { key: string; wanted: boolean } | null = null;

/**
 * Does any dashboard in this analysis hold the live-history panel?
 *
 * Neither shipped preset does, so for most sessions the answer is no and the
 * ticker never talks to Galaxy. A layout the brain cannot read -- a symlink,
 * over the cap -- counts as no: nothing it would draw for can be trusted to
 * exist. Read through the brain's own store, so the file is read the way every
 * other reader reads it.
 */
export async function layoutWantsGalaxyLive(): Promise<boolean> {
  const filePath = getDashboardPath();
  if (!filePath) return false;
  let key: string;
  try {
    const st = await fsp.lstat(filePath);
    key = `${filePath}|${st.ino}|${st.size}|${st.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    key = `${filePath}|absent`;
  }
  if (wantedCache?.key === key) return wantedCache.wanted;
  const read = await readDashboardDocument();
  const wanted =
    read.ok &&
    read.document.dashboards.some((d) =>
      d.panels.some((panel) => panel.widget === GALAXY_HISTORY_WIDGET),
    );
  wantedCache = { key, wanted };
  return wanted;
}

/** For tests: forget the cached answer. */
export function resetGalaxyLiveWantedCache(): void {
  wantedCache = null;
}

let ticker: GalaxyLiveTicker | null = null;
/** Bumped by every arm and every disarm, so a push from a tick that was already
 *  in flight when the session ended lands nowhere. */
let armGeneration = 0;

/**
 * Shells that draw a dashboard. In the terminal a widget push collapses to
 * nothing, so arming there would spend real Galaxy requests on a panel that
 * does not exist -- the CLI must cost exactly zero, which it does by never
 * registering the hook at all.
 */
function shellDrawsDashboard(): boolean {
  return isDesktopShell();
}

/**
 * Start pushing the live Galaxy history to the shell. Called from
 * `session-lifecycle.ts`, which owns startup and shutdown; idempotent, so a
 * brain restart that fires `session_start` twice does not leave two tickers.
 */
export function armGalaxyLivePanel(ctx: ExtensionContext): void {
  if (!shellDrawsDashboard()) {
    disarmGalaxyLivePanel();
    return;
  }
  // A fresh ticker per arming is deliberate: `session_start` means a new
  // session, and a new session wants the panel filled now rather than up to a
  // minute later. The generation is what makes shutdown mean shutdown -- the
  // hook is fired and not awaited, so a tick already in flight can still be
  // holding this closure after the session ends.
  const generation = ++armGeneration;
  const push = (payload: GalaxyLivePayload): void => {
    if (generation !== armGeneration) return;
    try {
      ctx.ui.setWidget(LoomWidgetKey.GalaxyLive, encodeJsonWidget(payload));
    } catch (err) {
      // Same guard as the notebook widget: a tick that lands after session
      // teardown fires against a ctx pi has invalidated, and touching ctx.ui
      // throws "ctx is stale after session replacement or reload". That one is
      // terminal for this arming, so stop. Anything else is surfaced and the
      // panel keeps trying -- one transient throw must not quietly cost the
      // user their panel for the rest of the session.
      if (err instanceof Error && /ctx is stale/i.test(err.message)) {
        disarmGalaxyLivePanel();
        return;
      }
      console.error("[galaxy-live] widget push failed:", err);
    }
  };
  // A ticker being replaced must let go of whatever it is waiting on; the new
  // one is about to ask the same questions.
  ticker?.stop();
  ticker = new GalaxyLiveTicker({
    snapshot: fetchGalaxyLiveSnapshot,
    config: getGalaxyConfig,
    mostRecentHistory: galaxyGetMostRecentHistory,
    push,
    now: () => Date.now(),
    wanted: layoutWantsGalaxyLive,
  });
  const own = ticker;
  setPollTickHook((content) => (own === ticker ? own.tick(content) : Promise.resolve()));
}

/** Stop pushing. Called from `session_shutdown`, beside `stopGalaxyPoller()`. */
export function disarmGalaxyLivePanel(): void {
  armGeneration++;
  // The generation guard already drops a late push. This is the other half:
  // stop waiting for the answer at all. Shutdown never blocked on it -- the
  // poller fires the hook without awaiting it -- but an in-flight bare fetch
  // holds the event loop, which is what the controller on the ticker is for.
  ticker?.stop();
  ticker = null;
  setPollTickHook(null);
}
