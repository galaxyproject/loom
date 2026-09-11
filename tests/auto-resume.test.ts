import { afterEach, describe, expect, it } from "vitest";
import {
  buildResumePrompt,
  isAutoResumeEnabled,
  isResumableOutcome,
} from "../extensions/loom/auto-resume.js";

const ORIGINAL = process.env.LOOM_AUTO_RESUME;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LOOM_AUTO_RESUME;
  else process.env.LOOM_AUTO_RESUME = ORIGINAL;
});

describe("isAutoResumeEnabled", () => {
  it("is off unless asked for -- unattended turns cost real money", () => {
    delete process.env.LOOM_AUTO_RESUME;
    // No config file in the test env, so this exercises the default path.
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("turns on with the env override", () => {
    process.env.LOOM_AUTO_RESUME = "1";
    expect(isAutoResumeEnabled()).toBe(true);
  });

  it("lets the env override force it off over an on-config", () => {
    process.env.LOOM_AUTO_RESUME = "0";
    expect(isAutoResumeEnabled()).toBe(false);
  });

  it("ignores values that are neither 1 nor 0", () => {
    process.env.LOOM_AUTO_RESUME = "yes";
    expect(isAutoResumeEnabled()).toBe(false);
  });
});

describe("buildResumePrompt", () => {
  it("names the run and asks for verification on success", () => {
    const p = buildResumePrompt("BWA alignment", "completed");
    expect(p).toContain("BWA alignment");
    expect(p).toMatch(/finished successfully/i);
    expect(p).toMatch(/verify/i);
  });

  it("asks for investigation on failure and carries the detail", () => {
    const p = buildResumePrompt("fastp", "failed", "2 job error(s)");
    expect(p).toContain("fastp");
    expect(p).toContain("2 job error(s)");
    expect(p).toMatch(/investigate/i);
  });

  it("tells the agent to stop, so an unattended turn cannot run away", () => {
    // The point: a resumed turn verifies and reports. It must not read as
    // licence to start the next step while nobody is watching.
    for (const outcome of ["completed", "failed"] as const) {
      const p = buildResumePrompt("x", outcome);
      expect(p).toMatch(/STOP/);
      expect(p).toMatch(/do not start the next step/i);
    }
  });

  it("says the message was automatic, so the agent knows nobody may be there", () => {
    expect(buildResumePrompt("x", "completed")).toMatch(/automatically/i);
  });
});

describe("isResumableOutcome", () => {
  it("wakes the agent for a run that finished or failed", () => {
    expect(isResumableOutcome("completed")).toBe(true);
    expect(isResumableOutcome("failed")).toBe(true);
  });

  // The expensive mistake this prevents: the user cancels a job, or a workflow
  // conditional skips a step, and an unattended agent burns a turn
  // "investigating" a decision that was deliberate.
  it("leaves a cancelled or skipped run alone", () => {
    expect(isResumableOutcome("cancelled")).toBe(false);
    expect(isResumableOutcome("skipped")).toBe(false);
  });

  it("never wakes the agent for a run that is still going", () => {
    expect(isResumableOutcome("in_progress")).toBe(false);
  });
});
