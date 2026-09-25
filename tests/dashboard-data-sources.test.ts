// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  DashboardSources,
  parseActivityLines,
  parseJobBlocks,
  parsePlanSections,
} from "../app/src/renderer/dashboard/data-sources.js";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";

const NOTEBOOK = `# Analysis

## Plan A: chrM Variant Calling [hybrid]

Question: how do mtDNA variants distribute across tissues?

### Steps

- [x] 1. **QC FASTQ** {#plan-a-step-1} \u2014 fastp adapter trim + per-base QC
  - Routing: local
  - Verification: confirm the fastp report exists
- [ ] 2. **Read alignment** {#plan-a-step-2} \u2014 bwa mem PE 4 samples
  - Routing: Galaxy (bwa-mem2/2.2.1)
- [!] 3. **Variant calling** {#plan-a-step-3} \u2014 freebayes

## Results

Not a plan section.

- [ ] this checkbox is outside any plan

## Plan B: Follow-up [galaxy]

- [ ] Draft the comparison

\`\`\`loom-job
job_id: job-9
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-1
label: fastp trim
tool_id: fastp
submitted_at: 2026-09-18T04:50:00Z
status: completed
galaxy_state: ok
\`\`\`

\`\`\`loom-invocation
invocation_id: inv-1
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-2
label: bwa alignment
submitted_at: 2026-09-18T05:00:00Z
status: in_progress
total_jobs: 4
completed_jobs: 1
\`\`\`
`;

describe("parsePlanSections", () => {
  it("finds every plan heading and stops at the next h2", () => {
    const plans = parsePlanSections(NOTEBOOK);
    expect(plans.map((p) => p.id)).toEqual(["plan-a", "plan-b"]);
    expect(plans[0].steps).toHaveLength(3);
    // The checkbox under "## Results" belongs to no plan and must not be stolen.
    expect(plans[1].steps.map((s) => s.title)).toEqual(["Draft the comparison"]);
  });

  it("reads the routing tag off the heading and trims it from the title", () => {
    const [planA, planB] = parsePlanSections(NOTEBOOK);
    expect(planA.routing).toBe("hybrid");
    expect(planA.title).toBe("Plan A: chrM Variant Calling");
    expect(planB.routing).toBe("galaxy");
  });

  it("maps the three checkbox markers to statuses", () => {
    const steps = parsePlanSections(NOTEBOOK)[0].steps;
    expect(steps.map((s) => s.status)).toEqual(["done", "pending", "failed"]);
  });

  it("pulls anchor, number, title and detail off a step line", () => {
    const step = parsePlanSections(NOTEBOOK)[0].steps[1];
    expect(step).toMatchObject({
      anchor: "plan-a-step-2",
      number: 2,
      title: "Read alignment",
      detail: "bwa mem PE 4 samples",
    });
  });

  it("attaches a Routing sub-bullet to the step above it", () => {
    const steps = parsePlanSections(NOTEBOOK)[0].steps;
    expect(steps[0].routing).toBe("local");
    expect(steps[1].routing).toBe("Galaxy (bwa-mem2/2.2.1)");
    expect(steps[2].routing).toBeNull();
  });

  it("attaches a Verification sub-bullet too, which the schema requires of every step", () => {
    const steps = parsePlanSections(NOTEBOOK)[0].steps;
    expect(steps[0].verification).toBe("confirm the fastp report exists");
    expect(steps[1].verification).toBeNull();
  });

  it("copes with a hand-edited step that has no number, anchor or bold", () => {
    const plans = parsePlanSections("## Plan C: Ad hoc\n\n- [ ] just do the thing -- somehow\n");
    expect(plans[0].steps[0]).toMatchObject({
      anchor: null,
      number: 1,
      title: "just do the thing",
      detail: "somehow",
    });
  });

  it("returns nothing for a notebook with no plans", () => {
    expect(parsePlanSections("# Notes\n\nnothing here\n")).toEqual([]);
    expect(parsePlanSections("")).toEqual([]);
  });
});

describe("parseActivityLines", () => {
  it("skips blank and unparsable lines instead of throwing", () => {
    const events = parseActivityLines(
      [
        '{"timestamp":"t1","kind":"prompt","source":"user","payload":{"a":1}}',
        "",
        "not json",
        "[]",
      ].join("\n"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ timestamp: "t1", kind: "prompt", source: "user" });
  });

  it("defaults the fields a line is missing", () => {
    const [event] = parseActivityLines("{}");
    expect(event).toEqual({ timestamp: "", kind: "event", source: "", payload: {} });
  });

  it("keeps only the newest 200 events", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `{"kind":"e${i}"}`).join("\n");
    const events = parseActivityLines(lines);
    expect(events).toHaveLength(200);
    expect(events[events.length - 1].kind).toBe("e249");
  });
});

