/**
 * Embed URL + embed-token timing helpers for the Galaxy notebook iframe.
 *
 * Phase 2 of the "render Galaxy notebooks server-side in Orbit" plan: the brain
 * owns the embed contract so shells stay thin. This module is pure (no I/O):
 *
 *   - `getEmbedUrl` builds the absolute, frame-embeddable Galaxy URL for a bound
 *     page. Galaxy's `PageDetails.embed_url` is *path-relative* (it honors a
 *     deployment prefix but carries no host), so the brain — which holds the
 *     `galaxy_server_url` in the binding — constructs the absolute URL itself.
 *   - `buildNotebookEmbed` projects a binding into the shell-neutral
 *     `NotebookEmbedPayload` carried over the shell contract.
 *   - `shouldRefreshToken` / `refreshDelayMs` are the embed-token refresh-timing
 *     math, kept separate from the network mint (`mintEmbedToken`) so they unit
 *     test without a clock or a server.
 */

import type { GalaxyPageBindingYaml } from "./galaxy-page-binding";
import type { NotebookEmbedPayload } from "../../shared/loom-shell-contract.js";

// ─────────────────────────────────────────────────────────────────────────────
// Embed URL
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedUrlOptions {
  /**
   * Cache-buster appended as `&rev=`. Pass the binding's
   * `lastSyncedRevision` so a fresh push reloads the iframe instead of
   * serving the stale server render.
   */
  rev?: string | null;
  /**
   * Embedder origin, forwarded as `&embed_origin=` so PageView's postMessage
   * bridge target-origin-restricts its messages (see embedBridge.ts).
   */
  embedOrigin?: string | null;
}

/**
 * Build the absolute chrome-free embed URL for a bound page:
 * `{galaxy_server_url}/published/page?id={pageId}&embed=true[&rev=…][&embed_origin=…]`.
 *
 * The page id is already a Galaxy-encoded id; `encodeURIComponent` is a
 * defensive no-op on the hex form and matches the rest of the Pages client.
 */
export function getEmbedUrl(binding: GalaxyPageBindingYaml, opts: EmbedUrlOptions = {}): string {
  const base = binding.galaxyServerUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    id: binding.pageId,
    embed: "true",
  });
  if (opts.rev) params.set("rev", opts.rev);
  if (opts.embedOrigin) params.set("embed_origin", opts.embedOrigin);
  return `${base}/published/page?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell-contract payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project a binding (or its absence) into the `NotebookEmbed` payload the brain
 * emits to shells. `null` binding → the unbound payload (every field null,
 * `bound: false`) so a shell can render the "run /sync push to view in Galaxy"
 * fallback without special-casing a missing widget.
 *
 * The embed *token* is deliberately NOT in this payload — it goes to the shell's
 * privileged process (Orbit main) over a separate channel and never reaches the
 * renderer (see plan §3.3).
 */
export function buildNotebookEmbed(
  binding: GalaxyPageBindingYaml | null,
  opts: EmbedUrlOptions = {},
): NotebookEmbedPayload {
  if (!binding) {
    return {
      bound: false,
      pageId: null,
      historyId: null,
      galaxyUrl: null,
      embedUrl: null,
      lastSyncedRevision: null,
    };
  }
  return {
    bound: true,
    pageId: binding.pageId,
    historyId: binding.historyId,
    galaxyUrl: binding.galaxyServerUrl.replace(/\/+$/, ""),
    embedUrl: getEmbedUrl(binding, { rev: binding.lastSyncedRevision, ...opts }),
    lastSyncedRevision: binding.lastSyncedRevision,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Embed-token refresh timing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default safety margin before a token's stated expiry at which the brain
 * should mint a replacement. The Galaxy token TTL is ~15 min, so refreshing a
 * minute early comfortably covers clock skew + the round-trip.
 */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Whether a token whose stated expiry is `expiresAt` (ISO 8601 UTC, as returned
 * by `POST /api/pages/{id}/embed_token`) should be refreshed at `nowMs`. True
 * once we are within `skewMs` of expiry — or if `expiresAt` is unparseable, in
 * which case we treat the token as suspect and refresh.
 */
export function shouldRefreshToken(
  expiresAt: string,
  nowMs: number,
  skewMs: number = DEFAULT_REFRESH_SKEW_MS,
): boolean {
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) return true;
  return nowMs >= expiryMs - skewMs;
}

/**
 * Milliseconds to wait before refreshing — `expiry - skew - now`, floored at 0.
 * An already-past (or unparseable) expiry returns 0 so the caller refreshes
 * immediately. Use to schedule the refresh timer.
 */
export function refreshDelayMs(
  expiresAt: string,
  nowMs: number,
  skewMs: number = DEFAULT_REFRESH_SKEW_MS,
): number {
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) return 0;
  return Math.max(0, expiryMs - skewMs - nowMs);
}
