import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlan,
  resetState,
  addStep,
  updateStepStatus,
  logDecision,
  setCheckpoint,
  setPhase,
  setResearchQuestion,
  addLiteratureRef,
  setDataProvenance,
  addSample,
  addDataFile,
  addFinding,
  setInterpretationSummary,
  initPublication,
  addFigure,
} from "../extensions/galaxy-analyst/state";
import { generateNotebook } from "../extensions/galaxy-analyst/notebook-writer";
import { parseNotebook, notebookToPlan, parseFrontmatter } from "../extensions/galaxy-analyst/notebook-parser";
import type { AnalysisPlan } from "../extensions/galaxy-analyst/types";

describe("notebook round-trip", () => {
  beforeEach(() => {
    resetState();
  });

  function buildTestPlan(): AnalysisPlan {
    const plan = createPlan({
      title: "Drug X RNA-seq Differential Expression",
      researchQuestion: "Does drug X alter gene expression in HeLa cells?",
      dataDescription: "6 RNA-seq samples: 3 drug-treated, 3 vehicle control",
      expectedOutcomes: ["Differentially expressed gene list", "Pathway enrichment results"],
      constraints: ["Use Galaxy public tools", "FDR < 0.05 cutoff"],
    });

    // Add steps
    addStep({
      name: "Quality Assessment",
      description: "Run FastQC on all raw FASTQ files",
      executionType: "tool",
      toolId: "toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc/0.74",
      inputs: [{ name: "reads", description: "Raw FASTQ files" }],
      expectedOutputs: ["QC reports"],
      dependsOn: [],
    });

    addStep({
      name: "Read Alignment",
      description: "Align reads to human reference genome with HISAT2",
      executionType: "tool",
      toolId: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1",
      inputs: [{ name: "reads", description: "Trimmed FASTQ files" }],
      expectedOutputs: ["BAM files"],
      dependsOn: ["1"],
    });

    // Complete step 1
    updateStepStatus("1", "completed", {
      completedAt: "2026-02-06T10:30:00Z",
      jobId: "job-fastqc-001",
      summary: "All 6 samples pass quality thresholds",
      qcPassed: true,
    });

    // Log a decision
    logDecision({
      stepId: "1",
      type: "parameter_choice",
      description: "Using default FastQC parameters",
      rationale: "Standard parameters appropriate for Illumina RNA-seq data",
      researcherApproved: true,
    });

    // Add a checkpoint
    setCheckpoint({
      stepId: "1",
      name: "Quality Gate",
      criteria: ["Per-base quality > Q20", "Adapter contamination < 5%"],
      status: "passed",
      observations: ["All samples meet quality criteria"],
    });

    return plan;
  }

  it("preserves plan metadata through write/parse/convert", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.plan_id).toBe(original.id);
    expect(parsed!.frontmatter.title).toBe(original.title);
    expect(parsed!.frontmatter.status).toBe(original.status);
    expect(parsed!.frontmatter.phase).toBe(original.phase);
  });

  it("preserves research context", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.context.researchQuestion).toBe(original.context.researchQuestion);
    expect(restored.context.dataDescription).toBe(original.context.dataDescription);
  });

  it("preserves steps through round-trip", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.steps).toHaveLength(2);
    expect(restored.steps[0].name).toBe("Quality Assessment");
    expect(restored.steps[0].status).toBe("completed");
    expect(restored.steps[0].execution.toolId).toBe(
      "toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc/0.74"
    );
    expect(restored.steps[1].name).toBe("Read Alignment");
    expect(restored.steps[1].status).toBe("pending");
  });

  it("preserves completed step results", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.steps[0].result?.jobId).toBe("job-fastqc-001");
  });

  it("preserves decisions", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.decisions).toHaveLength(1);
    expect(restored.decisions[0].type).toBe("parameter_choice");
    expect(restored.decisions[0].researcherApproved).toBe(true);
  });

  it("preserves checkpoints", () => {
    const original = buildTestPlan();
    const markdown = generateNotebook(original);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.checkpoints).toHaveLength(1);
    expect(restored.checkpoints[0].name).toBe("Quality Gate");
    expect(restored.checkpoints[0].status).toBe("passed");
  });

  it("handles minimal plan (no steps, no decisions)", () => {
    createPlan({
      title: "Empty Plan",
      researchQuestion: "What?",
      dataDescription: "Nothing yet",
      expectedOutcomes: [],
      constraints: [],
    });
    const plan = createPlan({
      title: "Minimal Plan",
      researchQuestion: "Simple question",
      dataDescription: "No data",
      expectedOutcomes: ["Something"],
      constraints: [],
    });

    const markdown = generateNotebook(plan);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.title).toBe("Minimal Plan");
    expect(restored.steps).toHaveLength(0);
    expect(restored.decisions).toHaveLength(0);
  });

  it("preserves galaxy connection info", () => {
    const plan = createPlan({
      title: "Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    plan.galaxy.serverUrl = "https://usegalaxy.org";
    plan.galaxy.historyId = "hist-abc123";
    plan.galaxy.historyName = "Drug X Analysis";

    const markdown = generateNotebook(plan);
    const parsed = parseNotebook(markdown);
    const restored = notebookToPlan(parsed!);

    expect(restored.galaxy.serverUrl).toBe("https://usegalaxy.org");
    expect(restored.galaxy.historyId).toBe("hist-abc123");
    expect(restored.galaxy.historyName).toBe("Drug X Analysis");
  });
});

