/**
 * Galaxy API helper for authenticated calls from the extension process.
 *
 * Uses the same env-var pattern as the rest of the extension (GALAXY_URL, GALAXY_API_KEY).
 * Provides typed wrappers for the specific endpoints used by invocation polling.
 */

import { fetchSameOriginOnly } from "../../shared/redirect-guard.js";

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy API response types
// ─────────────────────────────────────────────────────────────────────────────

export interface GalaxyInvocationStepJob {
  id: string;
  state: string;
  tool_id: string;
}

export interface GalaxyInvocationStep {
  id: string;
  order_index: number;
  state: string | null;
  jobs: GalaxyInvocationStepJob[];
}

export interface GalaxyInvocationResponse {
  id: string;
  state: string;
  workflow_id: string;
  history_id: string;
  steps: GalaxyInvocationStep[];
}

/**
 * Subset of GET /api/jobs/{jobId} we actually read.
 * tool_version lives at the top level per Galaxy's Job.to_dict().
 */
export interface GalaxyJobDetailsResponse {
  id: string;
  state: string;
  tool_id: string;
  tool_version: string;
  params?: Record<string, unknown>;
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

export function getGalaxyConfig(): GalaxyConfig | null {
  const url = process.env.GALAXY_URL;
  const apiKey = process.env.GALAXY_API_KEY;
  if (!url || !apiKey) return null;
  // Galaxy URLs from the config profile / env often arrive scheme-less
  // (e.g. "test.galaxyproject.org/"). The MCP layer tolerates that, but
  // fetch() can't parse a schemeless URL, so default to https here.
  const trimmed = url.trim().replace(/\/+$/, "");
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { url: normalized, apiKey };
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

export async function galaxyGet<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const config = getGalaxyConfig();
  if (!config) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");

  const url = `${config.url}/api${path}`;
  const resp = await fetchSameOriginOnly(
    url,
    {
      headers: { "x-api-key": config.apiKey },
      signal,
    },
    GALAXY_REDIRECT_LABELS,
  );

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
  const resp = await fetchSameOriginOnly(
    url,
    {
      method,
      headers: {
        "x-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    },
    GALAXY_REDIRECT_LABELS,
  );

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
 * Fetch job details from Galaxy: `id`, `state`, `tool_id`, `tool_version`,
 * and `params`. The invocation poller is the only caller today and reads
 * only `state`.
 */
export async function galaxyGetJobDetails(
  jobId: string,
  signal?: AbortSignal,
): Promise<GalaxyJobDetailsResponse> {
  return galaxyGet<GalaxyJobDetailsResponse>(`/jobs/${encodeURIComponent(jobId)}`, signal);
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
