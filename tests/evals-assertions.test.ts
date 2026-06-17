import { describe, it, expect } from "vitest";
import { evaluate } from "../evals/lib/assertions";
import type { AnyEvent, Assertions, ModelEntry, ScenarioRun } from "../evals/lib/types";

function textEvents(text: string): AnyEvent[] {
  return [
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    { type: "turn_end" },
  ];
}

function makeRun(opts: {
  events?: AnyEvent[];
  notebookContent?: string | null;
  assertions: Assertions;
  model?: ModelEntry | null;
}): ScenarioRun {
  return {
    scenarioDir: "/tmp/x",
    scenario: {
      name: "test",
      tier: 2,
      inputs: ["go"],
      assertions: opts.assertions,
    },
    model: opts.model ?? null,
    exitCode: 0,
    events: opts.events ?? [],
    stdout: "",
    stderr: "",
    notebookContent: opts.notebookContent ?? null,
    failures: [],
    durationMs: 1,
  };
}

describe("evals assertions: dimension tagging", () => {
  it("tags a routing failure as 'routing' and a validity failure as 'validity'", () => {
    const run = makeRun({
      notebookContent: "## Plan 1: Thing [local]\n- [ ] 1. **Do** -- a real description here",
      assertions: { notebook: { plan: { routingIn: ["galaxy"], minPendingSteps: 3 } } },
    });
    const failures = evaluate(run);
    const routing = failures.find((f) => f.assertion.endsWith("routingIn"));
    const validity = failures.find((f) => f.assertion.endsWith("minPendingSteps"));
    expect(routing?.dimension).toBe("routing");
    expect(validity?.dimension).toBe("validity");
  });

  it("tags exitCode failures as 'other'", () => {
    const run = makeRun({ assertions: { exitCode: 0 } });
    run.exitCode = 1;
    const failures = evaluate(run);
    expect(failures[0].dimension).toBe("other");
  });
});
