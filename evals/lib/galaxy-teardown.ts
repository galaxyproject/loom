/**
 * Opt-in cleanup for the live Galaxy scenarios. They create histories on a
 * shared public server; this purges the ones a run made and nothing else.
 *
 * Two fences keep it from touching anything it shouldn't: the name has to
 * start with EVAL_HISTORY_PREFIX, and it has to contain one of the run ids
 * this process handed out (scenarios splice `{{RUN_ID}}` into the name). A
 * history that fails either test is left alone -- even one a scenario created
 * under some other name, and even one from a concurrent eval run on the same
 * account.
 */

export const EVAL_HISTORY_PREFIX = "loom-eval-";

export interface HistorySummary {
  id: string;
  name: string;
  purged?: boolean;
}

export interface TeardownResult {
  purged: { id: string; name: string }[];
  failed: { id: string; name: string; error: string }[];
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function selectEvalHistories(
  histories: HistorySummary[],
  runIds: string[],
  prefix = EVAL_HISTORY_PREFIX,
): HistorySummary[] {
  if (!prefix) throw new Error("refusing to select histories with an empty prefix");
  const ids = runIds.filter((id) => id.length > 0);
  const seen = new Set<string>();
  return histories.filter((h) => {
    if (typeof h.name !== "string" || !h.name.startsWith(prefix) || h.purged) return false;
    if (!ids.some((id) => h.name.includes(id))) return false;
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });
}

export async function purgeEvalHistories(opts: {
  galaxyUrl: string;
  apiKey: string;
  runIds: string[];
  prefix?: string;
  fetchImpl?: FetchLike;
}): Promise<TeardownResult> {
  const result: TeardownResult = { purged: [], failed: [] };
  if (opts.runIds.length === 0) return result;
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = opts.galaxyUrl.replace(/\/+$/, "");
  const headers = { "x-api-key": opts.apiKey, accept: "application/json" };

  // Soft-deleted histories are listed separately; one that a scenario managed
  // to delete still needs purging.
  const listed: HistorySummary[] = [];
  for (const deleted of ["false", "true"]) {
    const res = await doFetch(
      `${base}/api/histories?keys=id,name,purged&deleted=${deleted}&limit=1000`,
      { headers },
    );
    if (!res.ok) throw new Error(`listing histories failed: HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body)) listed.push(...(body as HistorySummary[]));
  }

  for (const h of selectEvalHistories(listed, opts.runIds, opts.prefix)) {
    try {
      const res = await doFetch(`${base}/api/histories/${encodeURIComponent(h.id)}?purge=true`, {
        method: "DELETE",
        headers,
      });
      if (res.ok) result.purged.push({ id: h.id, name: h.name });
      else result.failed.push({ id: h.id, name: h.name, error: `HTTP ${res.status}` });
    } catch (err) {
      result.failed.push({
        id: h.id,
        name: h.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
