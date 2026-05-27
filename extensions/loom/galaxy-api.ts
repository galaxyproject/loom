/**
 * Galaxy API helper for authenticated calls from the extension process.
 *
 * Uses the same env-var pattern as the rest of the extension (GALAXY_URL, GALAXY_API_KEY).
 * Provides typed wrappers for the specific endpoints used by invocation polling.
 */

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

export function getGalaxyConfig(): GalaxyConfig | null {
  const url = process.env.GALAXY_URL;
  const apiKey = process.env.GALAXY_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated fetch
// ─────────────────────────────────────────────────────────────────────────────

export async function galaxyGet<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const config = getGalaxyConfig();
  if (!config) throw new Error("Galaxy credentials not configured (GALAXY_URL, GALAXY_API_KEY)");

  const url = `${config.url}/api${path}`;
  const resp = await fetch(url, {
    headers: { "x-api-key": config.apiKey },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Galaxy API ${resp.status}: ${body || resp.statusText}`);
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
  const resp = await fetch(url, {
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
    throw new Error(`Galaxy API ${resp.status}: ${text || resp.statusText}`);
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
 * Fetch job details from Galaxy. Returns the full response; callers typically
 * only need `tool_version`.
 */
export async function galaxyGetJobDetails(
  jobId: string,
  signal?: AbortSignal,
): Promise<GalaxyJobDetailsResponse> {
  return galaxyGet<GalaxyJobDetailsResponse>(`/jobs/${encodeURIComponent(jobId)}`, signal);
}
