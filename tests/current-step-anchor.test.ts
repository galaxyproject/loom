import { describe, it, expect, beforeEach } from "vitest";
import { parseMostRecentPlan } from "../extensions/loom/init-gate";
import {
  getCurrentStepAnchor,
  setCurrentStepAnchor,
  getState,
  resetState,
} from "../extensions/loom/state";

const PLAN = [
  "## Plan A: chrM Variant Calling [galaxy]",
  "",
  "### Steps",
  "",
  "- [x] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim",
  "- [ ] 2. **Read alignment** {#plan-a-step-2} — bwa mem PE 4 samples",
  "- [ ] 3. **Call variants** {#plan-a-step-3} — bcftools",
].join("\n");

describe("plan parsing: the next step's anchor", () => {
  it("picks the anchor off the first pending step", () => {
    expect(parseMostRecentPlan(PLAN)?.nextStep?.anchor).toBe("plan-a-step-2");
  });

  it("is absent when the step carries no anchor", () => {
    const plan = [
      "## Plan A: Something [local]",
      "",
      "- [ ] 1. **Do the thing** — with a description long enough to pass",
    ].join("\n");
    expect(parseMostRecentPlan(plan)?.nextStep?.anchor).toBeUndefined();
  });

  it("reads the anchor from the latest plan, not an earlier one", () => {
    const two = [
      PLAN,
      "",
      "## Plan B: Follow-up [galaxy]",
      "",
      "- [ ] 1. **Annotate variants** {#plan-b-step-1} — snpEff annotation run",
    ].join("\n");
    expect(parseMostRecentPlan(two)?.nextStep?.anchor).toBe("plan-b-step-1");
  });

  it("spells the anchor the way a notebook_anchor is spelled -- no braces, no hash", () => {
    const anchor = parseMostRecentPlan(PLAN)?.nextStep?.anchor;
    expect(anchor).not.toContain("#");
    expect(anchor).not.toContain("{");
  });
});

describe("state.currentStepAnchor", () => {
  beforeEach(() => {
    resetState();
  });

  it("starts null and survives a round trip", () => {
    expect(getCurrentStepAnchor()).toBeNull();
    setCurrentStepAnchor("plan-a-step-2");
    expect(getCurrentStepAnchor()).toBe("plan-a-step-2");
    expect(getState().currentStepAnchor).toBe("plan-a-step-2");
  });

  it("treats an empty or whitespace anchor as no anchor", () => {
    setCurrentStepAnchor("   ");
    expect(getCurrentStepAnchor()).toBeNull();
    setCurrentStepAnchor("");
    expect(getCurrentStepAnchor()).toBeNull();
  });

  it("trims so the stored value matches what a block would carry", () => {
    setCurrentStepAnchor("  plan-a-step-2  ");
    expect(getCurrentStepAnchor()).toBe("plan-a-step-2");
  });

  it("is cleared by a session reset, so an anchor never crosses sessions", () => {
    setCurrentStepAnchor("plan-a-step-2");
    resetState();
    expect(getCurrentStepAnchor()).toBeNull();
  });
});
