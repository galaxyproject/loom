/**
 * Regression tests for #391 — the invocation poller silently clobbering
 * notebook writes made outside Loom's in-process lock (the agent's `edit` /
 * `bash` appends).
 *
 * The bug: checkInvocations did read -> N x Galaxy GET -> whole-file write,
 * all inside withNotebookLock, rendering the final file from the *pre-poll*
 * snapshot. withNotebookLock only serializes Loom's own writers, so anything
 * written to notebook.md during those seconds of network I/O was dropped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import * as notebookWriter from "../extensions/loom/notebook-writer";
import {
  findInvocationBlocks,
  renderInvocationYaml,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import * as galaxyApi from "../extensions/loom/galaxy-api";
import { checkInvocations } from "../extensions/loom/tools";

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "QC workflow",
    submittedAt: "2026-04-25T00:00:00Z",
    status: "in_progress",
    ...overrides,
  };
}

/** A Galaxy invocation response whose single step holds `states` jobs. */
function galaxyResponse(id: string, states: string[]) {
  return {
    id,
    state: "scheduled",
    workflow_id: "wf-1",
    history_id: "hist-1",
    steps: [
      {
        id: "step-1",
        order_index: 0,
        state: null,
        jobs: states.map((state, i) => ({ id: `${id}-job-${i}`, state, tool_id: "fastqc" })),
      },
    ],
  };
}