describe("parseJobBlocks", () => {
  it("reads a loom-job block, which is all that moves in a tool-run session", () => {
    const [job] = parseJobBlocks(NOTEBOOK);
    expect(job).toMatchObject({
      jobId: "job-9",
      label: "fastp trim",
      toolId: "fastp",
      status: "completed",
      galaxyState: "ok",
      notebookAnchor: "plan-a-step-1",
    });
  });

  it("skips a block missing a required field rather than half-reading it", () => {
    const partial = ["```loom-job", "job_id: x", "status: in_progress", "```"].join("\n");
    expect(parseJobBlocks(partial)).toEqual([]);
  });

  it("keeps a captured job whose server url is empty because GALAXY_URL was unset", () => {
    const block = [
      "```loom-job",
      "job_id: job-captured",
      'galaxy_server_url: ""',
      "notebook_anchor: unattributed",
      "label: Upload a.fastq",
      "submitted_at: 2026-09-25T00:00:00Z",
      "status: in_progress",
      "```",
    ].join("\n");
    const [job] = parseJobBlocks(block);
    expect(job).toMatchObject({ jobId: "job-captured", galaxyServerUrl: "" });
  });

  it("accepts every status the brain can write, including the non-failure endings", () => {
    for (const status of ["in_progress", "completed", "failed", "cancelled", "skipped"]) {
      const block = [
        "```loom-job",
        "job_id: j",
        "galaxy_server_url: https://usegalaxy.org",
        "notebook_anchor: a",
        "label: L",
        "submitted_at: 2026-09-18T00:00:00Z",
        `status: ${status}`,
        "```",
      ].join("\n");
      expect(parseJobBlocks(block)[0]?.status, status).toBe(status);
    }
  });

  it("unquotes a JSON-quoted label", () => {
    const block = [
      "```loom-job",
      "job_id: j",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: a",
      'label: "BWA: paired, 4 samples"',
      "submitted_at: 2026-09-18T00:00:00Z",
      "status: in_progress",
      "```",
    ].join("\n");
    expect(parseJobBlocks(block)[0].label).toBe("BWA: paired, 4 samples");
  });

  it("returns nothing for a notebook with no job blocks", () => {
    expect(parseJobBlocks("# nothing here")).toEqual([]);
  });
});

