import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlan,
  resetState,
  addStep,
  updateStepStatus,
  resolveToolVersions,
  generateMethods,
  getCurrentPlan,
} from "../extensions/loom/state";

describe("tool version resolution", () => {
  beforeEach(() => {
    resetState();
  });

  function buildCompletedToolStep() {
    const plan = createPlan({
      title: "Version resolution",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "Run HISAT2",
      description: "Align reads",
      executionType: "tool",
      toolId: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });
    updateStepStatus("1", "completed", {
      completedAt: "2026-03-01T00:00:00Z",
      jobId: "job-42",
      summary: "Alignment completed",
      qcPassed: true,
    });
    return plan;
  }

  it("fetches tool_version from the injected fetcher and stores it on the step", async () => {
    buildCompletedToolStep();

    let seenJobId = "";
    const mockFetcher = async (jobId: string) => {
      seenJobId = jobId;
      return { tool_version: "2.2.1+galaxy1" };
    };

    const updated = await resolveToolVersions(mockFetcher);

    expect(updated).toBe(1);
    expect(seenJobId).toBe("job-42");
    expect(getCurrentPlan()!.steps[0].execution.toolVersion).toBe("2.2.1+galaxy1");
  });

  it("skips steps that already have a toolVersion", async () => {
    buildCompletedToolStep();
    getCurrentPlan()!.steps[0].execution.toolVersion = "2.2.1";

    let calls = 0;
    const mockFetcher = async () => {
      calls += 1;
      return { tool_version: "should-not-be-set" };
    };

    const updated = await resolveToolVersions(mockFetcher);
    expect(updated).toBe(0);
    expect(calls).toBe(0);
  });

  it("skips steps without a jobId", async () => {
    createPlan({
      title: "No Job",
      researchQuestion: "Q",
      dataDescription: "D",
      expectedOutcomes: [],
      constraints: [],
    });
    addStep({
      name: "Manual step",
      description: "Manually do a thing",
      executionType: "tool",
      toolId: "manual-tool",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });

    const updated = await resolveToolVersions(async () => ({
      tool_version: "unused",
    }));

    expect(updated).toBe(0);
  });

  it("swallows per-step fetch errors and keeps going", async () => {
    buildCompletedToolStep();
    // Add a second completed step to test that the failure on the first
    // doesn't prevent the second from being resolved.
    addStep({
      name: "Run FastQC",
      description: "QC",
      executionType: "tool",
      toolId: "fastqc",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });
    updateStepStatus("2", "completed", {
      completedAt: "2026-03-01T00:10:00Z",
      jobId: "job-43",
      summary: "QC done",
      qcPassed: true,
    });

    const mockFetcher = async (jobId: string) => {
      if (jobId === "job-42") throw new Error("transient Galaxy 503");
      return { tool_version: "0.74" };
    };

    const updated = await resolveToolVersions(mockFetcher);
    expect(updated).toBe(1);
    expect(getCurrentPlan()!.steps[0].execution.toolVersion).toBeUndefined();
    expect(getCurrentPlan()!.steps[1].execution.toolVersion).toBe("0.74");
  });

  it("feeds resolved versions into publication_generate_methods", async () => {
    buildCompletedToolStep();

    await resolveToolVersions(async () => ({ tool_version: "2.2.1+galaxy1" }));
    const methods = generateMethods();

    expect(methods.toolVersions).toHaveLength(1);
    expect(methods.toolVersions[0]).toMatchObject({
      toolId: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1",
      version: "2.2.1+galaxy1",
      stepId: "1",
    });
  });

  it("marks unresolved tool versions as 'unresolved' rather than silently filling a placeholder", () => {
    buildCompletedToolStep();
    // Skip the resolution step entirely

    const methods = generateMethods();
    expect(methods.toolVersions[0].version).toBe("unresolved");
  });

  it("respects stepId scope", async () => {
    buildCompletedToolStep();
    addStep({
      name: "Run FastQC",
      description: "QC",
      executionType: "tool",
      toolId: "fastqc",
      inputs: [],
      expectedOutputs: [],
      dependsOn: [],
    });
    updateStepStatus("2", "completed", {
      completedAt: "2026-03-01T00:10:00Z",
      jobId: "job-43",
      summary: "QC done",
      qcPassed: true,
    });

    await resolveToolVersions(async () => ({ tool_version: "SHOULD_ONLY_APPEAR_ON_STEP_2" }), {
      stepId: "2",
    });
    expect(getCurrentPlan()!.steps[0].execution.toolVersion).toBeUndefined();
    expect(getCurrentPlan()!.steps[1].execution.toolVersion).toBe(
      "SHOULD_ONLY_APPEAR_ON_STEP_2"
    );
  });
});
