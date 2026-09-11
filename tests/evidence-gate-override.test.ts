import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state");
vi.mock("../extensions/loom/config", () => ({ loadConfig: () => ({}) }));

import * as state from "../extensions/loom/state";
import {
  adjudicateNotebookWrite,
  overrideToken,
  registerEvidenceGate,
  resetEvidenceOverrides,
  resolveMode,
} from "../extensions/loom/evidence-gate";
import {
  planOverride,
  registerEvidenceOverrideCommand,
} from "../extensions/loom/evidence-override-command";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";

const PLAN = `# Notebook

## Plan A: chrM Variant Calling [hybrid]

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim
  - Routing: Galaxy
  - Verification: confirm fastp report exists
- [ ] 2. **Align reads** {#plan-a-step-2} — bwa mem
  - Routing: Galaxy
  - Verification: poll jobs to ok and inspect BAM
`;

const STEP1 = "1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim";
const STEP2 = "2. **Align reads** {#plan-a-step-2} — bwa mem";

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

const flipEdit = (step: string) => ({
  path: "notebook.md",
  edits: [{ oldText: `- [ ] ${step}`, newText: `- [x] ${step}` }],
});

/**
 * The bits of pi the gate touches: an event bus it subscribes to and a command
 * registry. Driving the real hook rather than only the pure decision is the
 * point of this file -- the retry escape and the override both live in session
 * state that `decideNotebookWrite` never sees.
 */
function fakePi() {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const listeners = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (a: string | undefined, c: unknown) => Promise<void> }
  >();
  const notices: string[] = [];
  const api = {
    on(name: string, handler: Handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
    },
    registerCommand(
      name: string,
      opts: { handler: (a: string | undefined, c: unknown) => Promise<void> },
    ) {
      commands.set(name, opts);
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    notices,
    /** One `edit` on notebook.md. Returns the hook's verdict. */
    async write(input: Record<string, unknown>, toolName = "edit") {
      const handlers = listeners.get("tool_call") ?? [];
      let result: unknown;
      for (const h of handlers) result = await h({ toolName, input }, { cwd: dir });
      return result as { block?: boolean; reason?: string } | undefined;
    },
    async sessionStart() {
      for (const h of listeners.get("session_start") ?? []) await h({}, { cwd: dir });
    },
    async runCommand(name: string, args: string) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`no command /${name}`);
      await cmd.handler(args, { ui: { notify: (m: string) => notices.push(m) } });
    },
  };
}

let dir: string;
let nbPath: string;

function setNotebook(content: string): void {
  fs.writeFileSync(nbPath, content, "utf-8");
}

function activityRows(kind?: string): Record<string, unknown>[] {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => !kind || e.kind === kind);
}

const payloads = (kind: string) =>
  activityRows(kind).map((e) => e.payload as Record<string, unknown>);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-evidence-"));
  nbPath = path.join(dir, "notebook.md");
  setNotebook(withInvocation(invocation()));
  vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
  resetEvidenceOverrides();
  delete process.env.LOOM_EVIDENCE_GATE;
});

afterEach(() => {
  delete process.env.LOOM_EVIDENCE_GATE;
  resetEvidenceOverrides();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveMode", () => {
  it("defaults to warn", () => {
    expect(resolveMode()).toBe("warn");
  });

  it("takes the env override", () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    expect(resolveMode()).toBe("deny");
  });
});

describe("the deny persists while the contradiction does", () => {
  beforeEach(() => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
  });

  it("denies the same contradictory edit twice -- asking again is not an exception", async () => {
    // The escape this replaces: a `denied` set that let attempt two through, so
    // any model that disagreed with the gate only had to repeat itself.
    const pi = fakePi();
    registerEvidenceGate(pi.api);

    const first = await pi.write(flipEdit(STEP2));
    const second = await pi.write(flipEdit(STEP2));
    expect(first?.block).toBe(true);
    expect(second?.block).toBe(true);
    expect(payloads("evidence.decision").map((p) => p.outcome)).toEqual(["blocked", "blocked"]);
  });

  it("keeps denying across a third and fourth attempt", async () => {
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    for (let i = 0; i < 4; i++) {
      expect((await pi.write(flipEdit(STEP2)))?.block).toBe(true);
    }
    expect(payloads("evidence.decision")).toHaveLength(4);
  });

  it("points the agent at the user's override rather than at a retry", async () => {
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    const blocked = await pi.write(flipEdit(STEP2));
    expect(blocked?.reason).toMatch(/\/override plan-a-step-2/);
    expect(blocked?.reason).toMatch(/Do not retry this write unchanged/);
  });
});

