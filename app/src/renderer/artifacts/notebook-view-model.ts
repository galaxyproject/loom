/**
 * Pure view-model for the notebook pane's Markdown ↔ Galaxy toggle.
 *
 * The notebook tab shows either the local markdown render (fast, offline, always
 * available) or the server-side Galaxy page in a locked-down webview (full
 * fidelity). Which one — and, in Galaxy mode, whether to show the live embed or a
 * fallback — is decided here so the DOM wiring in artifact-panel.ts stays a thin
 * consumer and the logic is unit-testable without a renderer.
 */

import type { NotebookEmbedPayload } from "../../../../shared/loom-shell-contract.js";

export type NotebookViewMode = "markdown" | "galaxy";

/** localStorage key (mirrors `orbit.artifactCollapsed`). */
export const NOTEBOOK_VIEW_MODE_KEY = "orbit.notebookViewMode";

/** Parse a persisted mode; anything but the explicit "galaxy" defaults to
 *  Markdown (the always-available view). */
export function parseStoredViewMode(raw: string | null): NotebookViewMode {
  return raw === "galaxy" ? "galaxy" : "markdown";
}

export interface NotebookEmbedState {
  /** Latest NotebookEmbed widget payload, or null before one arrives. */
  payload: NotebookEmbedPayload | null;
  /** Whether Galaxy is currently connected. */
  connected: boolean;
}

/** Whether the Galaxy view can actually render right now (connected + bound +
 *  has an embed URL). */
export function canUseGalaxyView(state: NotebookEmbedState): boolean {
  return Boolean(state.connected && state.payload?.bound && state.payload?.embedUrl);
}

export type NotebookView =
  | { kind: "markdown" }
  | { kind: "galaxy"; embedUrl: string }
  | { kind: "fallback"; reason: "disconnected" | "unbound" };

/**
 * Resolve what the notebook tab should show. Markdown mode is unconditional.
 * Galaxy mode degrades to a guiding fallback when not connected (→ connect) or
 * not bound (→ run `/sync push`), so selecting Galaxy is always safe.
 */
export function resolveNotebookView(
  mode: NotebookViewMode,
  state: NotebookEmbedState,
): NotebookView {
  if (mode === "markdown") return { kind: "markdown" };
  if (!state.connected) return { kind: "fallback", reason: "disconnected" };
  if (!state.payload?.bound || !state.payload.embedUrl) {
    return { kind: "fallback", reason: "unbound" };
  }
  return { kind: "galaxy", embedUrl: state.payload.embedUrl };
}

/**
 * Whether a new embed payload should reload the Galaxy view. The embed URL bakes
 * in `&rev=<lastSyncedRevision>` (see brain `buildNotebookEmbed`), so a `/sync
 * push` that advances the revision changes the URL — reloading the webview to the
 * fresh server render. True only when the URL actually changed to a non-null
 * value; a no-op re-emit (same URL) must not thrash the view. This is the contract
 * artifact-panel implements via its webview `src` swap.
 */
export function shouldReloadEmbed(
  prev: NotebookEmbedPayload | null,
  next: NotebookEmbedPayload | null,
): boolean {
  const nextUrl = next?.embedUrl ?? null;
  return nextUrl !== null && nextUrl !== (prev?.embedUrl ?? null);
}
