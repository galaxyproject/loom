/** Read-only account activity. Loom owns retrieval, refresh and connection scope. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  GalaxyActivitySnapshot,
  RecentGalaxyHistory,
  RecentGalaxyInvocation,
} from "../../shared/loom-shell-contract.js";
import { LoomWidgetKey, encodeJsonWidget } from "../../shared/loom-shell-contract.js";
import { isDesktopShell } from "../../shared/orbit-env.js";
import { getGalaxyConfig, type GalaxyConfig } from "./galaxy-api.js";
import { validateGalaxyUrl } from "./profiles.js";

const LIMIT = 12;
const EMPTY = { histories: [], invocations: [] };
type Row = Record<string, unknown>;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]+$/i.test(v);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function failure(error: unknown): string {
  if (error instanceof Error && error.message === "auth")
    return "Galaxy sign-in failed. Check your API key in Preferences.";
  return "Couldn’t load recent activity from Galaxy. Check your connection and try again.";
}

export async function fetchGalaxyActivity(
  config: GalaxyConfig,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GalaxyActivitySnapshot> {
  const server = config.url.replace(/\/+$/, "");
  if (!validateGalaxyUrl(server).ok) throw new Error("Invalid Galaxy URL");
  async function get(path: string): Promise<unknown> {
    const response = await fetchImpl(`${server}/api${path}`, {
      headers: { "x-api-key": config.apiKey },
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(response.status === 401 || response.status === 403 ? "auth" : "unavailable");
    return response.json();
  }
  async function list(path: string): Promise<Row[]> {
    const value = await get(path);
    if (!Array.isArray(value)) throw new Error("Invalid Galaxy list");
    return value
      .filter((r): r is Row => Boolean(r && typeof r === "object" && id(r.id)))
      .slice(0, LIMIT);
  }
  async function ownInvocations(): Promise<Row[]> {
    const user = (await get("/users/current")) as Row | null;
    if (!id(user?.id) || user?.is_anonymous === true) throw new Error("Invalid Galaxy user");
    // An admin key can list other accounts' invocations. Scope the query on
    // Galaxy before sorting/limiting, rather than filtering a global page.
    // Never fall back to an unscoped listing if identity resolution fails.
    return list(
      `/invocations?user_id=${encodeURIComponent(user.id)}&sort_by=create_time&sort_desc=true&limit=${LIMIT}&view=collection&include_terminal=true&include_nested_invocations=false`,
    );
  }
  const [histories, invocations] = await Promise.allSettled([
    list(
      `/histories?order=update_time-dsc&limit=${LIMIT}&view=summary&q=deleted&q=purged&qv=False&qv=False`,
    ),
    ownInvocations(),
  ]);
  const now = new Date().toISOString();
  const result: GalaxyActivitySnapshot = { server, phase: "ready", ...EMPTY };
  if (histories.status === "fulfilled") {
    result.histories = histories.value
      .filter((h) => !h.deleted && !h.purged && !h.archived)
      .map((h): RecentGalaxyHistory => ({
        id: h.id as string,
        name: text(h.name, "Unnamed history"),
        count: typeof h.count === "number" && h.count >= 0 ? h.count : undefined,
        updatedAt: text(h.update_time),
        published: h.published === true,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    result.historiesUpdatedAt = now;
  } else result.historiesError = failure(histories.reason);
  if (invocations.status === "fulfilled") {
    const historiesById = new Map(result.histories.map((h) => [h.id, h.name]));
    const workflowsById = new Map<string, string>();
    // Resolve names from the invoked Workflow instance, not its latest StoredWorkflow.
    // Name lookup failures do not hide the invocation itself.
    const workflowIds = [...new Set(invocations.value.map((r) => r.workflow_id).filter(id))];
    const historyIds = [...new Set(invocations.value.map((r) => r.history_id).filter(id))].filter(
      (h) => !historiesById.has(h),
    );
    await Promise.allSettled([
      ...workflowIds.map(async (wid) => {
        const row = (await get(`/workflows/${wid}?instance=true`)) as Row;
        if (typeof row?.name === "string") workflowsById.set(wid, row.name);
      }),
      ...historyIds.map(async (hid) => {
        const row = (await get(`/histories/${hid}`)) as Row;
        if (typeof row?.name === "string") historiesById.set(hid, row.name);
      }),
    ]);
    result.invocations = invocations.value
      .filter((r) => id(r.history_id))
      .map((r): RecentGalaxyInvocation => ({
        id: r.id as string,
        name: workflowsById.get(text(r.workflow_id)) || "Workflow name unavailable",
        historyId: r.history_id as string,
        historyName: historiesById.get(r.history_id as string) || "History name unavailable",
        state: text(r.state, "unknown"),
        createdAt: text(r.create_time),
        updatedAt: text(r.update_time),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    result.invocationsUpdatedAt = now;
  } else result.invocationsError = failure(invocations.reason);
  if (result.historiesError && result.invocationsError) result.phase = "error";
  return result;
}

/** Coalesces same-account requests; aborts and discards responses after a switch. */
export class GalaxyActivityFeed {
  private identity = "";
  private generation = 0;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private previous?: GalaxyActivitySnapshot;
  constructor(
    private readonly publish: (value: GalaxyActivitySnapshot) => void,
    private readonly config: () => GalaxyConfig | null = getGalaxyConfig,
    private readonly fetcher = fetchGalaxyActivity,
  ) {}

