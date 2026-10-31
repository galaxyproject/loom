/**
 * Galaxy API helper for authenticated calls from the extension process.
 *
 * Uses the same env-var pattern as the rest of the extension (GALAXY_URL, GALAXY_API_KEY).
 * Provides typed wrappers for the specific endpoints used by invocation polling.
 */

import {
  createGalaxyContext,
  GalaxyConnectionError,
  GalaxyError,
  getDatasetDetails,
  getInvocations,
  type GalaxyContext,
  type GalaxyVersionReport,
  type InvocationDetail,
} from "@galaxyproject/galaxy-ops";
import { RedirectRefusedError, fetchSameOriginOnly } from "../../shared/redirect-guard.js";
import { normalizeGalaxyUrl } from "../../shared/galaxy-url.js";
import { transportCode } from "./galaxy-failure";

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy API response types
// ─────────────────────────────────────────────────────────────────────────────

export type { InvocationDetail } from "@galaxyproject/galaxy-ops";

/**
 * Invocation states in which Galaxy has stopped scheduling steps
 * (`InvocationState`). Anything else -- `new`, `ready`, `cancelling`, and
 * whatever Galaxy adds next -- means more jobs may still appear.
 *
 * `completed` arrived in Galaxy 26.0 with workflow completion monitoring: a
 * finished invocation moves on from `scheduled` to `completed` once all its
 * jobs are terminal. Leaving it out meant a finished workflow on a 26.x server
 * was never terminal to the poller, so it never transitioned or got enriched.
 */
export const INVOCATION_SCHEDULING_DONE: ReadonlySet<string> = new Set([
  "scheduled",
  "completed",
  "cancelled",
  "failed",
]);

/** States in which a finished invocation succeeded at scheduling everything. */
export const INVOCATION_SCHEDULED_OK: ReadonlySet<string> = new Set(["scheduled", "completed"]);

/**
 * Subset of GET /api/jobs/{jobId} we actually read.
 *
 * `tool_version` is declared because the ORM emits it, but Galaxy's response
 * model drops it (pydantic `extra="ignore"`), so on a real server it is
 * absent. The submission response is where a version actually survives. The
 * rest are only filled with `?full=true`; `inputs`/`outputs` are dicts keyed
 * by the tool's input/output name, not lists.
 */
export interface GalaxyJobDetailsResponse {
  id: string;
  state: string;
  tool_id: string;
  tool_version?: string;
  params?: Record<string, unknown>;
  exit_code?: number | null;
  create_time?: string;
  update_time?: string;
  command_version?: string | null;
  history_id?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  output_collections?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface GalaxyConfig {
  url: string;
  apiKey: string;
}

/**
 * How the redirect guard names things when it refuses one. `GALAXY_URL` is the
 * right thing to name here even for a profile-configured server: `/connect`
 * publishes the active profile into the env, so that is the value in play.
 */
const GALAXY_REDIRECT_LABELS = {
  serverLabel: "Galaxy",
  urlSettingLabel: "GALAXY_URL",
} as const;

/** The Galaxy URL and key in play, as given -- not normalized, possibly unset. */
export interface GalaxyCredentials {
  url: string | undefined;
  apiKey: string | undefined;
}

/**
 * The one place the brain reads Galaxy credentials. Without an argument it asks
 * the transport, so a shell with no process env (the browser worker) can supply
 * them, and falls back to GALAXY_URL/GALAXY_API_KEY. Pass `env` to read a given
 * environment instead -- pure helpers and tests do. Writers (/connect,
 * switchProfile) still publish into process.env.
 */
export function galaxyCredentials(env?: NodeJS.ProcessEnv): GalaxyCredentials {
  if (!env && transport.credentials) return transport.credentials();
  const source = env ?? process.env;
  return { url: source.GALAXY_URL, apiKey: source.GALAXY_API_KEY };
}

export function getGalaxyConfig(): GalaxyConfig | null {
  const { url, apiKey } = galaxyCredentials();
  if (!url || !apiKey) return null;
  // Every request goes through here, galaxy-ops' included, so this is where a
  // scheme-less host or a pasted `/api` root has to be caught, whatever the
  // shell or transport handed over.
  const normalized = normalizeGalaxyUrl(url);
  return normalized ? { url: normalized, apiKey } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An HTTP error from Galaxy, carrying the status code.
 *
 * The message is byte-identical to the plain Error this replaced, so callers
 * that match on the text keep working; what's new is that a caller can tell
 * "Galaxy says this id is not a thing" from "Galaxy didn't answer". Those two
 * deserve opposite handling -- the first is a mistake to report, the second is
 * a reason to try again later.
 */
export class GalaxyApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string, statusText: string) {
    super(`Galaxy API ${status}: ${body || statusText}`);
    this.name = "GalaxyApiError";
    this.status = status;
  }
}

type GalaxyFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How the brain reaches Galaxy when process env and the network aren't the
 * answer. Every part is optional; an empty transport is the default.
 */
export interface GalaxyTransport {
  /** Replaces the network for every Galaxy call made here, galaxy-ops' included. */
  fetch?: GalaxyFetch;
  /** Supplies the URL and key in place of GALAXY_URL/GALAXY_API_KEY. */
  credentials?: () => GalaxyCredentials;
  /** The answers are recorded, not live, so provenance marks them as fixtures. */
  fixture?: boolean;
}

let transport: GalaxyTransport = {};
// The transport's own fetch while a fixture stands in for it.
let liveFetch: GalaxyFetch | undefined;

export function setGalaxyTransport(next: GalaxyTransport | null): void {
  transport = next ?? {};
  liveFetch = undefined;
}

/**
 * Set only by the Tier-1 fixture seam (galaxy-fixture.ts) and by tests: the
 * capture scenarios have to exercise reconcile and enrichment against recorded
 * responses, and there is no other layer every one of those calls shares.
 * Swaps only the fetch, so installed credentials survive both setting and
 * clearing it, and clearing it puts back whatever fetch the transport had.
 */
export function setGalaxyFetchOverride(fetchImpl: GalaxyFetch | null): void {
  if (transport.fixture !== true) liveFetch = transport.fetch;
  transport = fetchImpl
    ? { ...transport, fetch: fetchImpl, fixture: true }
    : { ...transport, fetch: liveFetch, fixture: false };
}

/** Whether Galaxy answers are coming from a recorded fixture rather than a server. */
export function isGalaxyFetchOverridden(): boolean {
  return transport.fixture === true;
}

function galaxyFetch(url: string, init: RequestInit): Promise<Response> {
  if (transport.fetch) return transport.fetch(url, init);
  return fetchSameOriginOnly(url, init, GALAXY_REDIRECT_LABELS);
}

export async function galaxyGet<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const config = getGalaxyConfig();
  if (!config) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");

  const url = `${config.url}/api${path}`;
  const resp = await galaxyFetch(url, {
    headers: { "x-api-key": config.apiKey },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GalaxyApiError(resp.status, body, resp.statusText);
  }

  return resp.json() as Promise<T>;
}

async function galaxyMutate<T>(
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const config = getGalaxyConfig();
  if (!config) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");

  const url = `${config.url}/api${path}`;
  const resp = await galaxyFetch(url, {
    method,
    headers: {
      "x-api-key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new GalaxyApiError(resp.status, text, resp.statusText);
  }

  return resp.json() as Promise<T>;
}

export async function galaxyPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return galaxyMutate<T>("POST", path, body, signal);
}

export async function galaxyPut<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return galaxyMutate<T>("PUT", path, body, signal);
}

/**
 * Fetch one job by id. The poller reads only `state`; enrichment asks for
 * `full` to get the effective params and the input/output maps.
 *
 * Hand-rolled because galaxy-ops' `getJobDetails` takes a *dataset* id and
 * resolves the job from it, mirroring galaxy-mcp 1.9.0; nothing there looks a
 * job up by its own id.
 */
export async function galaxyGetJobDetails(
  jobId: string,
  signal?: AbortSignal,
  options: { full?: boolean } = {},
): Promise<GalaxyJobDetailsResponse> {
  const query = options.full ? "?full=true" : "";
  return galaxyGet<GalaxyJobDetailsResponse>(`/jobs/${encodeURIComponent(jobId)}${query}`, signal);
}

