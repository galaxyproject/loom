import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// context.ts reads identity facts from loadConfig(); control it so the block is
// deterministic regardless of the dev machine's real ~/.loom/config.json.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { buildTesterIdBlock, setupContextInjection } from "../extensions/loom/context";

describe("buildTesterIdBlock", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    savedEnv = process.env.LOOM_TESTER_ID;
    delete process.env.LOOM_TESTER_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOOM_TESTER_ID;
    else process.env.LOOM_TESTER_ID = savedEnv;
  });

  it("surfaces the configured tester ID and de-routes it away from Galaxy", () => {
    loadConfigMock.mockReturnValue({ testerId: "orbit-007" });

    const block = buildTesterIdBlock();

    expect(block).toContain("## Orbit tester ID");
    expect(block).toContain("orbit-007");
    // The bug was routing this to mcp__galaxy__get_user -- the prompt must say not to.
    expect(block).toContain("mcp__galaxy__get_user");
  });

  it("falls back to LOOM_TESTER_ID when config has none", () => {
    loadConfigMock.mockReturnValue({});
    process.env.LOOM_TESTER_ID = "orbit-042";

    expect(buildTesterIdBlock()).toContain("orbit-042");
  });

  it("injects nothing when no tester ID is configured", () => {
    loadConfigMock.mockReturnValue({});

    expect(buildTesterIdBlock()).toBe("");
  });

  it("reads only testerId -- never leaks other config values (#183)", () => {
    loadConfigMock.mockReturnValue({
      testerId: "orbit-007",
      llm: {
        active: "anthropic",
        providers: { anthropic: { apiKey: "sk-SECRET-should-never-appear", model: "claude" } },
      },
    });

    const block = buildTesterIdBlock();

    expect(block).toContain("orbit-007");
    expect(block).not.toContain("sk-SECRET-should-never-appear");
    // Don't nudge the agent to cat the file (the #183 leak vector).
    expect(block).not.toContain("config.json");
  });

  it("is wired into the assembled prompt, after the Active LLM block", async () => {
    loadConfigMock.mockReturnValue({
      testerId: "orbit-007",
      llm: { active: "anthropic", providers: { anthropic: { model: "claude-opus-4-8" } } },
    });

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    };

    setupContextInjection(pi as any);
    const result = (await handlers.get("before_agent_start")!({}, {})) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("## Orbit tester ID");
    expect(result.systemPrompt).toContain("orbit-007");
    expect(result.systemPrompt.indexOf("## Active LLM")).toBeLessThan(
      result.systemPrompt.indexOf("## Orbit tester ID"),
    );
  });
});
