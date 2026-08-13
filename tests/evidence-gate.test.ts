import { describe, it, expect } from "vitest";
import {
  computeAfterContent,
  decideNotebookWrite,
  detectCompletions,
  findContradictions,
  parsePlanSteps,
} from "../extensions/loom/evidence-gate";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";

const PLAN = `# Notebook

## Plan A: chrM Variant Calling [hybrid]

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim
  - Routing: local
  - Verification: confirm fastp report exists
- [ ] 2. **Align reads** {#plan-a-step-2} — bwa mem
  - Routing: Galaxy
  - Verification: poll jobs to ok and inspect BAM
`;

function invocation(over: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "abc0000000000001",
    galaxyServerUrl: "https://test.galaxyproject.org",
    notebookAnchor: "plan-a-step-2",
    label: "Align reads",
    submittedAt: "2026-08-01T00:00:00Z",
    status: "in_progress",
    ...over,
  };
}

const withInvocation = (...invs: InvocationYaml[]) =>
  PLAN + "\n" + invs.map((i) => renderInvocationYaml(i)).join("\n");

const flip = (content: string, step: string) => content.replace(`- [ ] ${step}`, `- [x] ${step}`);

const STEP2 = "2. **Align reads** {#plan-a-step-2} — bwa mem";

function editCall(oldText: string, newText: string, key: "path" | "file_path" = "path") {
  return { tool: "edit", input: { [key]: "notebook.md", edits: [{ oldText, newText }] } };
}

describe("parsePlanSteps", () => {
  it("keys steps by anchor and finds them inside plan sections", () => {
    const steps = parsePlanSteps(PLAN);
    expect(steps.size).toBe(2);
    expect(steps.get("#plan-a-step-2")?.state).toBe(" ");
  });

  it("ignores checkboxes outside a plan section", () => {
    expect(parsePlanSteps(`## Scratch\n\n- [ ] buy milk\n`).size).toBe(0);
  });

  it("keys by normalized title when a step has no anchor", () => {
    const steps = parsePlanSteps(`## Plan B: X\n\n- [ ] 1. **Do the thing** — details\n`);
    expect([...steps.keys()][0]).toBe("b#do the thing");
  });
});

describe("detectCompletions", () => {
  it("detects a genuine flip", () => {
    const done = flip(PLAN, STEP2);
    expect(detectCompletions(PLAN, done).map((s) => s.anchor)).toEqual(["plan-a-step-2"]);
  });

  it("survives lines inserted above -- keys are not line numbers", () => {
    const shifted = "# Notebook\n\nA new preamble paragraph.\n" + PLAN.slice("# Notebook\n".length);
    expect(detectCompletions(PLAN, flip(shifted, STEP2))).toHaveLength(1);
  });

  it("never treats a failure mark as a completion", () => {
    const failed = PLAN.replace(`- [ ] ${STEP2}`, `- [!] ${STEP2}`);
    expect(detectCompletions(PLAN, failed)).toHaveLength(0);
  });

  it("never treats reopening as a completion", () => {
    expect(detectCompletions(flip(PLAN, STEP2), PLAN)).toHaveLength(0);
  });

  it("a first write with steps already checked is not a pile of completions", () => {
    // Kills the first-write / plan-regeneration false-positive class at the root.
    expect(detectCompletions("", flip(PLAN, STEP2))).toHaveLength(0);
  });
});

describe("findContradictions", () => {
  it("flags a flip while the bound invocation is still in progress", () => {
    const before = withInvocation(invocation({ status: "in_progress" }));
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(1);
  });

  it("says nothing when the invocation completed", () => {
    const before = withInvocation(invocation({ status: "completed" }));
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(0);
  });

  it("never fires on a failed block -- it is sticky and cannot be re-polled", () => {
    // checkInvocations polls only in_progress blocks (tools.ts:650), so a deny
    // here would have no remediation the agent could actually execute.
    const before = withInvocation(invocation({ status: "failed" }));
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(0);
  });

  it("fails open on retry-after-failure: a stale block beside a completed one", () => {
    // upsertInvocationBlock keys on invocation_id (notebook-writer.ts:283), so a
    // rerun leaves TWO blocks sharing an anchor. Denying the honest flip here is
    // the single most likely real-world false positive.
    const before = withInvocation(
      invocation({ invocationId: "abc0000000000001", status: "failed" }),
      invocation({ invocationId: "def0000000000002", status: "completed" }),
    );
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(0);
  });

  it("fails open when a stale in-progress block sits beside a completed one", () => {
    const before = withInvocation(
      invocation({ invocationId: "abc0000000000001", status: "in_progress" }),
      invocation({ invocationId: "def0000000000002", status: "completed" }),
    );
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(0);
  });

  it("has no opinion about a step with no bound invocation", () => {
    const before = withInvocation(invocation({ notebookAnchor: "plan-a-step-99" }));
    const flips = detectCompletions(before, flip(before, STEP2));
    expect(findContradictions(before, flips)).toHaveLength(0);
  });

  it("has no opinion about a local step with no invocation blocks at all", () => {
    const flips = detectCompletions(PLAN, flip(PLAN, STEP2));
    expect(findContradictions(PLAN, flips)).toHaveLength(0);
  });
});