/** One row of `GET /api/jobs` (collection view). Every field but `id` is optional on purpose. */
export interface GalaxyJobListing {
  id: string;
  state?: string;
  tool_id?: string;
  tool_version?: string;
  history_id?: string;
  create_time?: string;
  update_time?: string;
  exit_code?: number | null;
}

/**
 * One page of a history's jobs, newest first (Galaxy sorts create_time descending).
 *
 * `date_range_min` is a day, not an instant: Galaxy filters it against
 * `update_time` and its accepted formats have moved between releases, while a
 * bare date has always parsed. That makes the page a superset of what the
 * caller wants, and the caller filters on `create_time` itself.
 *
 * Hand-rolled because galaxy-ops has no job listing.
 */
export async function galaxyListHistoryJobs(
  params: { historyId: string; sinceDay?: string; limit: number; offset: number },
  signal?: AbortSignal,
): Promise<GalaxyJobListing[]> {
  const query = new URLSearchParams({
    history_id: params.historyId,
    view: "collection",
    order_by: "create_time",
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.sinceDay) query.set("date_range_min", params.sinceDay);
  const rows = await galaxyGet<unknown>(`/jobs?${query.toString()}`, signal);
  if (!Array.isArray(rows)) throw new Error("Galaxy's job index did not return a list");
  return rows.filter(
    (r): r is GalaxyJobListing =>
      !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string",
  );
}

/**
 * What one round trip decided about a run id: Galaxy has it, Galaxy says it
 * doesn't, or we never got an answer. The third is not the second.
 */
export type GalaxyRunVerification =
  | { outcome: "found" }
  | { outcome: "absent"; detail: string }
  | { outcome: "unreachable"; detail: string };

/**
 * Statuses that mean "no such run" rather than "ask again later".
 *
 * 404 is the obvious one. 400 is there because Galaxy decodes ids before it
 * looks anything up, and `decode_id` raises MalformedId -- a 400 -- for a value
 * that isn't a valid encoded id at all. That is the shape a hallucinated or
 * truncated id actually arrives in, so treating 400 as "ask again later" would
 * let exactly the ids this check exists to catch through as unverified.
 */
const ABSENT_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/**
 * Galaxy's encoded ids are hex, which `galaxy-markdown-adapter.ts` already
 * relies on for the same reason: a value like `.` or `../histories` survives
 * `encodeURIComponent` unchanged, and URL dot-segment normalization then turns
 * `/api/jobs/.` into `/api/jobs` -- the *collection* endpoint, which answers
 * 200 with a list. Without this, `galaxy_job_record({jobId: "."})` records a
 * verified block for a job that does not exist.
 */
const ENCODED_ID_RE = /^[0-9a-fA-F]+$/;

/** Whether a value has the shape of a Galaxy encoded id. See ENCODED_ID_RE. */
export function isGalaxyEncodedId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ENCODED_ID_RE.test(value);
}

/**
 * Ask Galaxy whether a run id exists, without caring what it says beyond that.
 *
 * Deliberately fails open on anything that isn't a definite no: a 500, a dead
 * network, or missing credentials must not cost the user a record of a run they
 * really did submit. The caller marks those `server_verified: false` and lets
 * the poller settle it.
 */
