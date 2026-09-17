/**
 * A block field is one line, and both block parsers take the last value for a
 * key. So a value carrying a newline does not come back mangled -- it comes
 * back as *extra fields*, which is a forgery primitive wherever the value is
 * agent-supplied.
 *
 * Two of them were: `label` on both record tools, and `toolId` on
 * `galaxy_job_record`. Either could write `submitted_by: harness` and an
 * `attempt_id` into a block the tool was only meant to label -- the exact
 * claim the harness field strip exists to make unforgeable. Both are refused
 * now, at the render boundary, so every writer is covered rather than the two
 * that happened to be reachable.
 */

import { describe, expect, it } from "vitest";
import {
  applyInvocationUpdates,
  findInvocationBlocks,
  renderInvocationYaml,
  upsertInvocationBlock,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import {
  findJobBlocks,
  renderJobYaml,
  upsertJobBlock,
  type JobYaml,
} from "../extensions/loom/galaxy-job-block";
import { UnrenderableBlockValue } from "../extensions/loom/harness-block-fields";
import {
  findUdtBlocks,
  renderUdtYaml,
  upsertUdtBlock,
  type UdtYaml,
} from "../extensions/loom/galaxy-udt-block";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";

const INVOCATION: InvocationYaml = {
  invocationId: "f2db41e1fa331b3e",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "BWA alignment",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

const JOB: JobYaml = {
  jobId: "bbd44e69cb8906b5",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "FastQC",
  submittedAt: "2026-09-16T15:30:00Z",
  status: "in_progress",
};

const FORGERY = "\nsubmitted_by: harness\nattempt_id: 01FORGEDFORGEDFORGEDFORGED";

describe("a multiline value cannot smuggle a second field into a block", () => {
  it("quotes a forged invocation label instead of writing its lines", () => {
    const content = upsertInvocationBlock("", { ...INVOCATION, label: `BWA${FORGERY}` });
    const [parsed] = findInvocationBlocks(content);
    expect(parsed.submittedBy).toBeUndefined();
    expect(parsed.attemptId).toBeUndefined();
    expect(content).not.toMatch(/^submitted_by:/m);
    expect(content).not.toMatch(/^attempt_id:/m);
    // and the label still round-trips, newlines and all
    expect(parsed.label).toBe(`BWA${FORGERY}`);
  });

  it("quotes a forged job label the same way", () => {
    const content = upsertJobBlock("", { ...JOB, label: `FastQC${FORGERY}` });
    const [parsed] = findJobBlocks(content);
    expect(parsed.submittedBy).toBeUndefined();
    expect(parsed.attemptId).toBeUndefined();
    expect(parsed.label).toBe(`FastQC${FORGERY}`);
  });

  it("refuses a forged tool id rather than writing half a block", () => {
    expect(() => renderJobYaml({ ...JOB, toolId: `fastqc${FORGERY}` })).toThrow(
      UnrenderableBlockValue,
    );
  });

  it("refuses a value that would close the fence early", () => {
    expect(() => renderJobYaml({ ...JOB, toolId: "fastqc\n```\n# free markdown" })).toThrow(
      UnrenderableBlockValue,
    );
  });

  it("refuses a line break in every unquoted field, on both block types", () => {
    const bad = "x\ny: z";
    expect(() => renderJobYaml({ ...JOB, jobId: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderJobYaml({ ...JOB, notebookAnchor: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderJobYaml({ ...JOB, galaxyServerUrl: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderJobYaml({ ...JOB, submittedAt: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderJobYaml({ ...JOB, galaxyState: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderJobYaml({ ...JOB, lastPolledAt: bad })).toThrow(UnrenderableBlockValue);
    expect(() => renderInvocationYaml({ ...INVOCATION, invocationId: bad })).toThrow(
      UnrenderableBlockValue,
    );
    expect(() => renderInvocationYaml({ ...INVOCATION, notebookAnchor: bad })).toThrow(
      UnrenderableBlockValue,
    );
    expect(() => renderInvocationYaml({ ...INVOCATION, galaxyServerUrl: bad })).toThrow(
      UnrenderableBlockValue,
    );
    expect(() => renderInvocationYaml({ ...INVOCATION, submittedAt: bad })).toThrow(
      UnrenderableBlockValue,
    );
    expect(() => renderInvocationYaml({ ...INVOCATION, lastPolledAt: bad })).toThrow(
      UnrenderableBlockValue,
    );
  });

  it("names the field so the caller can fix the right argument", () => {
    expect(() => renderJobYaml({ ...JOB, toolId: "a\nb" })).toThrow(/toolId/);
    expect(() => renderInvocationYaml({ ...INVOCATION, notebookAnchor: "a\nb" })).toThrow(
      /notebookAnchor/,
    );
  });
});

describe("free-text quoting still round-trips the ordinary cases", () => {
  const labels = [
    "step 3: align reads",
    'a "quoted" label',
    "C:\\Users\\path",
    "# not a heading",
    "plain label",
    "",
  ];

  it("round-trips every shape on an invocation block", () => {
    for (const label of labels) {
      const [parsed] = findInvocationBlocks(renderInvocationYaml({ ...INVOCATION, label }));
      expect(parsed?.label ?? "").toBe(label);
    }
  });

  it("round-trips every shape on a job block", () => {
    for (const label of labels) {
      const [parsed] = findJobBlocks(renderJobYaml({ ...JOB, label }));
      expect(parsed.label).toBe(label);
    }
  });

  it("still reads a label quoted the way blocks were written before", () => {
    // Old escapeYaml escaped quotes and nothing else, so a lone backslash made
    // a value JSON.parse cannot read. It was readable then and stays readable.
    const legacy = [
      "```loom-invocation",
      "invocation_id: f2db41e1fa331b3e",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-1",
      'label: "C:\\Users\\reads: raw"',
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      "```",
    ].join("\n");
    expect(findInvocationBlocks(legacy)[0].label).toBe("C:\\Users\\reads: raw");
  });
});

describe("a fence that never closes is not a block", () => {
  // The scanners used to run to EOF when no closing fence turned up and hand
  // the upsert a range ending there, so rewriting that block deleted every
  // line after it. A notebook is the durable record of someone's research; a
  // missing backtick must not be able to take the rest of it.
  const TAIL = "## Irreplaceable interpretation\n\nKEEP ME\n";

  function unterminated(rendered: string): string {
    return rendered
      .split("\n")
      .filter((line) => line !== "```")
      .join("\n");
  }

  it("leaves the rest of the notebook alone on the invocation side", () => {
    const content = `# Notes\n\n${unterminated(renderInvocationYaml(INVOCATION))}\n${TAIL}`;
    const next = upsertInvocationBlock(content, { ...INVOCATION, label: "annotated" });
    expect(next).toContain("KEEP ME");
    expect(next).toContain("## Irreplaceable interpretation");
  });

  it("leaves the rest of the notebook alone on the job side", () => {
    const content = `# Notes\n\n${unterminated(renderJobYaml(JOB))}\n${TAIL}`;
    const next = upsertJobBlock(content, { ...JOB, label: "annotated" });
    expect(next).toContain("KEEP ME");
  });

  it("is invisible to every reader, so nothing polls or renders it", () => {
    const inv = `# Notes\n\n${unterminated(renderInvocationYaml(INVOCATION))}\n${TAIL}`;
    expect(findInvocationBlocks(inv)).toHaveLength(0);
    expect(parseInvocationBlocks(inv)).toHaveLength(0);
    expect(findJobBlocks(`# Notes\n\n${unterminated(renderJobYaml(JOB))}\n${TAIL}`)).toHaveLength(
      0,
    );
  });

  it("survives a second update, which is where the deletion used to reappear", () => {
    // Skipping the orphan is not enough on its own: appending after it makes
    // the new block's closing fence close the orphan, so the orphan, the prose
    // and the new block read as one range -- and the next write replaces all
    // of it. The new block goes in ahead of the orphan instead.
    const content = `# Notes\n\n${unterminated(renderInvocationYaml(INVOCATION))}\n${TAIL}`;
    const once = upsertInvocationBlock(content, { ...INVOCATION, label: "first" });
    expect(once).toContain("KEEP ME");
    const twice = upsertInvocationBlock(once, { ...INVOCATION, label: "second" });
    expect(twice).toContain("KEEP ME");
    expect(twice).toContain("## Irreplaceable interpretation");
    const parsed = findInvocationBlocks(twice);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("second");
  });

  it("survives a second update on the job side too", () => {
    const content = `# Notes\n\n${unterminated(renderJobYaml(JOB))}\n${TAIL}`;
    const twice = upsertJobBlock(upsertJobBlock(content, { ...JOB, label: "first" }), {
      ...JOB,
      label: "second",
    });
    expect(twice).toContain("KEEP ME");
    expect(findJobBlocks(twice)).toHaveLength(1);
  });

  it("is not confused by a half-written block of the user's own", () => {
    // Only Loom's own openers matter here: the scanners never start at a
    // ```python line, so an unterminated one cannot make them mis-read a range.
    // It is a rendering oddity in the user's file, not a hazard to the record.
    const content = "# Notes\n\n```python\nprint('still writing this')\n";
    const once = upsertInvocationBlock(content, INVOCATION);
    const twice = upsertInvocationBlock(once, { ...INVOCATION, label: "second" });
    expect(twice).toContain("still writing this");
    const parsed = findInvocationBlocks(twice);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("second");
  });

  it("treats a four-backtick close as no close at all", () => {
    // The scanners close on an exact ```, so a longer run is not a close --
    // and the append locator has to agree, or it happily appends after a block
    // it thinks is closed and the next write swallows both.
    const fourTick = renderInvocationYaml(INVOCATION).replace(/^```$/m, "````");
    const content = `# Notes\n\n${fourTick}\n${TAIL}`;
    expect(findInvocationBlocks(content)).toHaveLength(0);

    const twice = upsertInvocationBlock(
      upsertInvocationBlock(content, { ...INVOCATION, label: "first" }),
      { ...INVOCATION, label: "second" },
    );
    expect(twice).toContain("KEEP ME");
    expect(findInvocationBlocks(twice)).toHaveLength(1);
  });

  it("leaves a block in the ambiguous region alone and writes a clean one above", () => {
    // Past an unclosed opener the scanners cannot tell whose closing fence is
    // whose, so a block there is not replaced -- it is left exactly as it is
    // and a clean copy goes in ahead of the orphan. One duplicate in an
    // already-broken notebook, and the clean copy is unambiguous, so it is the
    // one every write after this finds.
    const content = `${unterminated(renderInvocationYaml({ ...INVOCATION, invocationId: "aa11bb22cc33dd44" }))}\n${TAIL}\n${renderInvocationYaml(INVOCATION)}`;

    const once = upsertInvocationBlock(content, { ...INVOCATION, label: "first" });
    expect(once).toContain("KEEP ME");
    expect(once.indexOf("label: first")).toBeLessThan(
      once.indexOf("```loom-invocation\ninvocation_id: aa11bb22cc33dd44"),
    );

    // Second write finds the clean copy and rewrites it in place.
    const twice = upsertInvocationBlock(once, { ...INVOCATION, label: "second" });
    expect(twice).toContain("KEEP ME");
    expect(twice.split("label: second")).toHaveLength(2);
    expect(twice.split("label: first")).toHaveLength(1);
  });

  it("will not replace field-shaped prose sitting in an ambiguous body", () => {
    // The narrowest version of the cross-type case: the prose is lowercase and
    // colon-terminated, so no body-shape rule can tell it from a field this
    // version has simply never heard of. Refusing to replace is what keeps it.
    const content = [
      "# Notes",
      "",
      "```loom-job",
      `job_id: ${JOB.jobId}`,
      "```loom-invocation",
      `invocation_id: ${INVOCATION.invocationId}`,
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-1",
      "label: captured",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      "note: keep this interpretation",
      "```",
      "",
    ].join("\n");

    const once = upsertInvocationBlock(content, { ...INVOCATION, label: "first" });
    expect(once).toContain("note: keep this interpretation");
    const twice = upsertInvocationBlock(once, { ...INVOCATION, label: "second" });
    expect(twice).toContain("note: keep this interpretation");
    expect(twice).toContain("```loom-job");
  });

  it("duplicates once, not once per tick", () => {
    // The cost of refusing to replace in the ambiguous region is one clean
    // copy. It has to stay one: the poller rewrites the same id on every tick,
    // and a block per tick would be its own kind of notebook damage.
    const orphan = unterminated(
      renderInvocationYaml({ ...INVOCATION, invocationId: "aa11bb22cc33dd44" }),
    );
    let content = `${orphan}\n${TAIL}\n${renderInvocationYaml(INVOCATION)}`;
    const copies = () =>
      findInvocationBlocks(content).filter((b) => b.invocationId === INVOCATION.invocationId)
        .length;

    for (let tick = 1; tick <= 6; tick++) {
      content = applyInvocationUpdates(content, [
        {
          invocationId: INVOCATION.invocationId,
          totalSteps: 3,
          completedSteps: tick,
          totalJobs: 3,
          completedJobs: tick,
          failedJobs: 0,
          lastPolledAt: `2026-09-16T15:4${tick}:00Z`,
        },
      ]).content;
      expect(copies()).toBeLessThanOrEqual(2);
    }
    for (let i = 0; i < 4; i++) {
      content = upsertInvocationBlock(content, { ...INVOCATION, label: `rewrite ${i}` });
      expect(copies()).toBeLessThanOrEqual(2);
    }
    expect(content).toContain("KEEP ME");
  });

  it("does not mistake prose with a colon in it for a field", () => {
    // A looser body rule -- anything with a colon -- would read `Note: ...` as
    // a field and let the range swallow it. The rule is the parsers' own key
    // grammar: snake_case, at the start of the line.
    for (const line of ["Note: see below", "TODO: rerun this", "  indented_key: x", "- a step"]) {
      const content = [
        "```loom-invocation",
        `invocation_id: ${INVOCATION.invocationId}`,
        line,
        "```",
        "",
      ].join("\n");
      expect(findInvocationBlocks(content)).toHaveLength(0);
      expect(parseInvocationBlocks(content)).toHaveLength(0);
      expect(upsertInvocationBlock(content, INVOCATION)).toContain(line);
    }
  });

  it("still reads every shape the renderers actually emit", () => {
    // The body rule must not refuse a real block. These are the widest bodies
    // the three renderers produce.
    const inv = renderInvocationYaml({
      ...INVOCATION,
      summary: "",
      serverVerified: false,
      totalSteps: 4,
      completedSteps: 2,
      totalJobs: 9,
      completedJobs: 5,
      failedJobs: 1,
      lastPolledAt: "2026-09-16T15:34:00Z",
      attemptId: "01K5CJ6XWQ8QK4S2M7E9V0TZ3B",
      historyId: "0a248a1f62a0cc04",
      submittedBy: "harness",
      enrichment: "complete",
      enrichmentAttempts: 2,
      jobs: [{ jobId: "job1", toolId: "bwa_mem", toolVersion: "0.7.17", state: "ok" }],
      drift: [{ toolId: "bwa_mem", from: "0.7.17", to: "0.7.18" }],
    });
    expect(findInvocationBlocks(inv)).toHaveLength(1);
    expect(parseInvocationBlocks(inv)).toHaveLength(1);

    const job = renderJobYaml({
      ...JOB,
      toolId: "bwa_mem",
      summary: "step 3: align reads",
      serverVerified: true,
      galaxyState: "running",
      lastPolledAt: "2026-09-16T15:34:00Z",
      attemptId: "01K5CJ6XWQ8QK4S2M7E9V0TZ3B",
      submittedBy: "harness",
    });
    expect(findJobBlocks(job)).toHaveLength(1);

    const udt = renderUdtYaml({
      toolId: "my_tool",
      toolUuid: "4f6d2a1e-0000-4000-8000-000000000001",
      definition: ".loom/provenance/udt/my_tool.4f6d2a1e.yaml",
      createdAt: "2026-09-16T15:30:00Z",
      notebookAnchor: "plan-a-step-1",
      attemptId: "01K5CJ6XWQ8QK4S2M7E9V0TZ3B",
    });
    expect(findUdtBlocks(udt)).toHaveLength(1);
  });

  it("covers the loom-udt block, which the first pass at this missed", () => {
    const udt: UdtYaml = {
      toolId: "my_tool",
      toolUuid: "4f6d2a1e-0000-4000-8000-000000000001",
      definition: ".loom/provenance/udt/my_tool.4f6d2a1e.yaml",
      createdAt: "2026-09-16T15:30:00Z",
      notebookAnchor: "plan-a-step-1",
    };
    const content = `# Notes\n\n${unterminated(renderUdtYaml(udt))}\n${TAIL}`;
    expect(findUdtBlocks(content)).toHaveLength(0);

    const twice = upsertUdtBlock(upsertUdtBlock(content, udt), {
      ...udt,
      notebookAnchor: "plan-a-step-2",
    });
    expect(twice).toContain("KEEP ME");
    const parsed = findUdtBlocks(twice);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].notebookAnchor).toBe("plan-a-step-2");
  });

  it("still reads the block before an unterminated one", () => {
    const content = `${renderInvocationYaml(INVOCATION)}\n${unterminated(
      renderInvocationYaml({ ...INVOCATION, invocationId: "aa11bb22cc33dd44" }),
    )}\n`;
    const parsed = findInvocationBlocks(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].invocationId).toBe(INVOCATION.invocationId);
  });
});

describe("the Activity panel decodes a label the way the notebook wrote it", () => {
  const labels = ["C:\\reads\\sample", 'a "quoted" label', "step 3: align reads", "line\nbreak"];

  it("matches the brain's parser on every quoted shape", () => {
    for (const label of labels) {
      const content = renderInvocationYaml({ ...INVOCATION, label });
      expect(parseInvocationBlocks(content)[0].label).toBe(findInvocationBlocks(content)[0].label);
      expect(parseInvocationBlocks(content)[0].label).toBe(label);
    }
  });
});