describe("plan steps that are not steps", () => {
  it("ignores example checkboxes inside a fenced code block", () => {
    // The notebook schema tells the agent to show the step format by example,
    // so a fenced block full of "- [ ] 1. **Example**" is what a well-behaved
    // notebook looks like. Counting those moved the progress bar and put an
    // invented step in the panel's NEXT box.
    const md = [
      "## Plan A: Real [galaxy]",
      "",
      "- [ ] 1. **Actual step** -- do the thing",
      "",
      "Here is how to write one:",
      "",
      "```markdown",
      "- [ ] 1. **Example step** -- not real",
      "- [x] 2. **Another example** -- also not real",
      "```",
      "",
    ].join("\n");
    const [plan] = parsePlanSections(md);
    expect(plan.steps.map((s) => s.title)).toEqual(["Actual step"]);
  });

  it("handles a tilde fence too, and an unclosed one", () => {
    const tilde = "## Plan A\n\n- [ ] 1. **Real**\n\n~~~\n- [ ] 2. **Fake**\n~~~\n";
    expect(parsePlanSections(tilde)[0].steps.map((s) => s.title)).toEqual(["Real"]);
    const unclosed = "## Plan A\n\n- [ ] 1. **Real**\n\n```\n- [ ] 2. **Fake**\n";
    expect(parsePlanSections(unclosed)[0].steps.map((s) => s.title)).toEqual(["Real"]);
  });

  it("does not let the other marker close a fence it did not open", () => {
    // The toggle flipped on either marker without remembering which opened the
    // block, so a `~~~` line INSIDE a ```markdown example closed it, the ```
    // that really ended it opened a new one, and every checkbox in between came
    // back as a real step -- the exact phantom the fence tracking exists to
    // stop, reintroduced by the tracking.
    const md = [
      "## Plan A: Real work [local]",
      "",
      "- [ ] 1. **Align reads**",
      "- [ ] 2. **Call variants**",
      "",
      "Write steps like this:",
      "",
      "```markdown",
      "- [ ] 1. **Example step**",
      "~~~",
      "- [ ] 3. **PHANTOM from inside a fence**",
      "```",
      "",
    ].join("\n");
    const [plan] = parsePlanSections(md);
    expect(plan.steps.map((s) => s.title)).toEqual(["Align reads", "Call variants"]);
  });

  it("closes a fence only on a marker at least as long as its opener", () => {
    // CommonMark: a longer opener is closed by a run at least that long, and a
    // shorter run inside it is content. Without the length check a ``` line in
    // a ````-fenced example ends the block early.
    const md = [
      "## Plan A: Real work [local]",
      "",
      "- [ ] 1. **Align reads**",
      "",
      "````markdown",
      "```",
      "- [ ] 2. **PHANTOM inside the inner block**",
      "```",
      "````",
      "",
    ].join("\n");
    const [plan] = parsePlanSections(md);
    expect(plan.steps.map((s) => s.title)).toEqual(["Align reads"]);
  });

  it("parses a step whose detail holds a long run of spaces, quickly", () => {
    // The old separator pattern backtracked: `split` tried every position and
    // the leading \s+ re-consumed the run each time, so this took 3.2 s at
    // 80,000 spaces and 12.8 s at 160,000 -- on the renderer's synchronous
    // path, with the window frozen.
    const md = "## Plan A\n- [ ] task x" + " ".repeat(160_000) + "z\n";
    const started = Date.now();
    const [plan] = parsePlanSections(md);
    expect(Date.now() - started).toBeLessThan(500);
    expect(plan.steps).toHaveLength(1);
  });

  it("still splits a step on its separator, and not inside a hyphenated word", () => {
    const md = [
      "## Plan A",
      "- [ ] 1. **Align reads** -- bwa-mem2 against the well-known reference",
      "- [ ] 2. **Count** \u2014 featureCounts",
      "- [ ] 3. **No detail here**",
    ].join("\n");
    const steps = parsePlanSections(md)[0].steps;
    expect(steps.map((s) => s.title)).toEqual(["Align reads", "Count", "No detail here"]);
    expect(steps[0].detail).toBe("bwa-mem2 against the well-known reference");
    expect(steps[1].detail).toBe("featureCounts");
    expect(steps[2].detail).toBe("");
  });
});

describe("Windows line endings", () => {
  // A notebook written on Windows, or round-tripped through a tool that
  // rewrites newlines, reaches these parsers with a trailing CR on every line.
  // A JS `.` does not match a carriage return and `$` will not step over one,
  // so before the split was made CRLF-tolerant every field regex here missed
  // and the panels drew an empty analysis against a full notebook.
  const CRLF = NOTEBOOK.replace(/\n/g, "\r\n");

  it("reads the same plan sections out of a CRLF notebook", () => {
    expect(parsePlanSections(CRLF)).toEqual(parsePlanSections(NOTEBOOK));
  });

  it("reads the same job blocks out of a CRLF notebook", () => {
    expect(parseJobBlocks(CRLF)).toEqual(parseJobBlocks(NOTEBOOK));
    expect(parseJobBlocks(CRLF)).toHaveLength(1);
  });

  it("reads the same invocation blocks out of a CRLF notebook", () => {
    expect(parseInvocationBlocks(CRLF)).toEqual(parseInvocationBlocks(NOTEBOOK));
    expect(parseInvocationBlocks(CRLF)).toHaveLength(1);
  });

  it("does not treat a bare carriage return as a line break", () => {
    // The split is CRLF-only on purpose. A bare CR turns up in pasted terminal
    // output (a progress line rewriting itself), and treating it as a newline
    // would invent step boundaries that are not in the notebook. The cost is
    // that a step line containing one is not parsed at all, because the step
    // pattern ends in `$` and a JS `.` will not step over a CR. That is
    // unchanged from before the CRLF fix and is pinned here so that nobody
    // "completes" the fix by splitting on /\r/ as well.
    const twoOnALine = "## Plan A: X\n\n- [ ] **A** -- one\r- [ ] **B** -- two\n";
    expect(parsePlanSections(twoOnALine)[0].steps).toEqual([]);
  });
});