  refresh(): Promise<void> {
    const config = this.config();
    const identity = config ? JSON.stringify([config.url, config.apiKey]) : "";
    if (identity !== this.identity) {
      this.stop();
      this.identity = identity;
    }
    if (!config) {
      this.publish({ server: null, phase: "disconnected", ...EMPTY });
      return Promise.resolve();
    }
    if (this.pending) return this.pending;
    const generation = this.generation;
    const controller = (this.controller = new AbortController());
    const timer = setTimeout(() => controller.abort(), 12_000);
    this.publish({
      ...this.previous,
      server: config.url,
      phase: "loading",
      histories: this.previous?.histories || [],
      invocations: this.previous?.invocations || [],
    });
    this.pending = (async () => {
      let result: GalaxyActivitySnapshot;
      try {
        result = await this.fetcher(config, controller.signal);
      } catch (error) {
        result = {
          server: config.url,
          phase: "error",
          ...EMPTY,
          historiesError: failure(error),
          invocationsError: failure(error),
        };
      }
      const current = this.config();
      if (
        generation !== this.generation ||
        !current ||
        current.url !== config.url ||
        current.apiKey !== config.apiKey
      )
        return;
      // Keep last-known data only within the same account, labeled stale on error.
      if (result.historiesError && this.previous) {
        result.histories = this.previous.histories;
        result.historiesUpdatedAt = this.previous.historiesUpdatedAt;
      }
      if (result.invocationsError && this.previous) {
        result.invocations = this.previous.invocations;
        result.invocationsUpdatedAt = this.previous.invocationsUpdatedAt;
      }
      this.previous = result;
      this.publish(result);
    })().finally(() => {
      clearTimeout(timer);
      if (generation === this.generation) this.pending = undefined;
    });
    return this.pending;
  }

  stop(): void {
    this.generation++;
    this.controller?.abort();
    this.pending = undefined;
    this.previous = undefined;
  }
}

let feed: GalaxyActivityFeed | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
export function startGalaxyActivity(ctx: ExtensionContext): void {
  stopGalaxyActivity();
  if (!isDesktopShell()) return;
  feed = new GalaxyActivityFeed((snapshot) => {
    try {
      ctx.ui.setWidget(LoomWidgetKey.GalaxyActivity, encodeJsonWidget(snapshot));
    } catch {
      stopGalaxyActivity();
    } // session context replaced
  });
  void feed.refresh();
  timer = setInterval(() => void feed?.refresh(), 60_000);
  timer.unref();
}
export function refreshGalaxyActivity(): Promise<void> {
  return feed?.refresh() || Promise.resolve();
}
export function stopGalaxyActivity(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  feed?.stop();
  feed = undefined;
}
