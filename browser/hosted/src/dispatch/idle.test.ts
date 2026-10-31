import { describe, expect, it } from "vitest";

import { idleAction, idleCheckMs, type IdleState } from "./idle";

const SETTINGS = { releaseMs: 60_000, askPauseMs: 600_000 };
const QUIET: IdleState = { busy: false, oldestAskAt: undefined, watched: false, quietSince: 0 };

describe("idleAction", () => {
  it("releases a quiet, unwatched worker once the quiet period has passed, and not before", () => {
    expect(idleAction(QUIET, 59_999, SETTINGS)).toBeUndefined();
    expect(idleAction(QUIET, 60_000, SETTINGS)).toBe("release");
  });

  it("never releases a worker with a turn running or a page open, however long it has been", () => {
    expect(idleAction({ ...QUIET, busy: true }, 10 * 60_000, SETTINGS)).toBeUndefined();
    expect(idleAction({ ...QUIET, watched: true }, 10 * 60_000, SETTINGS)).toBeUndefined();
  });

  it("holds a pending confirm for the pause time, then pauses, watched or not", () => {
    const asking = { ...QUIET, busy: true, oldestAskAt: 1_000 };
    // Past the quiet period, but an ask is never an idle release.
    expect(idleAction(asking, 300_000, SETTINGS)).toBeUndefined();
    expect(idleAction(asking, 600_999, SETTINGS)).toBeUndefined();
    expect(idleAction(asking, 601_000, SETTINGS)).toBe("pause");
    expect(idleAction({ ...asking, watched: true }, 601_000, SETTINGS)).toBe("pause");
  });
});

describe("idleCheckMs", () => {
  it("looks a few times per limit, between 4 Hz and every 15 s", () => {
    expect(idleCheckMs(SETTINGS)).toBe(15_000);
    expect(idleCheckMs({ releaseMs: 8_000, askPauseMs: 600_000 })).toBe(2_000);
    expect(idleCheckMs({ releaseMs: 100, askPauseMs: 100 })).toBe(250);
  });
});
