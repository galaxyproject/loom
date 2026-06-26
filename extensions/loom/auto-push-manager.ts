/**
 * Auto-push lifecycle for the currently-bound Galaxy page.
 *
 * When opted in (experiments.autoPush), the bound notebook is pushed to its
 * Galaxy page on every content change so the embedded Galaxy view tracks local
 * edits without a manual `/sync push`. This module owns only the *timing* —
 * debounce a burst of writes into one push, coalesce a change that lands while
 * a push is in flight, and (the load-bearing part) suppress the feedback loop.
 *
 * Feedback loop: a successful push re-writes notebook.md itself (it bumps
 * `last_synced_revision` in the `loom-galaxy-page` block), which re-fires the
 * file watcher → another change → another push → a new revision every cycle.
 * The break is to dedup on the notebook *body* with the housekeeping blocks
 * stripped: a self-push changes only the binding block, so the stripped body is
 * unchanged → no re-push. The same dedup also skips prose-identical re-emits.
 *
 * Gating (bound AND connected AND opted-in) lives in the bridge; this manager is
 * told to `prime` (set the baseline, no push) on bind/resume and `notebookChanged`
 * (debounced push) on a genuine edit. `push` is injected for tests.
 */

import { pushNotebookToGalaxy } from "./galaxy-pages-sync.js";
import { stripHousekeepingBlocks } from "./ui-bridge.js";

export interface AutoPushManagerOptions {
  /** Push call; defaults to the real local-wins push. Injected for tests. */
  push?: () => Promise<unknown>;
  /** Project notebook content to its dedup key (housekeeping blocks removed). */
  stripBody?: (content: string) => string;
  /** Trailing-debounce window coalescing a burst of writes. Default 2s. */
  debounceMs?: number;
  /** Surfaced on a failed push (default: console.error). A failed push leaves
   *  the baseline unchanged, so the next change retries. */
  onError?: (err: unknown) => void;
  /** Test hook fired after a push settles (resolved or rejected). */
  onSettled?: () => void;
}

export interface AutoPushManager {
  /** Adopt `content` as the baseline without pushing — on bind/resume, so an
   *  unchanged inherited notebook doesn't trigger a spurious push. Cancels any
   *  pending push. */
  prime(content: string): void;
  /** A genuine notebook write: schedule a debounced push unless the body is
   *  unchanged from the last pushed/primed baseline. */
  notebookChanged(content: string): void;
  /** Cancel a pending push (e.g. on disconnect/unbind); keeps the baseline. */
  cancel(): void;
  /** Cancel a pending push. Idempotent. */
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 2_000;

export function createAutoPushManager(opts: AutoPushManagerOptions = {}): AutoPushManager {
  const push = opts.push ?? (() => pushNotebookToGalaxy());
  const stripBody = opts.stripBody ?? stripHousekeepingBlocks;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onError =
    opts.onError ?? ((err: unknown) => console.error("notebook auto-push failed:", err));

  // Dedup key of the last successfully pushed (or primed) body. null = nothing
  // adopted yet, so the first observed change is treated as a real edit.
  let baseline: string | null = null;
  let latest = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pushing = false;
  // A change arrived while a push was in flight — re-evaluate when it settles.
  let rerun = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  async function run(): Promise<void> {
    // Don't run two pushes at once; remember to re-check when this one settles.
    if (pushing) {
      rerun = true;
      return;
    }
    const body = stripBody(latest);
    // Settled back to the baseline while debouncing (e.g. the in-flight push's
    // own self-write already landed) — nothing to do.
    if (body === baseline) return;

    pushing = true;
    try {
      await push();
      // Adopt the body we just pushed. `latest` may have advanced during the
      // await; the rerun check below re-evaluates against it.
      baseline = body;
    } catch (err) {
      onError(err);
    } finally {
      pushing = false;
      opts.onSettled?.();
      if (rerun) {
        rerun = false;
        if (stripBody(latest) !== baseline) schedule();
      }
    }
  }

  return {
    prime(content: string): void {
      clearTimer();
      latest = content;
      baseline = stripBody(content);
    },
    notebookChanged(content: string): void {
      latest = content;
      if (stripBody(content) === baseline) return;
      if (pushing) {
        rerun = true;
        return;
      }
      schedule();
    },
    cancel(): void {
      clearTimer();
    },
    dispose(): void {
      clearTimer();
    },
  };
}