describe("adversarial: the bypasses that define the acceptance bar", () => {
  it("a flip that also rewrites status to completed in the SAME edit is still caught", () => {
    // The killer found in review: reading the post-image would let one edit
    // clear the contradiction it creates. The pre-image is what Galaxy wrote.
    const before = withInvocation(invocation({ status: "in_progress" }));
    const call = {
      tool: "edit",
      input: {
        path: "notebook.md",
        edits: [
          { oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` },
          { oldText: "status: in_progress", newText: "status: completed" },
        ],
      },
    };
    const d = decideNotebookWrite(before, call.tool, call.input, "deny");
    expect(d.contradictions).toHaveLength(1);
    expect(d.gated).toBe(true);
  });

  it("a whole-file write that rewrites status alongside the flip is still caught", () => {
    const before = withInvocation(invocation({ status: "in_progress" }));
    const forged = flip(before, STEP2).replace("status: in_progress", "status: completed");
    const d = decideNotebookWrite(
      before,
      "write",
      { path: "notebook.md", content: forged },
      "deny",
    );
    expect(d.gated).toBe(true);
  });

  it("does not fail open when the call uses file_path instead of path", () => {
    // pi accepts both (dist/core/tools/edit.js:82); reading only `path` was a
    // one-key bypass. decideNotebookWrite is path-agnostic, so this asserts the
    // shape the hook must normalize.
    const before = withInvocation(invocation({ status: "in_progress" }));
    const call = editCall(`- [ ] ${STEP2}`, `- [x] ${STEP2}`, "file_path");
    expect(decideNotebookWrite(before, call.tool, call.input, "deny").gated).toBe(true);
  });

  it("KNOWN GAP: splitting the forgery across two edits evades the pre-image check", () => {
    // Documented, not fixed. Closing it needs the poller's status held out of
    // band where the model cannot author it. This test pins the current
    // behaviour so the gap is visible rather than forgotten.
    const before = withInvocation(invocation({ status: "in_progress" }));
    const afterStatusRewrite = before.replace("status: in_progress", "status: completed");
    const call = editCall(`- [ ] ${STEP2}`, `- [x] ${STEP2}`);
    const d = decideNotebookWrite(afterStatusRewrite, call.tool, call.input, "deny");
    expect(d.gated).toBe(false);
  });
});

describe("computeAfterContent", () => {
  it("uses content verbatim for a write", () => {
    expect(computeAfterContent(PLAN, "write", { content: "new" })).toBe("new");
  });

  it("applies sequential edits", () => {
    const out = computeAfterContent(PLAN, "edit", {
      edits: [{ oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` }],
    });
    expect(out).toContain(`- [x] ${STEP2}`);
  });

  it("abstains rather than guessing on shapes it cannot reason about", () => {
    expect(
      computeAfterContent(PLAN, "edit", { edits: [{ oldText: "nope", newText: "x" }] }),
    ).toBeNull();
    expect(computeAfterContent(PLAN, "edit", {})).toBeNull();
    expect(computeAfterContent(PLAN, "write", {})).toBeNull();
    expect(computeAfterContent(PLAN, "read", { content: "x" })).toBeNull();
  });
});

describe("decideNotebookWrite modes", () => {
  const before = withInvocation(invocation({ status: "in_progress" }));
  const call = editCall(`- [ ] ${STEP2}`, `- [x] ${STEP2}`);

  it("deny blocks and explains", () => {
    const d = decideNotebookWrite(before, call.tool, call.input, "deny");
    expect(d.gated).toBe(true);
    expect(d.reason).toMatch(/status: in_progress/);
    expect(d.reason).toMatch(/galaxy_invocation_check_all/);
  });

  it("warn -- the shipping default -- allows but still records", () => {
    const d = decideNotebookWrite(before, call.tool, call.input, "warn");
    expect(d.gated).toBe(false);
    expect(d.contradictions).toHaveLength(1);
  });

  it("off does nothing at all", () => {
    const d = decideNotebookWrite(before, call.tool, call.input, "off");
    expect(d.gated).toBe(false);
    expect(d.completions).toHaveLength(0);
  });

  it("stays silent on ordinary notebook prose edits", () => {
    const plain = editCall("### Steps", "### Analysis steps");
    const d = decideNotebookWrite(before, plain.tool, plain.input, "deny");
    expect(d.completions).toHaveLength(0);
    expect(d.gated).toBe(false);
  });

  it("its remediation is executable -- check_all does poll in_progress blocks", () => {
    // The reason must not send the agent at a no-op. check_all filters to
    // in_progress (tools.ts:650), which is exactly the only status we fire on.
    const d = decideNotebookWrite(before, call.tool, call.input, "deny");
    expect(d.contradictions[0].invocation.status).toBe("in_progress");
    expect(d.reason).toMatch(/leave the step pending|`- \[!\]`/);
  });
});
