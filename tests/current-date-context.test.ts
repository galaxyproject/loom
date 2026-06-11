import { describe, expect, it, vi } from "vitest";

// context.ts reads config in several blocks; stub it so the assembled-prompt
// test is deterministic regardless of the dev machine's ~/.loom/config.json.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { buildCurrentDateBlock, setupContextInjection } from "../extensions/loom/context";

describe("buildCurrentDateBlock", () => {
  it("stamps the host date from the injected clock, not a model-supplied string", () => {
    // Constructed from LOCAL components at noon so the calendar date is the same
    // in every runner timezone (no midnight/DST edge) -- the block must report
    // 2026-06-09 deterministically.
    const fixedClock = new Date(2026, 5, 9, 12, 0, 0);

    const block = buildCurrentDateBlock(fixedClock);

    expect(block).toContain("## Current date");
    expect(block).toContain("2026-06-09");
    // The bug (#268) was the model inventing a date -- the block must tell it not to.
    expect(block.toLowerCase()).toContain("never");
    // Name the field that regressed so the guidance is unambiguous.
    expect(block).toContain("Analysis date");
  });

  it("tracks the injected clock rather than a hard-coded constant", () => {
    const a = buildCurrentDateBlock(new Date(2026, 0, 1, 12, 0, 0));
    const b = buildCurrentDateBlock(new Date(2030, 11, 31, 12, 0, 0));

    expect(a).toContain("2026-01-01");
    expect(b).toContain("2030-12-31");
    expect(a).not.toEqual(b);
  });

  it("is wired into the assembled system prompt using the live host clock", async () => {
    loadConfigMock.mockReturnValue({});
    // Pin the host clock so the default new Date() path inside the assembled
    // prompt must report this exact local date -- proves the date is
    // host-derived, not a leftover constant or a model-supplied string.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 2, 5, 12, 0, 0));
    try {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      const pi = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
          handlers.set(event, handler);
        },
      };

      setupContextInjection(pi as any);
      const result = (await handlers.get("before_agent_start")!({}, {})) as {
        systemPrompt: string;
      };

      expect(result.systemPrompt).toContain("## Current date");
      expect(result.systemPrompt).toContain("2027-03-05");
    } finally {
      vi.useRealTimers();
    }
  });
});
