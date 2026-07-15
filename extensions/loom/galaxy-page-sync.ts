import { stripUntrustedMarkers } from "./galaxy-pages-sync.js";
import { stripGalaxyPageBlocks } from "./galaxy-page-binding.js";

export function parsePageSyncMode(env: NodeJS.ProcessEnv): "auto" | "off" {
  return env.LOOM_GALAXY_PAGE_SYNC === "auto" ? "auto" : "off";
}

/** Deterministic per-history page identity so a fresh container finds the prior page. */
export function pageSlugForHistory(historyId: string): string {
  return `orbit-${historyId}`;
}

export function pageTitleForHistory(historyId: string): string {
  return `Orbit notebook (${historyId.slice(0, 8)})`;
}

/**
 * The canonical comparison body: notebook content with the binding block and
 * untrusted markers removed, matching exactly what pushNotebookToGalaxy persists
 * locally. Used to dedupe pushes and break the watcher self-trigger loop.
 */
export function strippedNotebookBody(content: string): string {
  return stripUntrustedMarkers(stripGalaxyPageBlocks(content)).trim();
}

export function hasBodyChanged(prev: string | null, next: string): boolean {
  return prev !== next;
}

import { getNotebookPath, onNotebookChange } from "./state.js";
import { readNotebook } from "./notebook-writer.js";
import { getGalaxyConfig, galaxyGetMostRecentHistory } from "./galaxy-api.js";
import { pushNotebookToGalaxy, resumeGalaxyPage } from "./galaxy-pages-sync.js";
import { listHistoryPages } from "./galaxy-pages-api.js";

export interface PageSyncDeps {
  mode: "auto" | "off";
  hasGalaxy: () => boolean;
  getHistoryId: () => Promise<string | null>;
  readBody: () => Promise<string>;
  findPageId: (historyId: string, slug: string) => Promise<string | null>;
  resume: (pageId: string) => Promise<void>;
  push: (o: { historyId: string; slug: string; title: string }) => Promise<void>;
  subscribe: (cb: () => void) => () => void;
  debounceMs: number;
  /**
   * Cap on each init-time Galaxy call. init() runs inside session_start, so an
   * unbounded history request against a wedged Galaxy hangs the session's whole
   * startup rather than just costing us page sync.
   */
  initTimeoutMs?: number;
  /**
   * How many times to try resolving the history before giving up for good.
   * Attempts are lazy -- one per change event -- so a Galaxy that's briefly down
   * at launch costs a retry, not the session's durability.
   */
  maxInitAttempts?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_INIT_ATTEMPTS = 5;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createPageSyncEngine(deps: PageSyncDeps) {
  let historyId: string | null = null;
  let slug = "";
  let lastBody: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let active = false;
  let initAttempts = 0;
  const initTimeoutMs = deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const maxInitAttempts = deps.maxInitAttempts ?? DEFAULT_MAX_INIT_ATTEMPTS;
  // Serialize pushes: at most one in flight; a change arriving mid-push queues
  // exactly one follow-up so the latest body still lands. flush() awaits this.
  let inFlight: Promise<void> | null = null;
  let pendingAgain = false;

  async function doPush(): Promise<void> {
    // A launch-time blip leaves us unarmed; retry here so the first change after
    // Galaxy comes back recovers sync instead of the session running to its end
    // with a notebook that only exists under /tmp.
    if (!historyId && !(await arm())) return;
    if (!historyId) return;
    const body = await deps.readBody();
    if (!hasBodyChanged(lastBody, body)) return; // dedupe + self-trigger guard
    // Never create/overwrite a page with an empty body: an untouched notebook
    // has nothing worth persisting, and lastBody is null until a resume gives us
    // a real baseline, so without this a no-op session would publish a blank page.
    if (body.length === 0) return;
    await deps.push({ historyId, slug, title: pageTitleForHistory(historyId) });
    lastBody = body;
  }

  // Run pushes one at a time. A change that lands while a push is in flight sets
  // pendingAgain, so the loop runs doPush once more afterward -- never two
  // concurrent pushes (which raced on lastBody and could double-create the
  // page), and the latest body always wins. Returns the in-flight promise so
  // flush() can await whatever is already running plus the queued follow-up.
  function requestPush(): Promise<void> {
    if (inFlight) {
      pendingAgain = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          pendingAgain = false;
          await doPush();
        } while (pendingAgain);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * Resolve the history and adopt any prior page for it. Returns true once the
   * engine can push. Safe to call repeatedly: it no-ops once armed and stops
   * trying after maxInitAttempts so a permanently unreachable Galaxy doesn't
   * mean a Galaxy call on every change event for the rest of the session.
   */
  async function arm(): Promise<boolean> {
    if (historyId) return true;
    if (initAttempts >= maxInitAttempts) return false;
    initAttempts++;

    let resolved: string | null;
    try {
      resolved = await withTimeout(deps.getHistoryId(), initTimeoutMs, "history lookup");
    } catch (err) {
      console.error("[page-sync] history lookup failed:", err);
      return false;
    }
    if (!resolved) return false;

    historyId = resolved;
    slug = pageSlugForHistory(historyId);
    // Galaxy's GET /pages/{id} takes a page id, not a slug, so resolve the
    // per-history page id by listing the history's pages and matching the
    // derived slug, then resume by id. A fresh container has no local binding,
    // so listing is the only way to rediscover the page.
    let existingPageId: string | null = null;
    try {
      existingPageId = await withTimeout(
        deps.findPageId(historyId, slug),
        initTimeoutMs,
        "page listing",
      );
    } catch {
      /* listing failed — treat as no prior page; created on first push */
    }
    let resumed = false;
    if (existingPageId) {
      try {
        await deps.resume(existingPageId); // refresh notebook from the prior page
        resumed = true;
      } catch (err) {
        console.error("[page-sync] resume failed:", err);
      }
    }
    // Baseline only from a resume, where the notebook now mirrors the page and
    // the write we just made would otherwise self-trigger a pointless push.
    // Without a resume the local notebook is the authoritative copy, so leave
    // the baseline empty and let the next push carry it to Galaxy -- seeding it
    // from disk here is what made a recovered session flush nothing at all.
    lastBody = resumed ? await deps.readBody() : null;
    return true;
  }

  async function init(): Promise<void> {
    if (deps.mode !== "auto" || !deps.hasGalaxy()) return;
    await arm();
    // Subscribe regardless: an unarmed engine retries on the next change (see
    // doPush), so a Galaxy that's down at launch no longer disables sync for the
    // whole session.
    active = true;
    unsubscribe = deps.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void requestPush().catch((err) => console.error("[page-sync] push failed:", err));
      }, deps.debounceMs);
    });
  }

  async function flush(): Promise<void> {
    if (!active) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await requestPush();
    } catch (err) {
      console.error("[page-sync] flush push failed:", err);
    }
  }

  function dispose(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    active = false;
    historyId = null;
    lastBody = null;
    pendingAgain = false;
    initAttempts = 0;
  }

  return { init, flush, dispose };
}

