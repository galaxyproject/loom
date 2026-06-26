/**
 * Embed-token lifecycle for the currently-bound Galaxy page.
 *
 * The brain holds the API key; the privileged shell process (Orbit main) needs
 * a short-lived, page-scoped embed token to inject into the iframe partition's
 * request headers — never the API key (LOOM plan §6: an exfiltrated key is total
 * account compromise, an exfiltrated embed token is one page, read-only, for
 * minutes). This manager keeps a fresh token for the active page and pushes each
 * (re)mint to a `sink` that delivers it out of band to that process. The
 * renderer never sees it.
 *
 * Transport is injected. *How* the token reaches main is the shell's concern,
 * wired in Phase 3; this module owns only the *timing* — mint-on-bind,
 * refresh-before-expiry, retry-on-failure, and cancel-on-unbind — reusing the
 * pure timing math in galaxy-embed.ts (`refreshDelayMs`).
 */

import { mintEmbedToken, type GalaxyEmbedToken } from "./galaxy-pages-api";
import { refreshDelayMs } from "./galaxy-embed";

export interface EmbedTokenUpdate {
  pageId: string;
  token: string;
  expiresAt: string;
}

/** Out-of-band delivery of the current token to the privileged shell process. */
export type EmbedTokenSink = (update: EmbedTokenUpdate) => void;

export interface EmbedTokenManagerOptions {
  sink: EmbedTokenSink;
  /** Mint call; defaults to the real Pages API client. Injected for tests. */
  mint?: (pageId: string, signal?: AbortSignal) => Promise<GalaxyEmbedToken>;
  /** Delay before retrying after a failed mint. Default 30s. */
  retryDelayMs?: number;
  /** Surfaced on a failed mint (default: console.error). */
  onError?: (err: unknown) => void;
}

export interface EmbedTokenManager {
  /** Manage `pageId` (null to unbind). Mints immediately when the page changes;
   *  a no-op when already managing that page, so unrelated notebook writes don't
   *  churn tokens. */
  setPage(pageId: string | null): void;
  /** The current token for the active page, or null. Lets a late subscriber
   *  (e.g. main connecting after the first mint) read the live value. */
  current(): EmbedTokenUpdate | null;
  /** Cancel the refresh timer + abort any in-flight mint. Idempotent. */
  dispose(): void;
}

const DEFAULT_RETRY_DELAY_MS = 30_000;
// Floor so a clock-skewed already-expired token can't spin a hot refresh loop.
const MIN_REFRESH_DELAY_MS = 1_000;

export function createEmbedTokenManager(opts: EmbedTokenManagerOptions): EmbedTokenManager {
  const mint = opts.mint ?? mintEmbedToken;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const onError =
    opts.onError ?? ((err: unknown) => console.error("embed token mint failed:", err));

  let activePageId: string | null = null;
  let token: EmbedTokenUpdate | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abortInFlight(): void {
    if (abort) {
      abort.abort();
      abort = null;
    }
  }

  function schedule(delayMs: number, pageId: string): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void doMint(pageId);
    }, delayMs);
  }

  async function doMint(pageId: string): Promise<void> {
    abortInFlight();
    const controller = new AbortController();
    abort = controller;

    let result: GalaxyEmbedToken;
    try {
      result = await mint(pageId, controller.signal);
    } catch (err) {
      // Ignore the failure if we've since switched pages or been disposed.
      if (controller.signal.aborted || activePageId !== pageId) return;
      onError(err);
      schedule(retryDelayMs, pageId);
      return;
    }

    // A page switch / dispose during the await makes this result stale.
    if (controller.signal.aborted || activePageId !== pageId) return;
    abort = null;
    token = { pageId, token: result.token, expiresAt: result.expires_at };
    opts.sink(token);
    const delay = Math.max(MIN_REFRESH_DELAY_MS, refreshDelayMs(result.expires_at, Date.now()));
    schedule(delay, pageId);
  }

  return {
    setPage(pageId: string | null): void {
      if (pageId === activePageId) return;
      clearTimer();
      abortInFlight();
      token = null;
      activePageId = pageId;
      if (pageId !== null) void doMint(pageId);
    },
    current: () => token,
    dispose(): void {
      clearTimer();
      abortInFlight();
      activePageId = null;
      token = null;
    },
  };
}