export async function verifyGalaxyRun(
  kind: "invocation" | "job",
  id: string,
  signal?: AbortSignal,
): Promise<GalaxyRunVerification> {
  if (!ENCODED_ID_RE.test(id)) {
    return { outcome: "absent", detail: `"${id}" is not a Galaxy id (they are hex)` };
  }
  if (!getGalaxyConfig()) {
    return { outcome: "unreachable", detail: "Galaxy credentials are not configured" };
  }
  const path =
    kind === "invocation"
      ? `/invocations/${encodeURIComponent(id)}`
      : `/jobs/${encodeURIComponent(id)}`;
  try {
    const body = await galaxyGet<{ id?: unknown }>(path, signal);
    // A 200 is not the answer; a 200 *for this id* is. Anything else means the
    // request landed on some other resource, which is how a path that survives
    // encoding gets itself certified.
    if (!body || typeof body !== "object" || Array.isArray(body) || body.id !== id) {
      return { outcome: "absent", detail: `Galaxy answered for a different resource than ${id}` };
    }
    return { outcome: "found" };
  } catch (error) {
    if (error instanceof GalaxyApiError && ABSENT_STATUSES.has(error.status)) {
      return { outcome: "absent", detail: error.message };
    }
    return {
      outcome: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether a block's recorded `galaxy_server_url` is the server we are polling.
 *
 * Every Galaxy call reads the *current* credentials, not the block's own url,
 * so after a profile switch the poller happily asks server B about a block
 * recorded against server A. It has always done that; what must not follow is
 * B's answer certifying A's record. An empty url is no claim -- the block
 * predates the field, or was written with no credentials -- so it matches
 * whatever we have.
 */
export function sameGalaxyServer(
  blockUrl: string | undefined,
  currentUrl: string | undefined,
): boolean {
  if (!blockUrl) return true;
  if (!currentUrl) return false;
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  return norm(blockUrl) === norm(currentUrl);
}

export interface GalaxyHistorySummary {
  id: string;
  name?: string;
}

/**
 * The user's current (most-recently-used) history, resolved from just
 * GALAXY_URL + GALAXY_API_KEY. Returns null when Galaxy reports none.
 */
export async function galaxyGetMostRecentHistory(
  signal?: AbortSignal,
): Promise<GalaxyHistorySummary | null> {
  const res = await galaxyGet<GalaxyHistorySummary | null>("/histories/most_recently_used", signal);
  return res && typeof res.id === "string" && res.id.length > 0 ? res : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// galaxy-ops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fetch galaxy-ops gets, so its requests keep the redirect guard every
 * other Galaxy call here has: openapi-fetch hands over a Request carrying
 * `x-api-key`, and Node would forward that header across origins on a 3xx.
 *
 * It also carries the caller's abort signal. galaxy-ops' ops don't all pass
 * the context's signal to their requests (getInvocations doesn't, as of
 * 0.3.1), so without this a cancelled check would keep its request running.
 * Combined with the request's own signal, which galaxy-ops uses for timeouts.
 */
function galaxyOpsFetch(callerSignal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const signal = callerSignal ? AbortSignal.any([req.signal, callerSignal]) : req.signal;
    try {
      return await galaxyFetch(req.url, { method: req.method, headers: req.headers, body, signal });
    } catch (err) {
      throw withTransportCode(err);
    }
  };
}

/**
 * undici's "fetch failed" with its cause code appended, since galaxy-ops builds the model's
 * message from `.message` alone. Aborts and refused redirects keep their own wording.
 */
function withTransportCode(err: unknown): unknown {
  if (!(err instanceof Error) || err instanceof RedirectRefusedError) return err;
  if (err.name === "AbortError" || err.name === "TimeoutError") return err;
  const code = transportCode(err);
  if (!code || err.message.includes(code)) return err;
  const Ctor = err.constructor as new (message: string, options?: ErrorOptions) => Error;
  return new Ctor(`${err.message} (${code})`, { cause: err.cause ?? err });
}

/**
 * How long galaxy-ops' /api/version lookup may take. At least undici's 10 s connect timeout, so
 * the probe cannot call a server unreachable that every other op would still reach -- and
 * get_server_info is the one op that fails outright when the probe does.
 */
export const GALAXY_VERSION_PROBE_MS = 15_000;

// galaxy-ops keeps a version report per context, and there is a context per call, so without
// this every call would probe again. The whole report is kept rather than handed back as
// `serverVersion`: a supplied version has no payload, so get_server_info would lose version_minor.
let versionCache: { url: string; report: GalaxyVersionReport } | undefined;
// Bumped by a reset, so a lookup that started before it cannot store an old server's answer.
let versionEpoch = 0;

/** Forget the cached Galaxy version, as a new session or a /connect must. */
export function resetGalaxyOpsVersion(): void {
  versionCache = undefined;
  versionEpoch++;
}

/** A galaxy-ops context on the configured server, or null without credentials. */
export function galaxyOpsContext(signal?: AbortSignal): GalaxyContext | null {
  const config = getGalaxyConfig();
  if (!config) return null;
  const ctx = createGalaxyContext({
    baseUrl: config.url,
    apiKey: config.apiKey,
    signal,
    fetchImpl: galaxyOpsFetch(signal),
    versionProbeTimeoutMs: GALAXY_VERSION_PROBE_MS,
  });
  const cached = versionCache?.url === config.url ? versionCache.report : undefined;
  if (cached) return { ...ctx, galaxyVersion: () => Promise.resolve(cached) };
  const lookup = ctx.galaxyVersion;
  if (!lookup) return ctx;
  const epoch = versionEpoch;
  return {
    ...ctx,
    galaxyVersion: async () => {
      const report = await lookup();
      if (report.payload && epoch === versionEpoch) versionCache = { url: config.url, report };
      return report;
    },
  };
}

/**
 * A galaxy-ops failure, as the rest of the brain has always seen one. An HTTP
 * failure becomes the GalaxyApiError galaxyGet throws -- same status, same
 * message, built from the same raw body -- and a request that never got a
 * reply (a refused redirect, an abort, a dead network) rethrows what fetch
 * threw, which galaxy-ops had wrapped.
 */
function asOrbitFailure(err: unknown): unknown {
  if (!(err instanceof GalaxyError)) return err;
  const http = err.http;
  if (http && http.status !== null) {
    return new GalaxyApiError(http.status, http.bodyText, http.reason ?? "");
  }
  if (err instanceof GalaxyConnectionError && err.cause !== undefined) return err.cause;
  return err;
}

/**
 * One invocation with each step's jobs. `stepDetails` matters: without it
 * Galaxy answers with every step's `jobs` list empty, so a run still going
 * looks like one with nothing left to do.
 */
export async function galaxyGetInvocation(
  invocationId: string,
  signal?: AbortSignal,
): Promise<InvocationDetail> {
  const ctx = galaxyOpsContext(signal);
  if (!ctx) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");
  let result;
  try {
    result = await getInvocations({ invocationId, stepDetails: true }, ctx);
  } catch (err) {
    throw asOrbitFailure(err);
  }
  if (Array.isArray(result)) {
    throw new Error(`Galaxy answered a listing for invocation ${invocationId}`);
  }
  return result;
}

/**
 * One dataset's metadata (name, extension, dbkey, state, create time), through
 * galaxy-ops. No preview: enrichment wants the facts about a dataset, never
 * its content.
 */
export async function galaxyGetDataset(
  datasetId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const ctx = galaxyOpsContext(signal);
  if (!ctx) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");
  try {
    const result = await getDatasetDetails({ datasetId, includePreview: false }, ctx);
    return result.dataset;
  } catch (err) {
    throw asOrbitFailure(err);
  }
}

/**
 * A page of one history's invocations, through galaxy-ops. galaxy-ops takes
 * no offset or time filter, so this is the newest `limit` and the caller
 * filters by `create_time`.
 */
export async function galaxyListHistoryInvocations(
  historyId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<
  { id: string; create_time?: string; state?: string; workflow_id?: string; history_id?: string }[]
> {
  const ctx = galaxyOpsContext(signal);
  if (!ctx) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");
  let result;
  try {
    result = await getInvocations({ historyId, limit, stepDetails: false }, ctx);
  } catch (err) {
    throw asOrbitFailure(err);
  }
  if (!Array.isArray(result)) throw new Error("Galaxy answered one invocation for a listing");
  return result
    .filter((r) => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string")
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        ...(typeof row.create_time === "string" ? { create_time: row.create_time } : {}),
        ...(typeof row.state === "string" ? { state: row.state } : {}),
        ...(typeof row.workflow_id === "string" ? { workflow_id: row.workflow_id } : {}),
        ...(typeof row.history_id === "string" ? { history_id: row.history_id } : {}),
      };
    });
}