describe("parseFrontmatter", () => {
  it("parses valid frontmatter", () => {
    const content = `---
plan_id: "test-id"
title: "My Plan"
status: active
phase: analysis
created: "2026-02-06T00:00:00Z"
updated: "2026-02-06T12:00:00Z"

galaxy:
  server_url: "https://usegalaxy.org"
  history_id: "hist-123"
  history_name: "Test"
  history_url: ""
---

# My Plan
`;

    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm!.plan_id).toBe("test-id");
    expect(fm!.title).toBe("My Plan");
    expect(fm!.status).toBe("active");
    expect(fm!.phase).toBe("analysis");
    expect(fm!.galaxy.server_url).toBe("https://usegalaxy.org");
    expect(fm!.galaxy.history_id).toBe("hist-123");
  });

  it("returns null for invalid frontmatter", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
    expect(parseFrontmatter("---\ntitle: missing fields\n---")).toBeNull();
  });

  it("defaults phase to analysis for backwards compat", () => {
    const content = `---
plan_id: "test"
title: "Old Plan"
status: active
created: "2026-01-01"
updated: "2026-01-02"

galaxy:
  server_url: ""
  history_id: ""
  history_name: ""
  history_url: ""
---
`;

    const fm = parseFrontmatter(content);
    expect(fm!.phase).toBe("analysis");
  });
});

