import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlan,
  resetState,
  addStep,
  addReportedResult,
  getCurrentPlan,
} from "../extensions/loom/state";
import { generateNotebook } from "../extensions/loom/notebook-writer";
import { parseNotebook, notebookToPlan } from "../extensions/loom/notebook-parser";

describe("report_result dual-persist", () => {
  beforeEach(() => {
    resetState();
  });

  function seedPlanWithStep() {
    const plan = createPlan({
      title: "Result Persistence",
      researchQuestion: "Does the notebook record reported results?",
      dataDescription: "Synthetic",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "ISM Scan",
      description: "Run AlphaGenome ISM scanner",
      executionType: "tool",
      toolId: "alphagenome_ism_scanner",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });
    return plan;
  }

  it("writes a table result under the matching step in the notebook", () => {
    seedPlanWithStep();
    addReportedResult({
      stepId: "1",
      type: "table",
      headers: ["position", "score"],
      rows: [
        ["chr6:92618245", "4.169"],
        ["chr6:92618200", "3.820"],
      ],
      caption: "Top ISM positions",
    });

    const plan = getCurrentPlan()!;
    const markdown = generateNotebook(plan);

    // The result heading and table body both land in the notebook
    expect(markdown).toContain("#### Results");
    expect(markdown).toContain("**Top ISM positions**");
    expect(markdown).toContain("| position | score |");
    expect(markdown).toContain("| chr6:92618245 | 4.169 |");
  });

  it("round-trips reported results through parse", () => {
    seedPlanWithStep();
    addReportedResult({
      stepId: "1",
      type: "table",
      headers: ["position", "score"],
      rows: [["chr6:92618245", "4.169"]],
      caption: "Top ISM positions",
    });
    addReportedResult({
      type: "markdown",
      content: "Plan-level note: scanner window was 600bp.",
      caption: "Scanner config",
    });

    const plan = getCurrentPlan()!;
    const markdown = generateNotebook(plan);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.results).toHaveLength(2);
    expect(restored.results![0]).toMatchObject({
      stepId: "1",
      type: "table",
      caption: "Top ISM positions",
      headers: ["position", "score"],
    });
    expect(restored.results![0].rows).toEqual([["chr6:92618245", "4.169"]]);
    expect(restored.results![1]).toMatchObject({
      type: "markdown",
      caption: "Scanner config",
    });
  });

  it("places orphan results (no step link) in a plan-level Results section", () => {
    seedPlanWithStep();
    addReportedResult({
      type: "markdown",
      content: "Cross-step context: disambiguated credible set to 15 variants.",
      caption: "Context note",
    });

    const plan = getCurrentPlan()!;
    const markdown = generateNotebook(plan);

    // Plan-level heading shows up for orphans
    expect(markdown).toMatch(/\n## Results\n/);
    expect(markdown).toContain("Context note");
    // The step-level "#### Results" should NOT appear
    expect(markdown).not.toContain("#### Results");
  });
});