// ── Module-level wiring with the real dependencies ────────────────────────────

let engine: ReturnType<typeof createPageSyncEngine> | null = null;

const DEBOUNCE_MS = parseInt(process.env.LOOM_GALAXY_PAGE_SYNC_DEBOUNCE_MS ?? "1500", 10);

function realDeps(): PageSyncDeps {
  return {
    mode: parsePageSyncMode(process.env),
    hasGalaxy: () => getGalaxyConfig() != null,
    getHistoryId: async () => (await galaxyGetMostRecentHistory())?.id ?? null,
    readBody: async () => {
      const p = getNotebookPath();
      if (!p) return "";
      return strippedNotebookBody(await readNotebook(p));
    },
    findPageId: async (historyId, slug) => {
      const pages = await listHistoryPages(historyId);
      const match = pages.find((p) => p.slug === slug);
      return match ? match.id : null;
    },
    resume: async (pageId) => {
      await resumeGalaxyPage(pageId);
    },
    push: async ({ historyId, slug, title }) => {
      await pushNotebookToGalaxy({ historyId, slug, title });
    },
    subscribe: (cb) => onNotebookChange(() => cb()),
    debounceMs: Number.isFinite(DEBOUNCE_MS) ? DEBOUNCE_MS : 1500,
  };
}

export async function initGalaxyPageSync(): Promise<void> {
  resetGalaxyPageSync();
  engine = createPageSyncEngine(realDeps());
  try {
    await engine.init();
  } catch (err) {
    console.error("[page-sync] init failed:", err);
  }
}

export async function flushNotebookToGalaxy(): Promise<void> {
  if (engine) await engine.flush();
}

export function resetGalaxyPageSync(): void {
  if (engine) engine.dispose();
  engine = null;
}
