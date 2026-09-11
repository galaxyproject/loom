import { describe, expect, it } from "vitest";
import { evaluate } from "../evals/lib/assertions";
import type { PlanAssertions, ScenarioRun } from "../evals/lib/types";

const PLAN = [
  "## Plan 1: RNA-seq counts [galaxy]",
  "",
  "- [ ] **Align reads** Run HISAT2 against mm39.",
  "- [ ] **Count features** Run featureCounts over the BAMs.",
  "- [ ] **Report** Summarize the run with a MultiQC report.",
].join("\n");

function run(notebookContent: string, plan: PlanAssertions): ScenarioRun {
  return {
    scenarioDir: "/tmp/scenario",
    scenario: {
      name: "test",
      tier: 2,
      inputs: [],
      assertions: { plan },
    },
    model: null,
    exitCode: 0,
    events: [],
    stdout: "",
    stderr: "",
    notebookContent,
    failures: [],
    durationMs: 0,
  } as ScenarioRun;
}

describe("plan.mentionsAllOf", () => {
  it("passes when every required term appears", () => {
    const failures = evaluate(run(PLAN, { exists: true, mentionsAllOf: ["HISAT2", "MultiQC"] }));

    expect(failures).toEqual([]);
  });

  it("fails, and names the term, when one is missing", () => {
    const failures = evaluate(run(PLAN, { exists: true, mentionsAllOf: ["HISAT2", "DESeq2"] }));

    expect(failures).toHaveLength(1);
    expect(failures[0].assertion).toBe("plan.mentionsAllOf");
    expect(failures[0].detail).toContain("DESeq2");
  });

  it("is case-insensitive, like the other mention checks", () => {
    const failures = evaluate(run(PLAN, { exists: true, mentionsAllOf: ["hisat2", "multiqc"] }));

    expect(failures).toEqual([]);
  });

  it("is graded as ungradeable rather than silently passing when no plan exists", () => {
    const failures = evaluate(run("no plan here", { exists: true, mentionsAllOf: ["HISAT2"] }));

    expect(failures.some((f) => f.assertion === "plan.exists")).toBe(true);
    expect(failures.some((f) => f.assertion === "plan.mentions")).toBe(true);
  });
});
