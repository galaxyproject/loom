import { describe, it, expect } from "vitest";
import { aggregateCells, declaredDimensions } from "../evals/lib/aggregate";
import { renderLeaderboard } from "../evals/lib/report";
import type { Assertions, Scenario, ScenarioRun } from "../evals/lib/types";

function run(modelId: string, runIndex: number, failDims: string[]): ScenarioRun {
  return {
    scenarioDir: "/tmp/s",
    scenario: { name: "s", tier: 2, requiresModel: true, inputs: ["x"], assertions: {} },
    model: { id: modelId, provider: "p", model: "m" },
    runIndex,
    exitCode: 0,
    events: [],
    stdout: "",
    stderr: "",
    notebookContent: null,
    failures: failDims.map((d) => ({ assertion: d, detail: "", dimension: d as never })),
    durationMs: 1,
  };
}

describe("evals aggregate", () => {
  it("declaredDimensions reflects which assertions a scenario uses", () => {
    const a: Assertions = {
      plan: { routingIn: ["galaxy"], minPendingSteps: 3, mentionsOneOf: ["X"] },
      behavior: { asksClarifyingQuestion: true },
    };
    const s = { name: "s", tier: 2, inputs: ["x"], assertions: a } as Scenario;
    const dims = declaredDimensions(s);
    expect([...dims].sort()).toEqual(["behavior", "routing", "tools", "validity"]);
  });

  it("declaredDimensions includes 'validity' when plan.exists is false", () => {
    // exists: false means the scenario asserts no plan should appear.
    // aggregation must count that dimension -- otherwise a model that writes a
    // plan when it shouldn't passes silently (false green).
    const a: Assertions = { plan: { exists: false } };
    const s = { name: "s", tier: 2, inputs: ["x"], assertions: a } as Scenario;
    const dims = declaredDimensions(s);
    expect(dims).toContain("validity");
  });

  it("computes majority verdict per dimension across 3 runs", () => {
    const runs: ScenarioRun[] = [
      run("tacc:x", 0, ["routing"]),
      run("tacc:x", 1, []),
      run("tacc:x", 2, []),
    ];
    // declare routing for the scenario so it's counted
    runs.forEach((r) => (r.scenario.assertions = { plan: { routingIn: ["galaxy"] } }));
    const cells = aggregateCells(runs);
    expect(cells).toHaveLength(1);
    expect(cells[0].dimensions.routing.pass).toBe(2);
    expect(cells[0].dimensions.routing.total).toBe(3);
    expect(cells[0].dimensions.routing.verdict).toBe(true); // 2/3 majority
  });
});

describe("evals leaderboard render", () => {
  it("renders a model x dimension grid with pass-rates", () => {
    const cells = [
      {
        scenarioName: "s1",
        modelId: "tacc:qwen3-32b",
        runs: 3,
        dimensions: {
          routing: { pass: 3, total: 3, verdict: true },
          tools: { pass: 2, total: 3, verdict: true },
        },
      },
      {
        scenarioName: "s1",
        modelId: "tacc:llama-3.1-8b",
        runs: 3,
        dimensions: {
          routing: { pass: 0, total: 3, verdict: false },
          tools: { pass: 1, total: 3, verdict: false },
        },
      },
    ];
    const md = renderLeaderboard(cells);
    expect(md).toContain("tacc:qwen3-32b");
    expect(md).toContain("tacc:llama-3.1-8b");
    expect(md).toContain("routing");
    // qwen passed routing in 3/3 -> shows 3/3; llama 0/3
    expect(md).toMatch(/tacc:qwen3-32b.*3\/3/s);
  });
});