describe("checkInvocations concurrency (#391)", () => {
  let dir: string;
  let nbPath: string;
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-invocation-race-"));
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

  it("keeps an out-of-band notebook write that lands while Galaxy is being polled", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");

    // Stand in for the agent appending a results section via bash/edit while
    // the poller is blocked on a Galaxy round trip. Those writes never take
    // withNotebookLock, so only ordering the I/O correctly can save them.
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      appendFileSync(nbPath, "\n### Marker comparison\n\nCD4 up, CD8 flat.\n", "utf-8");
      return galaxyResponse("inv-1", ["ok", "ok"]) as never;
    });

    await checkInvocations(undefined);

    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("### Marker comparison");
    expect(notebook).toContain("CD4 up, CD8 flat.");
    // …and the poll result still landed.
    expect(notebook).toContain("status: completed");
  });

  it("retries instead of clobbering when the notebook changes after the in-lock read", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(
      galaxyResponse("inv-1", ["ok", "ok"]) as never,
    );

    // Squeeze a writer into the remaining sub-millisecond window: let the
    // in-lock read (the 2nd readNotebook call) return content that is stale by
    // the time it lands. Only the staleness guard can catch this one.
    const realRead = notebookWriter.readNotebook;
    let reads = 0;
    vi.spyOn(notebookWriter, "readNotebook").mockImplementation(async (p: string) => {
      const content = await realRead(p);
      reads++;
      if (reads === 2)
        appendFileSync(nbPath, "\n### Late arrival\n\nwritten post-read.\n", "utf-8");
      return content;
    });

    await checkInvocations(undefined);

    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).toContain("### Late arrival");
    expect(notebook).toContain("status: completed");
  });

  it("lands the other blocks' updates when one Galaxy GET throws", async () => {
    writeFileSync(
      nbPath,
      renderInvocationYaml(invocation({ invocationId: "inv-1" })) +
        "\n" +
        renderInvocationYaml(
          invocation({
            invocationId: "inv-2",
            notebookAnchor: "plan-a-step-2",
            label: "Assembly",
          }),
        ),
      "utf-8",
    );
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async (path: string) => {
      if (path.includes("inv-1")) throw new Error("Galaxy API 502: bad gateway");
      return galaxyResponse("inv-2", ["ok"]) as never;
    });

    const result = await checkInvocations(undefined);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.checked).toBe(2);
    const failed = parsed.results.find((r: { invocationId: string }) => r.invocationId === "inv-1");
    expect(failed.invocationState).toBe("error_checking");
    expect(failed.autoAction).toContain("502");

    const blocks = findInvocationBlocks(readFileSync(nbPath, "utf-8"));
    expect(blocks.find((b) => b.invocationId === "inv-1")?.status).toBe("in_progress");
    expect(blocks.find((b) => b.invocationId === "inv-2")?.status).toBe("completed");
  });

  it("does not touch the notebook when every Galaxy GET fails", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockRejectedValue(new Error("Galaxy API 503"));
    const write = vi.spyOn(notebookWriter, "writeNotebook");

    const result = await checkInvocations(undefined);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0].invocationState).toBe("error_checking");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not resurrect a block deleted while Galaxy was polled, and reports no transition", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      // The agent pruned the block from the notebook mid-poll.
      writeFileSync(nbPath, "# Notes\n\nblock removed by the agent\n", "utf-8");
      return galaxyResponse("inv-1", ["ok"]) as never;
    });

    const result = await checkInvocations(undefined);

    const notebook = readFileSync(nbPath, "utf-8");
    expect(notebook).not.toContain("invocation_id: inv-1");
    expect(notebook).toContain("block removed by the agent");
    // Nothing was written, so the poller must not toast a completion for it.
    expect(JSON.parse(result.content[0].text).results[0].autoAction).toBeUndefined();
  });

  it("does not announce a transition another poller already recorded", async () => {
    // Seconds ahead, not years: a reading further out than any clock drift is a
    // hand edit, and applyInvocationUpdates stopped honouring those.
    const aheadOfUs = new Date(Date.now() + 5_000).toISOString();
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      // A second checker got there first with a strictly later reading.
      writeFileSync(
        nbPath,
        `# Notes\n\n${renderInvocationYaml(
          invocation({
            status: "completed",
            summary: "Workflow completed: 1 jobs succeeded",
            lastPolledAt: aheadOfUs,
          }),
        )}`,
        "utf-8",
      );
      return galaxyResponse("inv-1", ["ok"]) as never;
    });

    const result = await checkInvocations(undefined);

    expect(JSON.parse(result.content[0].text).results[0].autoAction).toBeUndefined();
    expect(readFileSync(nbPath, "utf-8")).toContain(`last_polled_at: ${aheadOfUs}`);
  });

  it("does not re-announce a completion another poll recorded first", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      // An overlapping poll finished first with the same news and, unlike the
      // stale-poll case, a perfectly ordinary earlier timestamp.
      writeFileSync(
        nbPath,
        `# Notes\n\n${renderInvocationYaml(
          invocation({
            status: "completed",
            summary: "Workflow completed: 1 jobs succeeded",
            lastPolledAt: "2026-04-25T00:00:01Z",
          }),
        )}`,
        "utf-8",
      );
      return galaxyResponse("inv-1", ["ok"]) as never;
    });

    const result = await checkInvocations(undefined);

    // The transition was already recorded, so it isn't ours to toast…
    expect(JSON.parse(result.content[0].text).results[0].autoAction).toBeUndefined();
    // …but the fresh counters still land.
    const block = findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.status).toBe("completed");
    expect(block.lastPolledAt).not.toBe("2026-04-25T00:00:01Z");
  });

  it("keeps an agent edit to the block's own fields made during the poll", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      // The agent relabelled and re-anchored the block while we were waiting.
      writeFileSync(
        nbPath,
        `# Notes\n\n${renderInvocationYaml(
          invocation({ label: "Relabelled by the agent", notebookAnchor: "plan-b-step-4" }),
        )}`,
        "utf-8",
      );
      return galaxyResponse("inv-1", ["ok", "running"]) as never;
    });

    await checkInvocations(undefined);

    const block = findInvocationBlocks(readFileSync(nbPath, "utf-8"))[0];
    expect(block.label).toBe("Relabelled by the agent");
    expect(block.notebookAnchor).toBe("plan-b-step-4");
    // …and the counters this poll produced still landed.
    expect(block.completedJobs).toBe(1);
    expect(block.totalJobs).toBe(2);
    expect(block.status).toBe("in_progress");
  });

  it("leaves no scratch files behind", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(galaxyResponse("inv-1", ["ok"]) as never);

    await checkInvocations(undefined);

    expect(readdirSync(dir)).toEqual(["notebook.md"]);
  });

  it("holds no lock across the Galaxy GETs", async () => {
    writeFileSync(nbPath, `# Notes\n\n${renderInvocationYaml(invocation())}`, "utf-8");

    let lockFreeDuringPoll = false;
    vi.spyOn(galaxyApi, "galaxyGet").mockImplementation(async () => {
      // A competing Loom writer must be able to take the lock while we are
      // waiting on Galaxy — that is what shrinks the clobber window. Race it
      // against a timer so a still-held lock fails the assert instead of
      // deadlocking the test.
      const acquired = new Promise<boolean>((resolve) => {
        void notebookWriter.withNotebookLock(nbPath, async () => resolve(true));
      });
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50));
      lockFreeDuringPoll = await Promise.race([acquired, timeout]);
      return galaxyResponse("inv-1", ["ok"]) as never;
    });

    await checkInvocations(undefined);

    expect(lockFreeDuringPoll).toBe(true);
  });
});
