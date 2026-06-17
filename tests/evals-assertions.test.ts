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

describe("evals assertions: tool mentions", () => {
  const nb = (body: string) => `## Plan 1: Metagenomics [galaxy]\n- [ ] 1. **Classify** -- ${body}`;

  it("passes when the plan mentions one of the allowed tools (case-insensitive)", () => {
    const run = makeRun({
      notebookContent: nb("run kraken2 to assign taxonomy to reads"),
      assertions: { notebook: { plan: { mentionsOneOf: ["Kraken", "MetaPhlAn"] } } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("fails (dimension tools) when none of the allowed tools appear", () => {
    const run = makeRun({
      notebookContent: nb("eyeball the reads and guess the organisms"),
      assertions: { notebook: { plan: { mentionsOneOf: ["Kraken", "MetaPhlAn"] } } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("tools");
    expect(f[0].assertion).toContain("mentionsOneOf");
  });

  it("fails when a banned tool is named", () => {
    const run = makeRun({
      notebookContent: nb("BLAST every read against nt, no classifier"),
      assertions: { notebook: { plan: { mentionsNoneOf: ["BLAST"] } } },
    });
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("tools");
    expect(f[0].assertion).toContain("mentionsNoneOf");
  });
});

describe("evals assertions: source-aware plan (Assertions.plan)", () => {
  it("reads the notebook plan when source defaults to 'any' and notebook has one", () => {
    const run = makeRun({
      events: textEvents("Here is a draft idea, no formal plan."),
      notebookContent: "## Plan 1: Real [galaxy]\n- [ ] 1. **Align** -- HISAT2 over hg38 reads",
      assertions: { plan: { routingIn: ["galaxy"], mentionsOneOf: ["HISAT2"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("falls back to chat when no notebook plan exists", () => {
    const run = makeRun({
      events: textEvents("## Plan 1: Chatted [local]\n- [ ] 1. **Rename** -- tidy the files up"),
      notebookContent: null,
      assertions: { plan: { routingIn: ["local"] } },
    });
    expect(evaluate(run)).toHaveLength(0);
  });

  it("honors an explicit source: 'chat' and does not read the notebook", () => {
    const run = makeRun({
      events: textEvents("## Plan 1: Chatted [hybrid]\n- [ ] 1. **Step** -- do the thing here"),
      notebookContent: "## Plan 1: Notebook [galaxy]\n- [ ] 1. **Step** -- other thing here",
      assertions: { plan: { source: "chat", routingIn: ["galaxy"] } },
    });
    // chat routing is hybrid; expected galaxy -> exactly one routing failure.
    // If `plan` is unimplemented this yields 0 failures and the test fails.
    const f = evaluate(run);
    expect(f).toHaveLength(1);
    expect(f[0].dimension).toBe("routing");
  });
});
