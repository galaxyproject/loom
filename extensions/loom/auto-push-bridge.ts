/**
 * Auto-push bridge — drives the auto-push lifecycle from notebook + connection
 * state. When opted in (experiments.autoPush), a genuine edit to a bound +
 * connected notebook is pushed to its Galaxy page on a debounce, so the embedded
 * Galaxy view tracks local edits without a manual `/sync push`.
 *
 * Reacts to the same `onNotebookChange` stream as ui-bridge / embed-token-bridge.
 * Gating (bound AND connected) is decided here per change; the opt-in flag is
 * checked once at boot (index.ts only registers this when enabled). The manager
 * owns debounce + the feedback-loop suppression.
 *
 * Bind/resume is a `prime` (adopt the baseline, no push) rather than a push, so
 * an Orbit restart of an already-synced notebook doesn't spam a spurious
 * revision. A genuine subsequent edit is the only thing that pushes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onNotebookChange, isGalaxyEffectivelyConnected, readCurrentNotebook } from "./state.js";
import { findGalaxyPageBlocks } from "./galaxy-page-binding.js";
import { loadConfig } from "./config.js";
import { createAutoPushManager, type AutoPushManagerOptions } from "./auto-push-manager.js";

/**
 * Whether notebook → Galaxy auto-push is opted in. Resolution order (env wins so
 * a developer can flip it for one session without touching ~/.loom/config.json):
 *   1. LOOM_AUTO_PUSH — "1" → on, "0" → off, anything else → defer to config.
 *   2. config.experiments.autoPush — boolean.
 *   3. Default: off (auto-push is local-wins and clobbers server edits).
 * Called once at extension boot, not in a hot path — each call hits disk.
 */
export function isAutoPushEnabled(): boolean {
  const env = process.env.LOOM_AUTO_PUSH;
  if (env === "1") return true;
  if (env === "0") return false;
  return loadConfig().experiments?.autoPush === true;
}

export interface AutoPushBridgeOptions {
  /** Push override forwarded to the manager (injected for tests). */
  push?: AutoPushManagerOptions["push"];
  /** Debounce override forwarded to the manager (injected for tests). */
  debounceMs?: AutoPushManagerOptions["debounceMs"];
}

export function setupAutoPushBridge(pi: ExtensionAPI, opts: AutoPushBridgeOptions = {}): void {
  const manager = createAutoPushManager({ push: opts.push, debounceMs: opts.debounceMs });

  // Tracks the page the manager is primed against. undefined = never observed;
  // a change to a different (or first) pageId is a (re)bind → prime, not a push.
  let lastPageId: string | null | undefined = undefined;

  function evaluate(content: string, isSessionStart: boolean): void {
    const binding = findGalaxyPageBlocks(content)[0] ?? null;
    const pageId = binding?.pageId ?? null;
    // Auto-push only while bound AND connected — the push needs the API key + a
    // live server, and an unbound push would throw.
    const active = pageId !== null && isGalaxyEffectivelyConnected();
    if (!active) {
      manager.cancel();
      lastPageId = pageId;
      return;
    }
    const rebound = pageId !== lastPageId;
    lastPageId = pageId;
    // Bind / resume / re-bind adopts the current body as the baseline without
    // pushing; only a genuine edit on an already-primed page pushes.
    if (isSessionStart || rebound) manager.prime(content);
    else manager.notebookChanged(content);
  }

  // Resume: an already-bound notebook (`--continue`) must adopt its baseline
  // without waiting for a change, so the first real edit pushes but the resume
  // itself doesn't. `initSessionArtifacts` also replays via onNotebookChange on
  // session_start; whichever fires first primes and the other is a no-op (prime
  // is idempotent; a same-page change re-primes to the same body → no push).
  pi.on("session_start", async () => {
    const content = readCurrentNotebook();
    if (content !== null) evaluate(content, true);
  });

  onNotebookChange((content) => evaluate(content, false));
}
