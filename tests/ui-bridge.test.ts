import { describe, it, expect } from "vitest";
import { toShellSteps } from "../extensions/galaxy-analyst/ui-bridge";
import { createPlan, addStep, updateStepStatus, resetState, onPlanChange, formatPlanSummary, addStepOutputs, linkInvocation } from "../extensions/galaxy-analyst/state";

describe("ui-bridge", () => {
  describe("toShellSteps", () => {
    it("maps AnalysisStep[] to ShellStep[]", () => {
      resetState();
      const plan = createPlan({
        title: "Test Plan",
        researchQuestion: "Does X cause Y?",
        dataDescription: "RNA-seq data",
        expectedOutcomes: ["DEGs"],
        constraints: [],
      });

      addStep({
        name: "Quality Control",
        description: "Run FastQC on raw reads",
        executionType: "tool",
        toolId: "fastqc",
        inputs: [{ name: "reads", description: "FASTQ files" }],
        expectedOutputs: ["qc_report"],
        dependsOn: [],
      });

      addStep({
        name: "Alignment",
        description: "Align reads to reference",
        executionType: "tool",
        toolId: "hisat2",
        inputs: [{ name: "reads", description: "Trimmed reads", fromStep: "1" }],
        expectedOutputs: ["bam"],
        dependsOn: ["1"],
      });

      const shell = toShellSteps(plan);
      expect(shell).toHaveLength(2);
      expect(shell[0].id).toBe("1");
      expect(shell[0].name).toBe("Quality Control");
      expect(shell[0].status).toBe("pending");
      expect(shell[0].dependsOn).toEqual([]);
      expect(shell[0].command).toBe("fastqc");
      expect(shell[1].dependsOn).toEqual(["1"]);
    });

    it("maps step result summary", () => {
      resetState();
      const p = createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      addStep({
        name: "QC",
        description: "Quality control",
        executionType: "tool",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });
      updateStepStatus("1", "completed", {
        completedAt: new Date().toISOString(),
        summary: "Passed",
        qcPassed: true,
      });

      const shell = toShellSteps(p);
      expect(shell[0].result).toBe("Passed");
      expect(shell[0].status).toBe("completed");
    });
  });

  describe("formatPlanSummary", () => {
    it("renders plan title, phase, and steps", () => {
      resetState();
      const plan = createPlan({
        title: "RNA-seq Analysis",
        researchQuestion: "What genes are differentially expressed?",
        dataDescription: "Paired-end Illumina",
        expectedOutcomes: ["DEG list", "Pathway enrichment"],
        constraints: [],
      });

      addStep({
        name: "FastQC",
        description: "Quality control",
        executionType: "tool",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });

      const md = formatPlanSummary(plan);
      expect(md).toContain("RNA-seq Analysis");
      expect(md).toContain("Problem Definition");
      expect(md).toContain("differentially expressed");
      expect(md).toContain("FastQC");
    });
  });

  describe("onPlanChange", () => {
    it("fires when createPlan is called", () => {
      resetState();
      let fired = false;
      const unsub = onPlanChange(() => { fired = true; });
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      expect(fired).toBe(true);
      unsub();
    });

    it("fires when addStep is called", () => {
      resetState();
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      let count = 0;
      const unsub = onPlanChange(() => { count++; });
      addStep({
        name: "S1",
        description: "D1",
        executionType: "tool",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });
      expect(count).toBeGreaterThan(0);
      unsub();
    });

    it("fires when updateStepStatus is called", () => {
      resetState();
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      addStep({
        name: "S1",
        description: "D1",
        executionType: "tool",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });
      let count = 0;
      const unsub = onPlanChange(() => { count++; });
      updateStepStatus("1", "in_progress");
      expect(count).toBeGreaterThan(0);
      unsub();
    });

    it("unsubscribe stops firing", () => {
      resetState();
      let count = 0;
      const unsub = onPlanChange(() => { count++; });
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      expect(count).toBe(1);
      unsub();
      createPlan({
        title: "Test 2",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      expect(count).toBe(1);
    });

    it("fires when addStepOutputs is called", () => {
      resetState();
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      addStep({
        name: "S1",
        description: "D1",
        executionType: "tool",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });
      let fired = false;
      const unsub = onPlanChange(() => { fired = true; });
      addStepOutputs("1", [{ datasetId: "d1", name: "reads.bam", datatype: "bam" }]);
      expect(fired).toBe(true);
      unsub();
    });

    it("fires when linkInvocation is called", () => {
      resetState();
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      addStep({
        name: "Workflow",
        description: "A workflow step",
        executionType: "workflow",
        workflowId: "wf-1",
        inputs: [],
        expectedOutputs: [],
        dependsOn: [],
      });
      let fired = false;
      const unsub = onPlanChange(() => { fired = true; });
      linkInvocation("1", "inv-123");
      expect(fired).toBe(true);
      unsub();
    });
  });
});
