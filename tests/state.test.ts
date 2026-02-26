import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlan,
  getCurrentPlan,
  resetState,
  getState,
  addStep,
  updateStepStatus,
  addStepOutputs,
  logDecision,
  setCheckpoint,
  setPlanStatus,
  setPhase,
  getPhase,
  setResearchQuestion,
  addLiteratureRef,
  setDataProvenance,
  addSample,
  addDataFile,
  updateDataFile,
  addFinding,
  setInterpretationSummary,
  getFindings,
  initPublication,
  generateMethods,
  addFigure,
  updateFigure,
  formatPlanSummary,
  restorePlan,
  setGalaxyConnection,
} from "../extensions/galaxy-analyst/state";

describe("state management", () => {
  beforeEach(() => {
    resetState();
  });

  describe("createPlan", () => {
    it("creates a plan with correct defaults", () => {
      const plan = createPlan({
        title: "RNA-seq Analysis",
        researchQuestion: "Does drug X affect gene expression?",
        dataDescription: "6 samples, 3 treated vs 3 control",
        expectedOutcomes: ["DEG list", "Pathway enrichment"],
        constraints: ["Use Galaxy tools only"],
      });

      expect(plan.title).toBe("RNA-seq Analysis");
      expect(plan.status).toBe("draft");
      expect(plan.phase).toBe("problem_definition");
      expect(plan.steps).toHaveLength(0);
      expect(plan.decisions).toHaveLength(0);
      expect(plan.id).toBeTruthy();
      expect(plan.context.researchQuestion).toBe("Does drug X affect gene expression?");
    });

    it("sets it as the current plan", () => {
      expect(getCurrentPlan()).toBeNull();
      createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
      });
      expect(getCurrentPlan()).not.toBeNull();
    });

    it("tracks recent plan IDs", () => {
      createPlan({ title: "P1", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      const id1 = getCurrentPlan()!.id;
      createPlan({ title: "P2", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      expect(getState().recentPlanIds).toContain(id1);
    });

    it("accepts custom starting phase", () => {
      const plan = createPlan({
        title: "Test",
        researchQuestion: "Q",
        dataDescription: "D",
        expectedOutcomes: [],
        constraints: [],
        phase: "analysis",
      });
      expect(plan.phase).toBe("analysis");
    });
  });

  describe("addStep", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("adds a step to the plan", () => {
      const step = addStep({
        name: "Quality Control",
        description: "Run FastQC on raw reads",
        executionType: "tool",
        toolId: "toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc",
        inputs: [{ name: "reads", description: "FASTQ files" }],
        expectedOutputs: ["QC report"],
        dependsOn: [],
      });

      expect(step.id).toBe("1");
      expect(step.name).toBe("Quality Control");
      expect(step.status).toBe("pending");
      expect(getCurrentPlan()!.steps).toHaveLength(1);
    });

    it("assigns sequential IDs", () => {
      addStep({ name: "S1", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });
      addStep({ name: "S2", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });
      addStep({ name: "S3", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });

      const plan = getCurrentPlan()!;
      expect(plan.steps.map(s => s.id)).toEqual(["1", "2", "3"]);
    });

    it("throws without active plan", () => {
      resetState();
      expect(() => addStep({
        name: "S", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [],
      })).toThrow("No active plan");
    });
  });

  describe("updateStepStatus", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      addStep({ name: "S1", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });
    });

    it("updates step status", () => {
      updateStepStatus("1", "in_progress");
      expect(getCurrentPlan()!.steps[0].status).toBe("in_progress");
    });

    it("attaches result when completing", () => {
      updateStepStatus("1", "completed", {
        completedAt: "2026-02-06T00:00:00Z",
        jobId: "job-123",
        summary: "Completed successfully",
        qcPassed: true,
      });
      const step = getCurrentPlan()!.steps[0];
      expect(step.status).toBe("completed");
      expect(step.result?.jobId).toBe("job-123");
    });

    it("throws for nonexistent step", () => {
      expect(() => updateStepStatus("999", "completed")).toThrow("Step 999 not found");
    });
  });

  describe("addStepOutputs", () => {
    it("adds outputs to a step", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      addStep({ name: "S1", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });

      addStepOutputs("1", [
        { datasetId: "ds-1", name: "report.html", datatype: "html" },
        { datasetId: "ds-2", name: "stats.txt", datatype: "tabular" },
      ]);

      expect(getCurrentPlan()!.steps[0].actualOutputs).toHaveLength(2);
    });
  });

  describe("logDecision", () => {
    it("logs a decision entry", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });

      const decision = logDecision({
        stepId: null,
        type: "tool_selection",
        description: "Using HISAT2 instead of STAR",
        rationale: "Lower memory requirements for this dataset size",
        researcherApproved: true,
      });

      expect(decision.type).toBe("tool_selection");
      expect(decision.researcherApproved).toBe(true);
      expect(getCurrentPlan()!.decisions).toHaveLength(1);
    });
  });

  describe("setCheckpoint", () => {
    it("creates a new checkpoint", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      addStep({ name: "S1", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });

      const cp = setCheckpoint({
        stepId: "1",
        name: "QC Pass",
        criteria: ["Per-base quality > 20", "Adapter content < 5%"],
        status: "passed",
        observations: ["All samples pass quality thresholds"],
      });

      expect(cp.status).toBe("passed");
      expect(cp.reviewedAt).toBeTruthy();
      expect(getCurrentPlan()!.checkpoints).toHaveLength(1);
    });

    it("updates existing checkpoint for same step and name", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      addStep({ name: "S1", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });

      setCheckpoint({ stepId: "1", name: "QC", criteria: ["C1"], status: "pending", observations: [] });
      setCheckpoint({ stepId: "1", name: "QC", criteria: ["C1"], status: "passed", observations: ["Looks good"] });

      expect(getCurrentPlan()!.checkpoints).toHaveLength(1);
      expect(getCurrentPlan()!.checkpoints[0].status).toBe("passed");
    });
  });

  describe("phase management", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("gets and sets phase", () => {
      expect(getPhase()).toBe("problem_definition");
      setPhase("data_acquisition");
      expect(getPhase()).toBe("data_acquisition");
      expect(getCurrentPlan()!.phase).toBe("data_acquisition");
    });

    it("returns null with no plan", () => {
      resetState();
      expect(getPhase()).toBeNull();
    });
  });

  describe("research question (phase 1)", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("sets research question with PICO", () => {
      const rq = setResearchQuestion({
        rawQuestion: "Does drug X affect tumor growth?",
        hypothesis: "Drug X reduces tumor volume by > 50%",
        pico: {
          population: "Tumor cell lines",
          intervention: "Drug X treatment",
          comparison: "Vehicle control",
          outcome: "Tumor volume reduction",
        },
      });

      expect(rq.hypothesis).toBe("Drug X reduces tumor volume by > 50%");
      expect(rq.pico?.population).toBe("Tumor cell lines");
      expect(rq.refinedAt).toBeTruthy();
    });

    it("adds literature references", () => {
      const ref = addLiteratureRef({
        title: "Drug X mechanism of action",
        pmid: "12345678",
        relevance: "Establishes baseline mechanism",
      });

      expect(ref.title).toBe("Drug X mechanism of action");
      expect(ref.addedAt).toBeTruthy();
      expect(getCurrentPlan()!.researchQuestion!.literatureRefs).toHaveLength(1);
    });

    it("initializes researchQuestion if missing when adding lit ref", () => {
      // Plan starts without researchQuestion set
      expect(getCurrentPlan()!.researchQuestion).toBeUndefined();
      addLiteratureRef({ title: "Paper 1", relevance: "Relevant" });
      expect(getCurrentPlan()!.researchQuestion).toBeTruthy();
    });
  });

  describe("data provenance (phase 2)", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("sets data provenance", () => {
      const dp = setDataProvenance({
        source: "geo",
        accession: "GSE12345",
      });

      expect(dp.source).toBe("geo");
      expect(dp.accession).toBe("GSE12345");
      expect(dp.samples).toHaveLength(0);
    });

    it("adds samples", () => {
      setDataProvenance({ source: "geo" });
      addSample({ id: "s1", name: "Control_1", condition: "control", replicate: 1, metadata: {}, files: [] });
      addSample({ id: "s2", name: "Treated_1", condition: "treated", replicate: 1, metadata: {}, files: [] });

      expect(getCurrentPlan()!.dataProvenance!.samples).toHaveLength(2);
    });

    it("adds and updates data files", () => {
      setDataProvenance({ source: "geo" });
      addDataFile({ id: "f1", name: "sample1_R1.fastq.gz", type: "fastq", readType: "paired", pairedWith: "f2" });

      expect(getCurrentPlan()!.dataProvenance!.originalFiles).toHaveLength(1);

      const updated = updateDataFile("f1", { galaxyDatasetId: "gx-dataset-123" });
      expect(updated?.galaxyDatasetId).toBe("gx-dataset-123");
    });

    it("auto-initializes provenance when adding samples", () => {
      addSample({ id: "s1", name: "Sample1", metadata: {}, files: [] });
      expect(getCurrentPlan()!.dataProvenance).toBeTruthy();
      expect(getCurrentPlan()!.dataProvenance!.source).toBe("local");
    });
  });

  describe("interpretation (phase 4)", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("adds a finding", () => {
      const finding = addFinding({
        title: "TP53 upregulated",
        description: "TP53 shows significant upregulation in treated samples",
        evidence: "Log2FC = 2.3, padj < 0.001",
        category: "differential_expression",
        relatedSteps: ["1", "3"],
        confidence: "high",
      });

      expect(finding.id).toBe("finding-1");
      expect(finding.title).toBe("TP53 upregulated");
      expect(finding.addedAt).toBeTruthy();
      expect(getFindings()).toHaveLength(1);
    });

    it("assigns sequential finding IDs", () => {
      addFinding({ title: "F1", description: "D", evidence: "E", category: "other", relatedSteps: [], confidence: "medium" });
      addFinding({ title: "F2", description: "D", evidence: "E", category: "pathway", relatedSteps: [], confidence: "low" });
      addFinding({ title: "F3", description: "D", evidence: "E", category: "negative", relatedSteps: [], confidence: "uncertain" });

      const findings = getFindings();
      expect(findings.map(f => f.id)).toEqual(["finding-1", "finding-2", "finding-3"]);
    });

    it("auto-initializes interpretation when adding first finding", () => {
      expect(getCurrentPlan()!.interpretation).toBeUndefined();
      addFinding({ title: "F1", description: "D", evidence: "E", category: "other", relatedSteps: [], confidence: "medium" });
      expect(getCurrentPlan()!.interpretation).toBeTruthy();
      expect(getCurrentPlan()!.interpretation!.findings).toHaveLength(1);
    });

    it("sets interpretation summary", () => {
      addFinding({ title: "F1", description: "D", evidence: "E", category: "other", relatedSteps: [], confidence: "medium" });
      setInterpretationSummary("Drug X causes widespread transcriptional changes");

      const interp = getCurrentPlan()!.interpretation!;
      expect(interp.summary).toBe("Drug X causes widespread transcriptional changes");
      expect(interp.summarizedAt).toBeTruthy();
    });

    it("auto-initializes interpretation when setting summary", () => {
      expect(getCurrentPlan()!.interpretation).toBeUndefined();
      setInterpretationSummary("Summary text");
      expect(getCurrentPlan()!.interpretation!.summary).toBe("Summary text");
      expect(getCurrentPlan()!.interpretation!.findings).toHaveLength(0);
    });

    it("getFindings returns empty array with no plan", () => {
      resetState();
      expect(getFindings()).toHaveLength(0);
    });

    it("throws without active plan", () => {
      resetState();
      expect(() => addFinding({
        title: "F", description: "D", evidence: "E", category: "other", relatedSteps: [], confidence: "low",
      })).toThrow("No active plan");
    });
  });

  describe("publication (phase 5)", () => {
    beforeEach(() => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
    });

    it("initializes publication", () => {
      const pub = initPublication("Nature Methods");
      expect(pub.targetJournal).toBe("Nature Methods");
      expect(pub.status).toBe("not_started");
      expect(pub.figures).toHaveLength(0);
    });

    it("generates methods from completed steps", () => {
      addStep({ name: "FastQC", description: "Quality check", executionType: "tool", toolId: "fastqc", inputs: [], expectedOutputs: [], dependsOn: [] });
      updateStepStatus("1", "completed", { completedAt: "2026-01-01T00:00:00Z", summary: "Done", qcPassed: true });

      const methods = generateMethods();
      expect(methods.text).toContain("FastQC");
      expect(methods.toolVersions).toHaveLength(1);
      expect(methods.toolVersions[0].toolId).toBe("fastqc");
    });

    it("auto-initializes publication when generating methods", () => {
      const methods = generateMethods();
      expect(getCurrentPlan()!.publication).toBeTruthy();
      expect(getCurrentPlan()!.publication!.methodsDraft).toBe(methods);
    });

    it("adds and updates figures", () => {
      initPublication();
      const fig = addFigure({
        name: "PCA Plot",
        type: "pca",
        dataSource: "step-1",
        status: "planned",
        description: "Principal component analysis of samples",
      });

      expect(fig.id).toBe("fig-1");
      expect(getCurrentPlan()!.publication!.figures).toHaveLength(1);

      const updated = updateFigure("fig-1", { status: "generated", galaxyDatasetId: "gx-123" });
      expect(updated?.status).toBe("generated");
    });
  });

  describe("galaxy connection", () => {
    it("sets galaxy connection state", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      setGalaxyConnection(true, "hist-123", "https://usegalaxy.org");

      expect(getState().galaxyConnected).toBe(true);
      expect(getState().currentHistoryId).toBe("hist-123");
      expect(getCurrentPlan()!.galaxy.historyId).toBe("hist-123");
      expect(getCurrentPlan()!.galaxy.serverUrl).toBe("https://usegalaxy.org");
    });
  });

  describe("restorePlan", () => {
    it("restores a plan and syncs galaxy state", () => {
      const plan = createPlan({ title: "Saved", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      plan.galaxy.historyId = "hist-abc";
      resetState();

      expect(getCurrentPlan()).toBeNull();
      restorePlan(plan);
      expect(getCurrentPlan()?.title).toBe("Saved");
      expect(getState().currentHistoryId).toBe("hist-abc");
    });
  });

  describe("formatPlanSummary", () => {
    it("includes plan title, phase, and research question", () => {
      const plan = createPlan({
        title: "RNA-seq Analysis",
        researchQuestion: "Does drug X affect gene expression?",
        dataDescription: "6 samples",
        expectedOutcomes: ["DEG list"],
        constraints: [],
      });

      const summary = formatPlanSummary(plan);
      expect(summary).toContain("RNA-seq Analysis");
      expect(summary).toContain("Problem Definition");
      expect(summary).toContain("Does drug X affect gene expression?");
    });

    it("includes step overview", () => {
      const plan = createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      addStep({ name: "FastQC", description: "D", executionType: "tool", inputs: [], expectedOutputs: [], dependsOn: [] });
      updateStepStatus("1", "completed", { completedAt: "now", summary: "Done", qcPassed: true });

      const summary = formatPlanSummary(plan);
      expect(summary).toContain("FastQC");
    });
  });

  describe("setPlanStatus", () => {
    it("updates plan status", () => {
      createPlan({ title: "Test", researchQuestion: "Q", dataDescription: "D", expectedOutcomes: [], constraints: [] });
      setPlanStatus("active");
      expect(getCurrentPlan()!.status).toBe("active");
    });

    it("throws without active plan", () => {
      expect(() => setPlanStatus("active")).toThrow("No active plan");
    });
  });
});
