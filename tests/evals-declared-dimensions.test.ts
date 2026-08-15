import { describe, expect, it } from "vitest";
import { declaredDimensions } from "../evals/lib/aggregate";
import type { PlanAssertions, Scenario } from "../evals/lib/types";

function scenario(plan: PlanAssertions): Scenario {
  return { name: "test", tier: 2, inputs: [], assertions: { plan } } as Scenario;
}

describe("declaredDimensions", () => {
  // The bug: a scenario whose only tool check was mentionsAllOf never declared
  // the "tools" dimension, so aggregateCells skipped it entirely and the runner
  // exited 0 no matter how badly the model did on that assertion. An eval that
  // structurally cannot fail is worse than no eval.
  it("counts mentionsAllOf as a tools check", () => {
    expect(declaredDimensions(scenario({ mentionsAllOf: ["HISAT2"] })).has("tools")).toBe(true);
  });

  it("still counts mentionsOneOf and mentionsNoneOf", () => {
    expect(declaredDimensions(scenario({ mentionsOneOf: ["BWA"] })).has("tools")).toBe(true);
    expect(declaredDimensions(scenario({ mentionsNoneOf: ["bowtie"] })).has("tools")).toBe(true);
  });

  it("does not invent a tools dimension for a plan that makes no tool claim", () => {
    expect(declaredDimensions(scenario({ exists: true })).has("tools")).toBe(false);
  });
});
