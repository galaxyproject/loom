/**
 * Shape-match check for the failed-invocation hint.
 *
 * `invocation-failure-hint.test.ts` asserts the hint's behaviour against a
 * payload the test builds by hand. That proves the logic but not the premise:
 * if `checkInvocations` emits a different shape than the one we transcribed
 * from its source, those tests still pass and the hint silently never fires in
 * production. So drive the real `checkInvocations` against a mocked Galaxy and
 * run the hook over whatever it actually returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import * as galaxyApi from "../extensions/loom/galaxy-api";
import { checkInvocations } from "../extensions/loom/tools";
import {
  appendInvocationFailureHint,
  INVOCATION_FAILURE_REFERENCE,
  JOB_FAILURE_REFERENCE,
} from "../extensions/loom/invocation-failure-hint";
import { readVendoredSkill } from "../extensions/loom/vendor-skills";

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "BWA alignment",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

function galaxyInvocation(jobStates: string[]) {
  return {
    id: "inv-1",
    state: "scheduled",
    workflow_id: "wf-1",
    history_id: "hist-1",
    steps: [
      {
        id: "step-1",
        order_index: 0,
        state: null,
        jobs: jobStates.map((state, i) => ({ id: `job-${i}`, state, tool_id: "bwa_mem" })),
      },
    ],
  };
}

describe("the paths the hint hands the agent actually resolve", () => {
  // The hint names two files as bare strings. Nothing else ties those strings
  // to the vendor manifest, so a rename during a re-sync would leave the agent
  // fetching a 404 exactly when it is trying to explain a failure.
  it.each([
    ["invocation-level", INVOCATION_FAILURE_REFERENCE],
    ["job-level", JOB_FAILURE_REFERENCE],
  ])("%s reference is readable and non-trivial", (_label, target) => {
    const res = readVendoredSkill(target);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text.length).toBeGreaterThan(1000);
  });

  it("the invocation reference really carries the reason table the hint promises", () => {
    const res = readVendoredSkill(INVOCATION_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The hint sells "what the invocation message reasons and states mean".
    for (const reason of ["dataset_failed", "job_failed", "output_not_found", "when_not_boolean"]) {
      expect(res.text).toContain(reason);
    }
  });

  it("the job reference really carries the stream/exit-code distinctions the hint promises", () => {
    const res = readVendoredSkill(JOB_FAILURE_REFERENCE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const field of ["job_messages", "exit_code", "tool_stderr", "job_stderr"]) {
      expect(res.text).toContain(field);
    }
  });
});

describe("failed-invocation hint against real checkInvocations output", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-hint-integration-"));
    nbPath = join(dir, "notebook.md");
    process.env.GALAXY_URL = "https://usegalaxy.org";
    process.env.GALAXY_API_KEY = "test-key";
    setNotebookPath(nbPath);
  });

  afterEach(() => {
    resetState();
    vi.restoreAllMocks();
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires on the payload a real failing invocation produces", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyInvocation(["ok", "error"]) as never);

    const result = await checkInvocations(undefined);
    const original = result.content[0].text;
    const hinted = appendInvocationFailureHint(result.content);

    expect(hinted).not.toBeNull();
    expect(hinted![0].text).toContain(INVOCATION_FAILURE_REFERENCE);
    // The hint appends; the original payload survives byte-for-byte in front of it.
    expect(hinted![0].text.startsWith(original)).toBe(true);
  });

  it("gives the agent job counts but no explanation -- which is why the hint exists", async () => {
    // The human-readable "Workflow failed: N job(s) errored" summary rides the
    // transition into the notebook YAML, NOT into the tool result. All the
    // agent sees is `autoAction: "failed"` plus per-state counts -- no reason,
    // no failing tool, no message. So "job error counts alone do not identify
    // the failure, read the invocation messages and job detail" is a real
    // instruction rather than filler. If a summary ever does start travelling
    // in this payload, this test should fail and the hint text be revisited.
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyInvocation(["ok", "error"]) as never);

    const parsed = JSON.parse((await checkInvocations(undefined)).content[0].text);
    const entry = parsed.results[0];

    expect(entry.autoAction).toBe("failed");
    expect(entry.jobSummary).toEqual({ ok: 1, running: 0, queued: 0, error: 1, other: 0 });
    expect(JSON.stringify(entry)).not.toContain("Workflow failed");
    expect(entry).not.toHaveProperty("summary");
  });

  it("stays silent on a real completed invocation", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyInvocation(["ok", "ok"]) as never);

    const result = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(result.content)).toBeNull();
  });

  it("stays silent while jobs are still running", async () => {
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(
      galaxyInvocation(["ok", "running"]) as never,
    );

    const result = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(result.content)).toBeNull();
  });

  it("does not re-fire on a later poll of an already-failed invocation", async () => {
    // The transition is announced once: checkInvocations clears autoAction when
    // it didn't actually record the change. A user asking the agent to re-check
    // an already-failed run should not get the triage nudge a second time.
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyInvocation(["ok", "error"]) as never);

    const first = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(first.content)).not.toBeNull();

    const second = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(second.content)).toBeNull();
  });

  it("stays silent when the notebook has no invocation blocks at all", async () => {
    writeFileSync(nbPath, "# Notebook\n\nNothing here yet.\n", "utf-8");
    const result = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(result.content)).toBeNull();
  });

  it("stays silent when Galaxy itself is unreachable", async () => {
    // A poll failure is not a run failure -- autoAction becomes `check_error:`,
    // and triage guidance would be actively misleading.
    writeFileSync(nbPath, renderInvocationYaml(invocation()), "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockRejectedValue(new Error("Galaxy API 503"));

    const result = await checkInvocations(undefined);
    expect(appendInvocationFailureHint(result.content)).toBeNull();
  });
});
