/**
 * Notebooks outlive releases, and a CLI and a bundled desktop app can be
 * different versions pointed at the same notebook.md. Every typed block has to
 * read the same under `loom-*` and `orbit-*`, and every upsert has to converge
 * a mixed notebook onto one block per key under the current write prefix.
 */

import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_FENCE_READ_PREFIXES,
  NOTEBOOK_FENCE_WRITE_PREFIX,
  isNotebookFenceOpen,
  notebookFenceOpen,
} from "../shared/notebook-fences.js";
import {
  applyInvocationUpdates,
  findInvocationBlocks,
  findSessionSummaryBlocks,
  renderInvocationYaml,
  renderSessionSummaryYaml,
  upsertInvocationBlock,
  upsertSessionSummaryBlock,
  type InvocationYaml,
  type SessionSummaryYaml,
} from "../extensions/loom/notebook-writer";
import {
  applyJobPollUpdate,
  findJobBlocks,
  renderJobYaml,
  upsertJobBlock,
  type JobYaml,
} from "../extensions/loom/galaxy-job-block";
import {
  findGalaxyPageBlocks,
  renderGalaxyPageBlock,
  stripGalaxyPageBlocks,
  upsertGalaxyPageBlock,
  type GalaxyPageBindingYaml,
} from "../extensions/loom/galaxy-page-binding";
import {
  galaxyMarkdownToLoom,
  loomToGalaxyMarkdown,
} from "../extensions/loom/galaxy-markdown-adapter";

const W = NOTEBOOK_FENCE_WRITE_PREFIX;

/** Re-fence a rendered block under another prefix. */
function as(prefix: string, block: string): string {
  return block.replace(/^```[a-z]+-/, "```" + prefix + "-");
}

function fenceCount(content: string, kind: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of content.split("\n")) {
    for (const p of NOTEBOOK_FENCE_READ_PREFIXES) {
      if (line.trim() === "```" + p + "-" + kind) counts[p] = (counts[p] ?? 0) + 1;
    }
  }
  return counts;
}

const inv = (o: Partial<InvocationYaml> = {}): InvocationYaml => ({
  invocationId: "inv-1",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "Align reads",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
  ...o,
});

const session = (o: Partial<SessionSummaryYaml> = {}): SessionSummaryYaml => ({
  id: "sess-1",
  startedAt: "2026-09-01T10:00:00Z",
  endedAt: "2026-09-01T11:00:00Z",
  notebook: "notebook.md",
  orphanedActiveSteps: 0,
  ...o,
});

const job = (o: Partial<JobYaml> = {}): JobYaml => ({
  jobId: "job-1",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-2",
  label: "FastQC",
  toolId: "fastqc",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
  ...o,
});

const binding = (o: Partial<GalaxyPageBindingYaml> = {}): GalaxyPageBindingYaml => ({
  pageId: "page-1",
  pageSlug: "my-page",
  galaxyServerUrl: "https://usegalaxy.org",
  historyId: "hist-1",
  lastSyncedRevision: "rev-1",
  boundAt: "2026-09-01T10:00:00Z",
  ...o,
});

interface Case<T> {
  kind: "invocation" | "session" | "job" | "galaxy-page";
  render: (v: T) => string;
  find: (content: string) => unknown[];
  upsert: (content: string, v: T) => string;
  a: T;
  aUpdated: T;
  b: T;
}

const cases: Case<never>[] = [
  {
    kind: "invocation",
    render: renderInvocationYaml,
    find: findInvocationBlocks,
    upsert: upsertInvocationBlock,
    a: inv(),
    aUpdated: inv({ status: "completed", summary: "done" }),
    b: inv({ invocationId: "inv-2", label: "Other" }),
  } as Case<InvocationYaml>,
  {
    kind: "session",
    render: renderSessionSummaryYaml,
    find: findSessionSummaryBlocks,
    upsert: upsertSessionSummaryBlock,
    a: session(),
    aUpdated: session({ endedAt: "2026-09-01T12:00:00Z", orphanedActiveSteps: 2 }),
    b: session({ id: "sess-2" }),
  } as Case<SessionSummaryYaml>,
  {
    kind: "job",
    render: renderJobYaml,
    find: findJobBlocks,
    upsert: upsertJobBlock,
    a: job(),
    aUpdated: job({ status: "completed", galaxyState: "ok" }),
    b: job({ jobId: "job-2", label: "Trim" }),
  } as Case<JobYaml>,
  {
    kind: "galaxy-page",
    render: renderGalaxyPageBlock,
    find: findGalaxyPageBlocks,
    upsert: upsertGalaxyPageBlock,
    a: binding(),
    aUpdated: binding({ lastSyncedRevision: "rev-2" }),
    b: binding({ pageId: "page-2", historyId: "hist-2" }),
  } as Case<GalaxyPageBindingYaml>,
] as unknown as Case<never>[];

describe("shared fence helpers", () => {
  it("writes under the one write prefix and reads under every prefix", () => {
    expect(notebookFenceOpen("job")).toBe("```" + W + "-job");
    expect(isNotebookFenceOpen("```loom-job", "job")).toBe(true);
    expect(isNotebookFenceOpen("  ```orbit-job  ", "job")).toBe(true);
    expect(isNotebookFenceOpen("```orbit-jobs", "job")).toBe(false);
    expect(isNotebookFenceOpen("```other-job", "job")).toBe(false);
  });
});