describe("/override -- the user-originated exception", () => {
  it("records the step, the invocation status at the time, and the reason", async () => {
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 job finished on .eu, block is stale");

    const [row] = payloads("evidence.override");
    expect(row).toMatchObject({
      step: "#plan-a-step-2",
      invocationStatus: "in_progress",
      invocationId: "abc0000000000001",
      reason: "job finished on .eu, block is stale",
      mode: "warn",
    });
    expect(activityRows("evidence.override")[0].source).toBe("user");
  });

  it("allows exactly one write, then denies the next contradiction on that step", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);

    expect((await pi.write(flipEdit(STEP2)))?.block).toBe(true);

    await pi.runCommand("override", "plan-a-step-2 verified the BAM by hand");
    const allowed = await pi.write(flipEdit(STEP2));
    expect(allowed).toBeUndefined();

    // A later attempt at the same flip while the invocation is still in flight.
    // The gate adjudicates writes rather than applying them, so the notebook on
    // disk is unchanged and this is a fresh contradiction; the spent token does
    // not cover it.
    expect((await pi.write(flipEdit(STEP2)))?.block).toBe(true);

    expect(payloads("evidence.decision").map((p) => p.outcome)).toEqual([
      "blocked",
      "overridden",
      "blocked",
    ]);
  });

  it("records the invocation id, so a warn-mode row can be adjudicated later", async () => {
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    await pi.write(flipEdit(STEP2));
    expect(payloads("evidence.decision")[0].contradictions).toEqual([
      { step: "#plan-a-step-2", status: "in_progress", invocationId: "abc0000000000001" },
    ]);
  });

  it("names the overridden step in the decision it let through", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 checked by hand");
    await pi.write(flipEdit(STEP2));
    expect(payloads("evidence.decision")[0]).toMatchObject({
      outcome: "overridden",
      overridden: ["#plan-a-step-2"],
    });
  });

  it("does not spend the token on a write that is blocked anyway", async () => {
    // Two contradicted steps in one edit, one of them overridden. The write is
    // still refused, so the flip the user authorised never happened -- burning
    // the token here would make them grant it twice for one flip.
    process.env.LOOM_EVIDENCE_GATE = "deny";
    setNotebook(
      withInvocation(
        invocation(),
        invocation({ invocationId: "def0000000000002", notebookAnchor: "plan-a-step-1" }),
      ),
    );
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 checked by hand");

    const both = await pi.write({
      path: "notebook.md",
      edits: [
        { oldText: `- [ ] ${STEP1}`, newText: `- [x] ${STEP1}` },
        { oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` },
      ],
    });
    expect(both?.block).toBe(true);
    // ...and it is still there for the flip it was granted for.
    expect(await pi.write(flipEdit(STEP2))).toBeUndefined();
  });

  it("only the overridden step is cleared -- the reason is not a blanket pass", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    setNotebook(
      withInvocation(
        invocation(),
        invocation({ invocationId: "def0000000000002", notebookAnchor: "plan-a-step-1" }),
      ),
    );
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 checked by hand");
    expect((await pi.write(flipEdit(STEP1)))?.block).toBe(true);
  });

  it("refuses to pre-authorise a step nothing is holding", async () => {
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-1 just in case");
    expect(pi.notices[0]).toMatch(/Nothing to override/);
    expect(payloads("evidence.override")).toHaveLength(0);
  });

  it("refuses without a reason, and says why", async () => {
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2");
    expect(pi.notices[0]).toMatch(/reason is required/);
    expect(payloads("evidence.override")).toHaveLength(0);
  });

  it("bare /override lists what the gate is holding, and under what key", async () => {
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "");
    expect(pi.notices[0]).toMatch(/Evidence gate: warn/);
    expect(pi.notices[0]).toMatch(/plan-a-step-2\s+in_progress\s+2\. \*\*Align reads\*\*/);
  });

  it("addresses a step whose anchor contains spaces", async () => {
    // ANCHOR is `\{#([^}]+)\}`, so this is a legal anchor. Splitting the
    // argument at the first space would make such a step un-overridable --
    // the gate failing closed with no way through.
    const spacey = PLAN.replace("{#plan-a-step-2}", "{#align step 2}");
    setNotebook(
      spacey + "\n" + renderInvocationYaml(invocation({ notebookAnchor: "align step 2" })),
    );
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "align step 2 checked the BAM by hand");
    expect(payloads("evidence.override")[0]).toMatchObject({
      step: "#align step 2",
      reason: "checked the BAM by hand",
    });
  });

  it("gates a write that spells the path the way pi will resolve it", async () => {
    // pi's resolveToCwd strips a leading `@` and expands `~`, so a literal
    // path.resolve sends these somewhere else and the gate abstained on a
    // write pi was about to make.
    process.env.LOOM_EVIDENCE_GATE = "deny";
    for (const spelling of ["@notebook.md", "./notebook.md", nbPath]) {
      resetEvidenceOverrides();
      const pi = fakePi();
      registerEvidenceGate(pi.api);
      const blocked = await pi.write({
        path: spelling,
        edits: [{ oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` }],
      });
      expect(blocked?.block, spelling).toBe(true);
    }
  });

  it("gates a write that names the notebook only under file_path", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    const blocked = await pi.write({
      file_path: "notebook.md",
      edits: [{ oldText: `- [ ] ${STEP2}`, newText: `- [x] ${STEP2}` }],
    });
    expect(blocked?.block).toBe(true);
  });

  it("refuses an ambiguous key rather than picking one", async () => {
    // Anchors are model-authored. With `align` and `align checked` both live,
    // longest-prefix would silently aim the user's clearance at the wrong step
    // and eat the first words of their reason as part of the key.
    const two = PLAN.replace("{#plan-a-step-1}", "{#align}").replace(
      "{#plan-a-step-2}",
      "{#align checked}",
    );
    setNotebook(
      two +
        "\n" +
        renderInvocationYaml(invocation({ notebookAnchor: "align" })) +
        "\n" +
        renderInvocationYaml(
          invocation({ invocationId: "def0000000000002", notebookAnchor: "align checked" }),
        ),
    );
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "align checked the BAM by hand");
    expect(pi.notices[0]).toMatch(/could mean/);
    expect(payloads("evidence.override")).toHaveLength(0);

    // Quoting is the way through.
    await pi.runCommand("override", '"align" checked the BAM by hand');
    expect(payloads("evidence.override")[0]).toMatchObject({
      step: "#align",
      reason: "checked the BAM by hand",
    });
  });

  it("survives an anchor with a double space", async () => {
    const spacey = PLAN.replace("{#plan-a-step-2}", "{#align  step}");
    setNotebook(
      spacey + "\n" + renderInvocationYaml(invocation({ notebookAnchor: "align  step" })),
    );
    const pi = fakePi();
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "align  step checked by hand");
    expect(payloads("evidence.override")[0]).toMatchObject({ step: "#align  step" });
  });

  it("a clearance does not carry over to a later run of the same step", async () => {
    // Granted while one invocation was in flight; that one fails and a rerun
    // starts. The user approved that run being ahead of its checkbox.
    process.env.LOOM_EVIDENCE_GATE = "deny";
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 the first run is basically done");

    setNotebook(
      withInvocation(
        invocation({ invocationId: "abc0000000000001", status: "failed" }),
        invocation({ invocationId: "def0000000000002", status: "in_progress" }),
      ),
    );
    expect((await pi.write(flipEdit(STEP2)))?.block).toBe(true);
  });

  it("accepts the gate's own key spelling as well as the bare anchor", () => {
    const content = withInvocation(invocation());
    expect(planOverride(content, "#plan-a-step-2 fine").ok).toBe(true);
    expect(planOverride(content, "plan-a-step-2 fine").ok).toBe(true);
    expect(planOverride(content, "PLAN-A-STEP-2 fine").ok).toBe(true);
    expect(planOverride(content, "plan-a-step-9 fine").ok).toBe(false);
  });

  it("records the invocation the clearance is for", () => {
    const content = withInvocation(invocation());
    const result = planOverride(content, "plan-a-step-2 fine");
    expect(result.ok && result.event.invocationId).toBe("abc0000000000001");
  });

  it("does not survive a session boundary", async () => {
    process.env.LOOM_EVIDENCE_GATE = "deny";
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 checked by hand");
    await pi.sessionStart();
    expect((await pi.write(flipEdit(STEP2)))?.block).toBe(true);
  });
});

describe("warn mode is untouched by any of this", () => {
  it("records `warned` on every attempt and blocks none of them", async () => {
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    for (let i = 0; i < 3; i++) {
      expect(await pi.write(flipEdit(STEP2))).toBeUndefined();
    }
    expect(payloads("evidence.decision").map((p) => p.outcome)).toEqual([
      "warned",
      "warned",
      "warned",
    ]);
  });

  it("does not spend an override, because there was nothing to clear", async () => {
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    registerEvidenceOverrideCommand(pi.api);
    await pi.runCommand("override", "plan-a-step-2 checked by hand");
    await pi.write(flipEdit(STEP2));
    expect(payloads("evidence.decision")[0].outcome).toBe("warned");

    // Still spendable once the mode is raised.
    process.env.LOOM_EVIDENCE_GATE = "deny";
    expect(await pi.write(flipEdit(STEP2))).toBeUndefined();
  });

  it("an uncontradicted flip is recorded, not warned", async () => {
    setNotebook(withInvocation(invocation({ status: "completed" })));
    const pi = fakePi();
    registerEvidenceGate(pi.api);
    await pi.write(flipEdit(STEP2));
    expect(payloads("evidence.decision")[0].outcome).toBe("recorded");
  });
});

describe("adjudicateNotebookWrite", () => {
  const before = withInvocation(invocation());
  const call = flipEdit(STEP2);

  it("an override only counts in deny mode -- warn had nothing to clear", () => {
    const granted = new Set([overrideToken("#plan-a-step-2", "abc0000000000001")]);
    expect(adjudicateNotebookWrite(before, "edit", call, "warn", granted).outcome).toBe("warned");
    expect(adjudicateNotebookWrite(before, "edit", call, "deny", granted).outcome).toBe(
      "overridden",
    );
  });

  it("blocks when the granted key is for a different step", () => {
    const granted = new Set([overrideToken("#plan-a-step-1", "abc0000000000001")]);
    const a = adjudicateNotebookWrite(before, "edit", call, "deny", granted);
    expect(a.block).toBe(true);
    expect(a.unresolved).toHaveLength(1);
    expect(a.cleared).toHaveLength(0);
  });

  it("blocks when the clearance was granted for a different run of the same step", () => {
    // The user approved one run being ahead of its checkbox, not the step.
    const granted = new Set([overrideToken("#plan-a-step-2", "def0000000000002")]);
    expect(adjudicateNotebookWrite(before, "edit", call, "deny", granted).block).toBe(true);
  });

  it("says nothing at all when the write carries no completion", () => {
    const plain = { path: "notebook.md", edits: [{ oldText: "### Steps", newText: "### Plan" }] };
    const a = adjudicateNotebookWrite(before, "edit", plain, "deny", new Set());
    expect(a.outcome).toBe("recorded");
    expect(a.decision.completions).toHaveLength(0);
  });
});