describe("DashboardSources", () => {
  it("derives invocations, jobs and plan steps from one notebook push", () => {
    const sources = new DashboardSources();
    sources.setNotebook(NOTEBOOK, "/tmp/a/notebook.md");

    expect(sources.sources.notebook.get().path).toBe("/tmp/a/notebook.md");
    const snapshot = sources.sources.invocations.get();
    expect(snapshot.invocations.map((i) => i.invocationId)).toEqual(["inv-1"]);
    expect(snapshot.jobs.map((j) => j.jobId)).toEqual(["job-9"]);
    expect(sources.sources.plan.get().plans).toHaveLength(2);
  });

  it("stages the derived sources before notifying, so none of them lag", () => {
    const sources = new DashboardSources();
    let planSeenFromNotebookListener = -1;
    let jobsSeenFromNotebookListener = -1;
    sources.sources.notebook.subscribe(() => {
      planSeenFromNotebookListener = sources.sources.plan.get().plans.length;
      jobsSeenFromNotebookListener = sources.sources.invocations.get().jobs.length;
    });
    sources.setNotebook(NOTEBOOK);
    expect(planSeenFromNotebookListener).toBe(2);
    expect(jobsSeenFromNotebookListener).toBe(1);
  });

  it("does not wake a session widget when nothing about the session changed", () => {
    const sources = new DashboardSources();
    let notifications = 0;
    sources.sources.session.subscribe(() => {
      notifications++;
    });
    sources.setSession({ status: "running", cwd: "/tmp/a" });
    sources.setSession({ status: "running", cwd: "/tmp/a" });
    sources.setSession({ tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
    sources.setSession({ tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(notifications).toBe(2);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const sources = new DashboardSources();
    const seen: number[] = [];
    const off = sources.sources.plan.subscribe((snap) => seen.push(snap.plans.length));
    sources.setNotebook(NOTEBOOK);
    off();
    sources.setNotebook("## Plan Z: Later\n");
    expect(seen).toEqual([2]);
  });

  it("keeps fanning out when one subscriber throws", () => {
    const sources = new DashboardSources();
    let reached = false;
    sources.sources.notebook.subscribe(() => {
      throw new Error("boom");
    });
    sources.sources.notebook.subscribe(() => {
      reached = true;
    });
    sources.setNotebook("hello");
    expect(reached).toBe(true);
  });

  it("reports activity and files as unavailable when the shell has no file surface", async () => {
    const sources = new DashboardSources({});
    await sources.refreshActivity();
    await sources.refreshFiles();
    expect(sources.sources.activity.get().available).toBe(false);
    expect(sources.sources.files.get().available).toBe(false);
  });

  it("reads the activity tail when the shell does have one", async () => {
    const bytes = new TextEncoder().encode('{"kind":"tool_call","source":"bash"}');
    const sources = new DashboardSources({
      readFile: async () => ({ ok: true, bytes }),
    });
    await sources.refreshActivity();
    const snap = sources.sources.activity.get();
    expect(snap.available).toBe(true);
    expect(snap.events[0].kind).toBe("tool_call");
  });

  it("stays unavailable when the shell's file read rejects", async () => {
    const sources = new DashboardSources({
      readFile: () => Promise.reject(new Error("nope")),
    });
    await sources.refreshActivity();
    expect(sources.sources.activity.get().available).toBe(false);
  });

  it("discards a pulled read that was in flight when the directory changed", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = new TextEncoder().encode('{"kind":"from_the_old_workspace"}');
    const sources = new DashboardSources({
      readFile: async () => {
        await gate;
        return { ok: true, bytes };
      },
    });

    const inFlight = sources.refreshActivity();
    sources.reset();
    release!();
    await inFlight;

    expect(sources.sources.activity.get().events).toEqual([]);
    expect(sources.sources.activity.get().available).toBe(false);
  });

  it("clears every source on a cwd switch", () => {
    const sources = new DashboardSources();
    sources.setNotebook(NOTEBOOK);
    sources.setSession({ cwd: "/tmp/a", status: "running" });
    sources.reset();
    expect(sources.sources.notebook.get().markdown).toBe("");
    expect(sources.sources.invocations.get().invocations).toEqual([]);
    expect(sources.sources.plan.get().plans).toEqual([]);
    expect(sources.sources.session.get().cwd).toBe("");
    expect(sources.sources.session.get().status).toBe("unknown");
  });
});
