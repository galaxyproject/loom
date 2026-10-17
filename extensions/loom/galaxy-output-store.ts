/**
 * Where an oversized Galaxy result waits for `galaxy_read_output`.
 *
 * galaxy-ops runs in the same heap as the tool that reads its output back, so a spill needs no
 * temp file: the full text stays in a bounded ring of recent outputs, and the model gets an id.
 * Lookups are by that id only, never by a path the model supplies. The ring does not survive a
 * restart; `galaxy_read_output` tells the model to call the tool again when an id is gone.
 *
 * `setGalaxyOutputStore` is a seam for a shell that wants persistence. Nothing installs one.
 */

import { utf8ByteLength } from "../../shared/truncate-middle.js";
import { ulid } from "./ulid";

export interface GalaxyOutputEntry {
  id: string;
  tool: string;
  bytes: number;
  at: number;
}

export interface GalaxyOutputStore {
  put(text: string, tool: string): string;
  get(id: string): string | undefined;
  /** Oldest first. */
  list(): readonly GalaxyOutputEntry[];
}

export interface GalaxyOutputLimits {
  entries: number;
  bytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: Readonly<GalaxyOutputLimits> = Object.freeze({
  entries: 32,
  bytes: 64 * 1024 * 1024,
});

export function createMemoryOutputStore(
  limits: GalaxyOutputLimits = DEFAULT_OUTPUT_LIMITS,
): GalaxyOutputStore {
  // A Map iterates in insertion order, so its first key is always the oldest entry.
  const entries = new Map<string, GalaxyOutputEntry & { text: string }>();
  let total = 0;
  return {
    put(text, tool) {
      const bytes = utf8ByteLength(text);
      // An entry over the byte cap still evicts everything else and is kept alone: dropping it
      // would leave the model a preview whose outputId resolves to nothing.
      while (entries.size > 0 && (entries.size >= limits.entries || total + bytes > limits.bytes)) {
        const [oldest, entry] = entries.entries().next().value!;
        entries.delete(oldest);
        total -= entry.bytes;
      }
      const id = ulid();
      entries.set(id, { id, tool, bytes, at: Date.now(), text });
      total += bytes;
      return id;
    },
    get(id) {
      return entries.get(id)?.text;
    },
    list() {
      return [...entries.values()].map(({ id, tool, bytes, at }) => ({ id, tool, bytes, at }));
    },
  };
}

let current: GalaxyOutputStore | null = null;

/** The installed store, or the default in-memory ring, created on first use. */
export function galaxyOutputStore(): GalaxyOutputStore {
  current ??= createMemoryOutputStore();
  return current;
}

/** Install a store; `null` drops it so the next use creates a fresh default ring. */
export function setGalaxyOutputStore(store: GalaxyOutputStore | null): void {
  current = store;
}
