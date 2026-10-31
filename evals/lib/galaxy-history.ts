/**
 * Resolve the Galaxy histories a scenario's prompt names to their ids, so an
 * assertion can check that a tool ran where the user asked. History ids differ
 * per server, so a scenario names the history and the runner looks it up at
 * run start with the same GALAXY_URL/GALAXY_API_KEY the run itself uses.
 *
 * Resolution is strict: a name with no live match, or more than one, is an
 * error rather than a guess, and the runner fails the run on it instead of
 * spending a model run that could only be graded against the wrong history.
 */

import type { FetchLike } from "./galaxy-teardown.js";
import type { Assertions } from "./types.js";

export interface HistoryResolution {
  ids: Record<string, string>;
  errors: Record<string, string>;
}

/** Every history name the scenario's assertions need resolved, deduplicated. */
export function historyNamesToResolve(assertions: Assertions): string[] {
  const names = (assertions.toolCalls?.inHistory ?? []).map((e) => e.history);
  return [...new Set(names)];
}

export async function resolveHistoryIds(opts: {
  galaxyUrl: string | undefined;
  apiKey: string | undefined;
  names: string[];
  fetchImpl?: FetchLike;
}): Promise<HistoryResolution> {
  const out: HistoryResolution = { ids: {}, errors: {} };
  if (opts.names.length === 0) return out;
  if (!opts.galaxyUrl || !opts.apiKey) {
    for (const name of opts.names) out.errors[name] = "GALAXY_URL/GALAXY_API_KEY unset";
    return out;
  }
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = opts.galaxyUrl.replace(/\/+$/, "");
  const headers = { "x-api-key": opts.apiKey, accept: "application/json" };

  for (const name of opts.names) {
    try {
      // The server-side name filter narrows the listing; the exact match below
      // is what decides, so a server that ignores q/qv still resolves correctly.
      const res = await doFetch(
        `${base}/api/histories?keys=id,name,deleted,purged&deleted=false&limit=1000` +
          `&q=name&qv=${encodeURIComponent(name)}`,
        { headers },
      );
      if (!res.ok) {
        out.errors[name] = `listing histories failed: HTTP ${res.status}`;
        continue;
      }
      const body = await res.json();
      const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
      const matches = rows.filter(
        (h) =>
          h.name === name && h.deleted !== true && h.purged !== true && typeof h.id === "string",
      );
      const ids = [...new Set(matches.map((h) => h.id as string))];
      if (ids.length === 1) out.ids[name] = ids[0];
      else if (ids.length === 0) out.errors[name] = `no live history named '${name}'`;
      else
        out.errors[name] = `${ids.length} live histories are named '${name}' (${ids.join(", ")})`;
    } catch (err) {
      out.errors[name] = err instanceof Error ? err.message : String(err);
    }
  }
  return out;
}
