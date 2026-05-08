import { describe, it, expect } from "vitest";
import {
  renderInvocationYaml,
  findInvocationBlocks,
  upsertInvocationBlock,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";

function makeInvocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "BWA alignment",
    submittedAt: "2026-04-25T15:30:00Z",
    status: "in_progress",
    summary: "",
    ...overrides,
  };
}

describe("renderInvocationYaml", () => {
  it("renders a fenced loom-invocation block with all fields", () => {
    const out = renderInvocationYaml(makeInvocation());
    expect(out).toContain("```loom-invocation");
    expect(out).toContain("invocation_id: inv-1");
    expect(out).toContain("galaxy_server_url: https://usegalaxy.org");
    expect(out).toContain("notebook_anchor: plan-a-step-1");
    expect(out).toContain("label: BWA alignment");
    expect(out).toContain("submitted_at: 2026-04-25T15:30:00Z");
    expect(out).toContain("status: in_progress");
    expect(out.trim().endsWith("```")).toBe(true);
  });

  it("escapes labels containing colons", () => {
    const out = renderInvocationYaml(makeInvocation({ label: "Step: BWA alignment" }));
    expect(out).toContain('label: "Step: BWA alignment"');
  });

  it("escapes summaries containing newlines and quotes", () => {
    const out = renderInvocationYaml(makeInvocation({ summary: 'failed: "tool crashed"' }));
    expect(out).toContain('summary: "failed: \\"tool crashed\\""');
  });
});

describe("findInvocationBlocks", () => {
  it("returns empty array when no blocks present", () => {
    expect(findInvocationBlocks("# A notebook with no invocations\n")).toEqual([]);
  });

  it("parses a single block back into the original record", () => {
    const original = makeInvocation();
    const md = "# Plan A\n\nSome prose.\n\n" + renderInvocationYaml(original);
    const parsed = findInvocationBlocks(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      invocationId: original.invocationId,
      galaxyServerUrl: original.galaxyServerUrl,
      notebookAnchor: original.notebookAnchor,
      label: original.label,
      submittedAt: original.submittedAt,
      status: original.status,
    });
  });

  it("parses multiple blocks in document order", () => {
    const a = makeInvocation({ invocationId: "inv-a", label: "A" });
    const b = makeInvocation({ invocationId: "inv-b", label: "B", status: "completed" });
    const md = renderInvocationYaml(a) + "\nSome interlude prose\n\n" + renderInvocationYaml(b);
    const parsed = findInvocationBlocks(md);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].invocationId).toBe("inv-a");
    expect(parsed[1].invocationId).toBe("inv-b");
    expect(parsed[1].status).toBe("completed");
  });

  it("ignores other fenced code blocks", () => {
    const md = [
      "```yaml",
      "key: value",
      "```",
      "",
      renderInvocationYaml(makeInvocation()),
      "",
      "```bash",
      "echo hi",
      "```",
    ].join("\n");
    const parsed = findInvocationBlocks(md);
    expect(parsed).toHaveLength(1);
  });

  it("skips malformed blocks (missing required fields)", () => {
    const md = [
      "```loom-invocation",
      "invocation_id: incomplete",
      "label: missing other fields",
      "```",
    ].join("\n");
    const parsed = findInvocationBlocks(md);
    expect(parsed).toEqual([]);
  });

  it("recovers escaped labels with colons round-trip", () => {
    const original = makeInvocation({ label: "Step: BWA mem" });
    const md = renderInvocationYaml(original);
    const [parsed] = findInvocationBlocks(md);
    expect(parsed.label).toBe("Step: BWA mem");
  });
});

describe("upsertInvocationBlock", () => {
  it("appends a new block when the invocation isn't present", () => {
    const before = "# Plan A\n\nProse\n";
    const updated = upsertInvocationBlock(before, makeInvocation());
    const blocks = findInvocationBlocks(updated);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].invocationId).toBe("inv-1");
    expect(updated.startsWith("# Plan A")).toBe(true);
  });

  it("appends without a leading newline when the file is empty", () => {
    const updated = upsertInvocationBlock("", makeInvocation());
    expect(updated.startsWith("```loom-invocation")).toBe(true);
  });

  it("replaces in place when invocation_id already exists", () => {
    const original = makeInvocation();
    const initial = "# Plan A\n\n" + renderInvocationYaml(original) + "\nMore prose after.\n";
    const updated = upsertInvocationBlock(initial, {
      ...original,
      status: "completed",
      summary: "ok",
    });
    const blocks = findInvocationBlocks(updated);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    expect(blocks[0].summary).toBe("ok");
    expect(updated).toContain("More prose after.");
  });

  it("preserves other invocation blocks when replacing one", () => {
    const a = makeInvocation({ invocationId: "inv-a", label: "A" });
    const b = makeInvocation({ invocationId: "inv-b", label: "B" });
    const initial = renderInvocationYaml(a) + "\n" + renderInvocationYaml(b);

    const updated = upsertInvocationBlock(initial, { ...a, status: "failed", summary: "boom" });
    const parsed = findInvocationBlocks(updated);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((p) => p.invocationId === "inv-a")?.status).toBe("failed");
    expect(parsed.find((p) => p.invocationId === "inv-b")?.label).toBe("B");
  });
});

describe("progress counters", () => {
  it("round-trips total_steps / completed_steps / total_jobs / completed_jobs / failed_jobs / last_polled_at", () => {
    const original = makeInvocation({
      totalSteps: 5,
      completedSteps: 3,
      totalJobs: 27,
      completedJobs: 12,
      failedJobs: 0,
      lastPolledAt: "2026-04-29T14:31:12Z",
    });
    const yaml = renderInvocationYaml(original);
    const [parsed] = findInvocationBlocks(yaml);
    expect(parsed.totalSteps).toBe(5);
    expect(parsed.completedSteps).toBe(3);
    expect(parsed.totalJobs).toBe(27);
    expect(parsed.completedJobs).toBe(12);
    expect(parsed.failedJobs).toBe(0);
    expect(parsed.lastPolledAt).toBe("2026-04-29T14:31:12Z");
  });

  it("omits counter fields when undefined (older blocks round-trip cleanly)", () => {
    const yaml = renderInvocationYaml(makeInvocation());
    expect(yaml).not.toContain("total_steps");
    expect(yaml).not.toContain("completed_jobs");
    expect(yaml).not.toContain("last_polled_at");
    const [parsed] = findInvocationBlocks(yaml);
    expect(parsed.totalSteps).toBeUndefined();
    expect(parsed.completedJobs).toBeUndefined();
  });
});
