/**
 * Auto-push lifecycle: debounce a burst into one push, dedup on the stripped
 * body (the feedback-loop break — a self-push changes only the binding block, so
 * the body is unchanged and must not re-push), coalesce a change that lands
 * mid-push, prime-without-push, cancel, and retry-after-failure.
 *
 * Content is modeled as "<body>|<binding>"; stripBody drops the binding so a
 * binding-only change (the self-push) collapses to the same dedup key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoPushManager } from "../extensions/loom/auto-push-manager";

const DEBOUNCE = 2_000;
const stripBody = (c: string) => c.split("|")[0];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function make(push: () => Promise<unknown>, onError?: (e: unknown) => void) {
  return createAutoPushManager({ push, stripBody, debounceMs: DEBOUNCE, onError });
}

describe("auto-push manager", () => {
  it("debounces a burst of writes into a single push", async () => {
    const push = vi.fn(async () => {});
    const mgr = make(push);

    mgr.notebookChanged("a|0");
    await tick(500);
    mgr.notebookChanged("b|0");
    await tick(500);
    mgr.notebookChanged("c|0");
    await tick(DEBOUNCE);

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push when the body is unchanged from the baseline", async () => {
    const push = vi.fn(async () => {});
    const mgr = make(push);

    mgr.prime("a|0");
    mgr.notebookChanged("a|0");
    await tick(DEBOUNCE);

    expect(push).not.toHaveBeenCalled();
  });

  it("does not re-push on the push's own self-write (binding-only change)", async () => {
    const push = vi.fn(async () => {});
    const mgr = make(push);

    mgr.prime("a|0");
    mgr.notebookChanged("b|0"); // genuine edit
    await tick(DEBOUNCE);
    expect(push).toHaveBeenCalledTimes(1);

    // The push re-wrote notebook.md, bumping only the binding (|0 -> |1). Same
    // body "b" -> must not loop.
    mgr.notebookChanged("b|1");
    await tick(DEBOUNCE);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("coalesces a change that lands while a push is in flight", async () => {
    const d1 = deferred();
    const push = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValue(undefined);
    const mgr = make(push);

    mgr.prime("a|0");
    mgr.notebookChanged("b|0");
    await tick(DEBOUNCE); // push #1 starts, now in flight
    expect(push).toHaveBeenCalledTimes(1);

    mgr.notebookChanged("c|0"); // lands mid-push -> remembered
    d1.resolve(undefined);
    await flush(); // push #1 settles, schedules the trailing push
    await tick(DEBOUNCE);

    expect(push).toHaveBeenCalledTimes(2);
  });

  it("retries on the next change after a failed push (baseline unchanged)", async () => {
    const onError = vi.fn();
    const push = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const mgr = make(push, onError);

    mgr.prime("a|0");
    mgr.notebookChanged("b|0");
    await tick(DEBOUNCE);
    expect(push).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Baseline stayed "a", so the same body is still "dirty" and a later change retries.
    mgr.notebookChanged("b|0");
    await tick(DEBOUNCE);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("prime adopts the baseline without pushing and cancels a pending push", async () => {
    const push = vi.fn(async () => {});
    const mgr = make(push);

    mgr.notebookChanged("b|0"); // schedule a push
    await tick(500); // still within debounce
    mgr.prime("b|0"); // re-baseline; cancels the pending push
    await tick(DEBOUNCE);

    expect(push).not.toHaveBeenCalled();
  });

  it("cancel() stops a pending push", async () => {
    const push = vi.fn(async () => {});
    const mgr = make(push);

    mgr.notebookChanged("b|0");
    await tick(500);
    mgr.cancel();
    await tick(DEBOUNCE);

    expect(push).not.toHaveBeenCalled();
  });
});
