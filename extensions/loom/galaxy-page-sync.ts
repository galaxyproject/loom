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
}

export function createPageSyncEngine(deps: PageSyncDeps) {
  let historyId: string | null = null;
  let slug = "";
  let lastBody: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let active = false;
  // Serialize pushes: at most one in flight; a change arriving mid-push queues
  // exactly one follow-up so the latest body still lands. flush() awaits this.
  let inFlight: Promise<void> | null = null;
  let pendingAgain = false;

  async function doPush(): Promise<void> {
    if (!historyId) return;
    const body = await deps.readBody();
    if (!hasBodyChanged(lastBody, body)) return; // dedupe + self-trigger guard
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

  async function init(): Promise<void> {
    if (deps.mode !== "auto" || !deps.hasGalaxy()) return;
    let resolved: string | null = null;
    try {
      resolved = await deps.getHistoryId();
    } catch {
      /* treat a rejected getHistoryId as "no history" → skip sync */
    }
    historyId = resolved;
    if (!historyId) return;
    slug = pageSlugForHistory(historyId);
    // Galaxy's GET /pages/{id} takes a page id, not a slug, so resolve the
    // per-history page id by listing the history's pages and matching the
    // derived slug, then resume by id. A fresh container has no local binding,
    // so listing is the only way to rediscover the page.
    let existingPageId: string | null = null;
    try {
      existingPageId = await deps.findPageId(historyId, slug);
    } catch {
      /* listing failed — treat as no prior page; created on first push */
    }
    if (existingPageId) {
      try {
        await deps.resume(existingPageId); // refresh notebook from the prior page
      } catch (err) {
        console.error("[page-sync] resume failed:", err);
      }
    }
    lastBody = await deps.readBody();
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
