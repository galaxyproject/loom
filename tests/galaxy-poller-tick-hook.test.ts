/**
 * The seam the live Galaxy panel hangs off: one hook on the existing poller
 * tick, rather than a second timer with its own cadence to keep in step and
 * its own lifetime to remember to end.
 *
 * No notebook path is set, so the tick reads nothing and does none of its own
 * work -- which is the point here. What is under test is the seam, not the
 * poller.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetState } from "../extensions/loom/state.js";
import {
  getPollTickHook,
  pollGalaxyNow,
  setPollTickHook,
  stopGalaxyPoller,
} from "../extensions/loom/galaxy-poller.js";

describe("the poll tick hook", () => {
  afterEach(() => {
    setPollTickHook(null);
    stopGalaxyPoller();
    resetState();
  });

  it("runs on every tick, and is handed the notebook the tick read", async () => {
    resetState();
    const seen: (string | null)[] = [];
    setPollTickHook(async (content) => {
      seen.push(content);
    });
    await pollGalaxyNow();
    await pollGalaxyNow();
    expect(seen).toEqual([null, null]);
  });

  it("does not make the poller's own work wait behind it", async () => {
    // A hook talking to a Galaxy that has stopped answering must not delay the
    // thing this timer actually exists for: advancing in-flight invocations and
    // jobs. Raced against a timer rather than simply awaited, so putting an
    // `await` back in front of the hook fails this in a quarter of a second
    // instead of hanging the file until CI gives up on it.
    resetState();
    let entered = false;
    let release: (() => void) | undefined;
    setPollTickHook(
      () =>
        new Promise<void>((resolve) => {
          entered = true;
          release = resolve;
        }),
    );
    try {
      const winner = await Promise.race([
        pollGalaxyNow().then(() => "tick finished" as const),
        new Promise<"tick is still waiting on the hook">((r) =>
          setTimeout(() => r("tick is still waiting on the hook"), 250),
        ),
      ]);
      expect(winner).toBe("tick finished");
      expect(entered).toBe(true);
    } finally {
      // Let the hook settle even when the assertion above failed: the poller
      // holds one in-flight tick at a time, so a hook left hanging would take
      // every test after this one down with it and turn a clear failure into a
      // stalled file.
      release?.();
    }
  });

  it("swallows a hook that rejects, and a hook that throws before it returns", async () => {
    resetState();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setPollTickHook(async () => {
      throw new Error("rejected");
    });
    await expect(pollGalaxyNow()).resolves.toBeUndefined();
    setPollTickHook(() => {
      throw new Error("threw synchronously");
    });
    await expect(pollGalaxyNow()).resolves.toBeUndefined();
    // Let the rejection handler run before the spy is restored.
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clears back to nothing, so shutdown really does stop it", async () => {
    resetState();
    const hook = vi.fn(async () => {});
    setPollTickHook(hook);
    await pollGalaxyNow();
    setPollTickHook(null);
    expect(getPollTickHook()).toBeNull();
    await pollGalaxyNow();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
