/**
 * Phase 2.3 embed-token lifecycle: mint-on-bind, refresh-before-expiry,
 * retry-on-failure, cancel-on-unbind, and stale-result rejection on a
 * page switch. Timing is driven by vitest fake timers (which also fake the
 * clock `refreshDelayMs` reads).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbedTokenManager,
  type EmbedTokenUpdate,
} from "../extensions/loom/embed-token-manager";
import type { GalaxyEmbedToken } from "../extensions/loom/galaxy-pages-api";

const TTL_MS = 15 * 60_000; // matches Galaxy's embed-token TTL
const SKEW_MS = 60_000; // DEFAULT_REFRESH_SKEW_MS
const REFRESH_MS = TTL_MS - SKEW_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-20T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Mint stub: token`N`, expiry = mint-time + TTL (reads the fake clock). */
function sequentialMint() {
  let n = 0;
  return vi.fn(async (): Promise<GalaxyEmbedToken> => {
    n += 1;
    return { token: `t${n}`, expires_at: new Date(Date.now() + TTL_MS).toISOString() };
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued microtasks (a resolved mint) settle under fake timers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("embed token manager", () => {
  it("mints on bind and pushes the token to the sink", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const mint = sequentialMint();
    const mgr = createEmbedTokenManager({ sink, mint });

    mgr.setPage("page-1");
    await flush();

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith("page-1", expect.any(AbortSignal));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ pageId: "page-1", token: "t1" });
    expect(mgr.current()).toMatchObject({ pageId: "page-1", token: "t1" });
  });

  it("refreshes just before expiry and re-pushes the new token", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const mgr = createEmbedTokenManager({ sink, mint: sequentialMint() });

    mgr.setPage("page-1");
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);

    // Nothing fires before the refresh point...
    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(sink).toHaveBeenCalledTimes(1);

    // ...then the refresh mints + pushes again.
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0]).toMatchObject({ token: "t2" });
    expect(mgr.current()).toMatchObject({ token: "t2" });
  });

  it("is a no-op when re-pointed at the same page (no token churn)", async () => {
    const mint = sequentialMint();
    const mgr = createEmbedTokenManager({ sink: vi.fn(), mint });

    mgr.setPage("page-1");
    await flush();
    mgr.setPage("page-1");
    await flush();

    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("cancels the refresh when unbound", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const mgr = createEmbedTokenManager({ sink, mint: sequentialMint() });

    mgr.setPage("page-1");
    await flush();
    mgr.setPage(null);

    expect(mgr.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(TTL_MS * 2);
    expect(sink).toHaveBeenCalledTimes(1); // no refresh fired after unbind
  });

  it("switches pages: mints the new one and abandons the old refresh", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const mint = sequentialMint();
    const mgr = createEmbedTokenManager({ sink, mint });

    mgr.setPage("page-a");
    await flush();
    mgr.setPage("page-b");
    await flush();

    expect(mint.mock.calls.map((c) => c[0])).toEqual(["page-a", "page-b"]);
    expect(mgr.current()).toMatchObject({ pageId: "page-b", token: "t2" });

    // The old page's refresh must never fire.
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 1);
    const pages = sink.mock.calls.map((c) => c[0].pageId);
    expect(pages).not.toContain("page-a-refresh-marker");
    expect(sink.mock.calls.filter((c) => c[0].pageId === "page-a")).toHaveLength(1);
  });

  it("ignores a stale in-flight mint after a page switch", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const slow = deferred<GalaxyEmbedToken>();
    let call = 0;
    const mint = vi.fn(async (): Promise<GalaxyEmbedToken> => {
      call += 1;
      if (call === 1) return slow.promise; // page-a: hangs
      return { token: "t-b", expires_at: new Date(Date.now() + TTL_MS).toISOString() };
    });

    const mgr = createEmbedTokenManager({ sink, mint });
    mgr.setPage("page-a"); // in-flight, unresolved
    mgr.setPage("page-b");
    await flush();

    // page-a's mint finally resolves — but it's stale and must be dropped.
    slow.resolve({ token: "t-a", expires_at: new Date(Date.now() + TTL_MS).toISOString() });
    await flush();

    const tokens = sink.mock.calls.map((c) => c[0].token);
    expect(tokens).toContain("t-b");
    expect(tokens).not.toContain("t-a");
    expect(mgr.current()).toMatchObject({ pageId: "page-b", token: "t-b" });
  });

  it("retries after a failed mint, then succeeds", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const onError = vi.fn();
    let call = 0;
    const mint = vi.fn(async (): Promise<GalaxyEmbedToken> => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return { token: "t1", expires_at: new Date(Date.now() + TTL_MS).toISOString() };
    });

    const mgr = createEmbedTokenManager({ sink, mint, retryDelayMs: 30_000, onError });

    mgr.setPage("page-1");
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ token: "t1" });
  });

  it("dispose cancels timers and clears state", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    const mgr = createEmbedTokenManager({ sink, mint: sequentialMint() });

    mgr.setPage("page-1");
    await flush();
    mgr.dispose();

    expect(mgr.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(TTL_MS * 2);
    expect(sink).toHaveBeenCalledTimes(1); // no refresh after dispose
  });

  it("floors the refresh delay so an already-expired token can't hot-loop", async () => {
    const sink = vi.fn<(u: EmbedTokenUpdate) => void>();
    let call = 0;
    const mint = vi.fn(async (): Promise<GalaxyEmbedToken> => {
      call += 1;
      // First token is already expired; second is healthy.
      const ttl = call === 1 ? -TTL_MS : TTL_MS;
      return { token: `t${call}`, expires_at: new Date(Date.now() + ttl).toISOString() };
    });

    const mgr = createEmbedTokenManager({ sink, mint });
    mgr.setPage("page-1");
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);

    // Refresh is floored to ~1s rather than firing immediately in a tight loop.
    await vi.advanceTimersByTimeAsync(999);
    expect(sink).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0]).toMatchObject({ token: "t2" });
  });
});