describe.each(cases)("$kind blocks", (c) => {
  const aLoom = as("loom", c.render(c.a)).trimEnd();
  const aOrbit = as("orbit", c.render(c.a)).trimEnd();
  const bLoom = as("loom", c.render(c.b)).trimEnd();
  const bOrbit = as("orbit", c.render(c.b)).trimEnd();

  it("parses the same structure under either prefix", () => {
    const loom = `# NB\n\n${aLoom}\n\n${bLoom}\n`;
    const orbit = `# NB\n\n${aOrbit}\n\n${bOrbit}\n`;
    expect(c.find(orbit)).toHaveLength(2);
    expect(c.find(orbit)).toEqual(c.find(loom));
    expect(c.find(`${aLoom}\n\n${bOrbit}\n`)).toEqual(c.find(loom));
  });

  const fixtures: Record<string, string> = {
    "loom-only": `# NB\n\nprose\n\n${aLoom}\n\nmore prose\n\n${bLoom}\n`,
    "orbit-only": `# NB\n\nprose\n\n${aOrbit}\n\nmore prose\n\n${bOrbit}\n`,
    mixed: `# NB\n\nprose\n\n${aOrbit}\n\nmore prose\n\n${bLoom}\n\n${aLoom}\n`,
  };

  it.each(Object.entries(fixtures))(
    "upserting into a %s notebook leaves one block per key",
    (_name, content) => {
      const next = c.upsert(content, c.aUpdated);
      const found = c.find(next);
      expect(found).toHaveLength(2);
      expect(found[0]).toEqual(c.find(c.render(c.aUpdated))[0]);
      expect(found[1]).toEqual(c.find(c.render(c.b))[0]);
      // The key keeps its first position, so prose around it stays put.
      expect(next.indexOf(notebookFenceOpen(c.kind))).toBeLessThan(next.indexOf("more prose"));
      expect(next).toContain("prose\n\n" + c.render(c.aUpdated).trimEnd() + "\n\nmore prose");
      // Idempotent: a second write of the same record changes nothing.
      expect(c.upsert(next, c.aUpdated)).toBe(next);
      // Rewriting the other key leaves this one alone.
      const withB = c.upsert(next, c.b);
      expect(c.find(withB)).toEqual(found);
    },
  );

  it("rewrites a matched block under the write prefix", () => {
    const next = c.upsert(fixtures.mixed, c.aUpdated);
    const counts = fenceCount(next, c.kind);
    const other = W === "loom" ? "orbit" : "loom";
    // b is still under whatever prefix it was written with; a converged to W.
    expect(counts[W]).toBe(W === "loom" ? 2 : 1);
    expect(counts[other] ?? 0).toBe(W === "loom" ? 0 : 1);
  });
});

describe("poll updates find blocks under either prefix", () => {
  it("applies an invocation poll to an orbit block", () => {
    const content = `# NB\n\n${as("orbit", renderInvocationYaml(inv()))}`;
    const { content: next, applied } = applyInvocationUpdates(content, [
      {
        invocationId: "inv-1",
        totalSteps: 3,
        completedSteps: 3,
        totalJobs: 3,
        completedJobs: 3,
        failedJobs: 0,
        lastPolledAt: new Date().toISOString(),
        transition: { status: "completed", summary: "ok" },
      },
    ]);
    expect(applied).toEqual(["inv-1"]);
    expect(findInvocationBlocks(next)).toHaveLength(1);
    expect(findInvocationBlocks(next)[0].status).toBe("completed");
    expect(fenceCount(next, "invocation")).toEqual({ [W]: 1 });
  });

  it("applies a job poll to an orbit block", () => {
    const content = `# NB\n\n${as("orbit", renderJobYaml(job()))}`;
    const next = applyJobPollUpdate(content, {
      jobId: "job-1",
      status: "completed",
      galaxyState: "ok",
      lastPolledAt: "2026-09-01T10:05:00Z",
    });
    expect(findJobBlocks(next)).toHaveLength(1);
    expect(findJobBlocks(next)[0].status).toBe("completed");
    expect(fenceCount(next, "job")).toEqual({ [W]: 1 });
  });
});

describe("Galaxy Pages sync path", () => {
  it("strips binding blocks under either prefix before push", () => {
    const content = [
      "# NB",
      "",
      as("orbit", renderGalaxyPageBlock(binding())),
      as("loom", renderGalaxyPageBlock(binding({ pageId: "page-2" }))),
      "tail",
    ].join("\n");
    const stripped = stripGalaxyPageBlocks(content);
    expect(stripped).not.toContain("galaxy-page");
    expect(stripped).toContain("tail");
  });

  it("carries an orbit invocation fence through push and pull verbatim", () => {
    const body = `# NB\n\n${as("orbit", renderInvocationYaml(inv())).trimEnd()}\n\ntail\n`;
    const pushed = loomToGalaxyMarkdown(body);
    expect(pushed).not.toContain("```orbit-invocation");
    expect(pushed).toMatch(new RegExp(`^\\[${W}-invocation:v1\\]: #${W} "`, "m"));
    expect(galaxyMarkdownToLoom(pushed)).toBe(body);
  });

  it("decodes a carrier labelled with either prefix", () => {
    const block = as("orbit", renderInvocationYaml(inv())).trimEnd();
    const b64 = Buffer.from(block, "utf8").toString("base64");
    for (const p of NOTEBOOK_FENCE_READ_PREFIXES) {
      const page = [
        "# NB",
        "```galaxy",
        "invocation_outputs(invocation_id=inv-1)",
        "```",
        `[${p}-invocation:v1]: #${p} "${b64}"`,
      ].join("\n");
      expect(galaxyMarkdownToLoom(page)).toBe(`# NB\n${block}`);
    }
  });
});
