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

export interface PageSyncDeps {
  mode: "auto" | "off";
  hasGalaxy: () => boolean;
  getHistoryId: () => Promise<string | null>;
  readBody: () => Promise<string>;
  resume: (slug: string) => Promise<void>;
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

  async function doPush(): Promise<void> {
    if (!historyId) return;
    const body = await deps.readBody();
    if (!hasBodyChanged(lastBody, body)) return; // dedupe + self-trigger guard
    await deps.push({ historyId, slug, title: pageTitleForHistory(historyId) });
    lastBody = body;
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
    try {
      await deps.resume(slug); // refreshes notebook from the prior page if it exists
    } catch {
      /* no prior page (404) — fresh notebook; created on first push */
    }
    lastBody = await deps.readBody();
    active = true;
    unsubscribe = deps.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void doPush().catch((err) => console.error("[page-sync] push failed:", err));
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
      await doPush();
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
    resume: async (slug) => {
      await resumeGalaxyPage(slug);
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
