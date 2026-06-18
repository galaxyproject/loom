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