describe("notebook with lifecycle phases", () => {
  beforeEach(() => {
    resetState();
  });

  it("includes hypothesis and PICO in notebook", () => {
    const plan = createPlan({
      title: "Drug Study",
      researchQuestion: "Does drug X work?",
      dataDescription: "RNA-seq",
      expectedOutcomes: ["DEGs"],
      constraints: [],
    });

    setResearchQuestion({
      rawQuestion: "Does drug X work?",
      hypothesis: "Drug X reduces tumor gene expression",
      pico: {
        population: "HeLa cells",
        intervention: "Drug X 10uM",
        comparison: "DMSO vehicle",
        outcome: "Gene expression changes",
      },
    });

    const markdown = generateNotebook(plan);
    expect(markdown).toContain("Drug X reduces tumor gene expression");
    expect(markdown).toContain("HeLa cells");
    expect(markdown).toContain("PICO Framework");
  });

  it("includes literature references in notebook", () => {
    const plan = createPlan({
      title: "Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });

    setResearchQuestion({ rawQuestion: "Q" });
    addLiteratureRef({
      title: "Important Paper",
      pmid: "99999999",
      year: 2025,
      relevance: "Key background on drug X mechanism",
    });

    const markdown = generateNotebook(plan);
    expect(markdown).toContain("Important Paper");
    expect(markdown).toContain("PMID: 99999999");
    expect(markdown).toContain("Key background on drug X mechanism");
  });

  it("includes data provenance in notebook", () => {
    const plan = createPlan({
      title: "Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });

    setDataProvenance({ source: "geo", accession: "GSE12345" });
    addSample({ id: "s1", name: "Control_1", condition: "control", replicate: 1, metadata: {}, files: ["f1"] });
    addDataFile({ id: "f1", name: "control_1_R1.fastq.gz", type: "fastq", readType: "paired" });

    const markdown = generateNotebook(plan);
    expect(markdown).toContain("Data Provenance");
    expect(markdown).toContain("GEO");
    expect(markdown).toContain("GSE12345");
    expect(markdown).toContain("Control_1");
    expect(markdown).toContain("control_1_R1.fastq.gz");
  });

  it("includes interpretation findings in notebook", () => {
    const plan = createPlan({
      title: "Interpretation Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });

    addFinding({
      title: "TP53 pathway upregulated",
      description: "Significant upregulation of TP53 target genes",
      evidence: "12 of 15 TP53 targets show log2FC > 1, padj < 0.05",
      category: "pathway",
      relatedSteps: ["3", "4"],
      confidence: "high",
    });

    addFinding({
      title: "No structural variants detected",
      description: "No large-scale structural variants in treated samples",
      evidence: "SV calling pipeline returned zero hits",
      category: "negative",
      relatedSteps: ["5"],
      confidence: "high",
    });

    setInterpretationSummary("Drug X activates the TP53 tumor suppressor pathway");

    const markdown = generateNotebook(plan);
    expect(markdown).toContain("## Interpretation");
    expect(markdown).toContain("TP53 pathway upregulated");
    expect(markdown).toContain("`pathway`");
    expect(markdown).toContain("`high`");
    expect(markdown).toContain("Drug X activates the TP53 tumor suppressor pathway");
    expect(markdown).toContain("No structural variants detected");
    expect(markdown).toContain("`negative`");
  });

  it("round-trips interpretation findings through notebook", () => {
    const plan = createPlan({
      title: "Round-trip Interp",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });

    addFinding({
      title: "Gene X upregulated",
      description: "Gene X shows 4-fold upregulation",
      evidence: "DESeq2 results, padj = 0.0001",
      category: "differential_expression",
      relatedSteps: ["2"],
      confidence: "high",
    });

    setInterpretationSummary("Gene X is a key responder");

    const markdown = generateNotebook(plan);
    const parsed = parseNotebook(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed!.interpretation).toBeTruthy();
    expect(parsed!.interpretation!.findings).toHaveLength(1);
    expect(parsed!.interpretation!.findings[0].title).toBe("Gene X upregulated");
    expect(parsed!.interpretation!.findings[0].category).toBe("differential_expression");
    expect(parsed!.interpretation!.findings[0].confidence).toBe("high");
    expect(parsed!.interpretation!.summary).toBe("Gene X is a key responder");

    const restored = notebookToPlan(parsed!);
    expect(restored.interpretation).toBeTruthy();
    expect(restored.interpretation!.findings).toHaveLength(1);
    expect(restored.interpretation!.findings[0].title).toBe("Gene X upregulated");
    expect(restored.interpretation!.summary).toBe("Gene X is a key responder");
  });

  it("includes publication materials in notebook", () => {
    const plan = createPlan({
      title: "Test",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });

    initPublication("Nature Methods");
    addFigure({
      name: "Volcano Plot",
      type: "volcano",
      dataSource: "step-3",
      status: "planned",
    });

    const markdown = generateNotebook(plan);
    expect(markdown).toContain("Publication");
    expect(markdown).toContain("Nature Methods");
    expect(markdown).toContain("Volcano Plot");
  });
});
