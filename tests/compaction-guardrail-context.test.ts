import { describe, expect, it } from "vitest";
import { setupContextInjection } from "../extensions/loom/context";

/**
 * Issue #171: the agent over-claims it compacted the conversation when asked
 * in chat, but compaction is a harness operation it cannot perform itself.
 * The system prompt must tell the agent it cannot compact its own context,
 * must not claim it did, and must route the user to the real mechanism.
 */
function assembleSystemPrompt(): Promise<{ systemPrompt: string }> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(event, handler);
    },
  };
  setupContextInjection(pi as any);
  return handlers.get("before_agent_start")!({}, {}) as Promise<{ systemPrompt: string }>;
}

describe("compaction guardrail", () => {
  it("tells the agent it cannot compact its own context", async () => {
    const { systemPrompt } = await assembleSystemPrompt();
    expect(systemPrompt).toContain("compact your own context");
  });

  it("forbids claiming the context window was compacted", async () => {
    const { systemPrompt } = await assembleSystemPrompt();
    expect(systemPrompt).toContain("must not claim the context window was compacted");
  });

  it("allows summarizing into the notebook as the thing it can actually do", async () => {
    const { systemPrompt } = await assembleSystemPrompt();
    expect(systemPrompt).toContain("does not shrink the live context window");
  });

  it("routes the user to the real mechanism (/compact, /new -> Keep notebook)", async () => {
    const { systemPrompt } = await assembleSystemPrompt();
    expect(systemPrompt).toContain("/compact");
    expect(systemPrompt).toContain("Keep notebook");
  });

  it("lands inside the Operating discipline section", async () => {
    const { systemPrompt } = await assembleSystemPrompt();
    const disciplineIdx = systemPrompt.indexOf("## Operating discipline");
    const guardrailIdx = systemPrompt.indexOf("compact your own context");
    const planIdx = systemPrompt.indexOf("## Project model and plan sections");
    expect(disciplineIdx).toBeGreaterThanOrEqual(0);
    expect(guardrailIdx).toBeGreaterThan(disciplineIdx);
    expect(guardrailIdx).toBeLessThan(planIdx);
  });
});
