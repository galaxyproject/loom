import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveCommand,
  approvedRunPrompt,
  checkProposalDrift,
  classifyChatApproval,
  checkProposalDriftNow,
  noteProposalBinding,
  sessionView,
  pendingCommand,
  propose,
  registerProposalCommands,
  revokeCommand,
  type ProposalDeps,
  type ProposeParams,
} from "../extensions/orbit/proposal-commands";
import {
  findProposalBlocks,
  renderProposalBlock,
  withNotebookLock,
} from "../extensions/orbit/notebook-writer";
import { liveApproval } from "../extensions/orbit/registry-proposal";
import {
  closeSessionRegistry,
  openSessionRegistry,
  type SessionRegistry,
} from "../extensions/orbit/registry-runtime";
import { RegistryStore } from "../extensions/orbit/registry";
import type { TemplateSnapshot } from "../extensions/orbit/registry-submitter";
import { SERVER, tmpAnalysisDir } from "./registry-fixtures";
import { datatypeAccepts, TemplateUnavailableError } from "../extensions/orbit/registry-templates";
import { GalaxyApiError } from "../extensions/orbit/galaxy-api";
import { setRecordStore } from "../extensions/orbit/record-store";
import {
  CONVERTERS,
  DATATYPES,
  MANIFEST_ID,
  NANOPLOT_ID,
  NANOPLOT_SNAPSHOT,
  TOOL_ID,
  TOOL_SNAPSHOT,
  toolProposal,
} from "./registry-proposal-fixtures";

const NOTEBOOK =
  "# Analysis\n\n## Plan A: QC [remote]\n\n- [ ] 1. **Trim** {#plan-a-step-1} -- fastp\n- [ ] 2. **Align** {#plan-a-step-2}\n";

let dir: string;
let nb: string;
let session: SessionRegistry | null;
let galaxyUrl: string | null;
let snapshot: TemplateSnapshot;
let fetches: number;
let rnd: number;

function deps(over: Partial<ProposalDeps> = {}): ProposalDeps {
  return {
    registry: () => session,
    notebookPath: () => nb,
    galaxyUrl: () => galaxyUrl,
    historyId: () => "df8fe5ddadbf3ab1",
    fetcher: () => async () => {
      fetches++;
      return snapshot;
    },
    now: () => "2026-10-07T12:00:00.000Z",
    random: (n) => new Uint8Array(n).fill(rnd++),
    ...over,
  };
}

const params = (over: Partial<ProposeParams> = {}): ProposeParams => ({
  step_anchor: "plan-a-step-1",
  label: "Trim reads",
  target: { kind: "tool", id: TOOL_ID },
  inputs: [{ slot: "reads", src: "hda", id: "4b6e2f1a9c3d5e70" }],
  overrides: [{ param: "threads", value: 4, rationale: "the queue gives four cores" }],
  predicate: { kind: "exists_with_ext", ext: "fastqsanger" },
  ...over,
});

function notebook(): string {
  return fs.readFileSync(nb, "utf-8");
}

function activity(): Array<{ kind: string; source: string; payload: Record<string, any> }> {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind !== "registry.opened");
}

async function proposed(): Promise<string> {
  const r = await propose(deps(), params());
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.proposal.proposalId;
}

beforeEach(() => {
  dir = tmpAnalysisDir();
  nb = path.join(dir, "notebook.md");
  fs.writeFileSync(nb, NOTEBOOK);
  galaxyUrl = SERVER;
  snapshot = TOOL_SNAPSHOT;
  fetches = 0;
  rnd = 0;
  session = openSessionRegistry({
    analysisDir: dir,
    sessionId: "s-a",
    serverUrl: SERVER,
    heartbeatMs: null,
  }).session;
});
afterEach(async () => {
  closeSessionRegistry();
  // /revoke clears the notebook's echo without awaiting it; queue behind it on the
  // record lock so it has finished writing before the directory goes.
  await withNotebookLock(nb, async () => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loom_propose", () => {
  it("validates, writes the block, records proposal.created, and returns the table", async () => {
    const r = await propose(deps(), params());
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.proposal.proposalId).toBe("prop-000000");
    expect(r.proposal.serverUrl).toBe(SERVER);
    expect(r.table).toContain("| Proposal | prop-000000 |");
    const [block] = findProposalBlocks(notebook());
    expect(block.proposal).toEqual(r.proposal);
    expect(activity()).toEqual([
      expect.objectContaining({
        kind: "proposal.created",
        source: "loom_propose",
        payload: expect.objectContaining({
          proposal_id: "prop-000000",
          step_anchor: "plan-a-step-1",
        }),
      }),
    ]);
  });

  it.each([
    [
      "a slot the tool doesn't have",
      { inputs: [{ slot: "fastq", src: "hda", id: "d1" }] },
      /"fastq" is not a dataset input/,
    ],
    ["no required input", { inputs: [] }, /required input "reads"/],
    [
      "a bad parameter name",
      { overrides: [{ param: "thread", value: 1, rationale: "r" }] },
      /"thread" is not a parameter/,
    ],
    [
      "an override without a rationale",
      { overrides: [{ param: "threads", value: 1 }] },
      /needs a rationale/,
    ],
    [
      "a step the notebook doesn't have",
      { step_anchor: "plan-z-step-9" },
      /Unknown notebook anchor/,
    ],
    [
      "assertions, which don't exist yet",
      { assertions: ["a1"] },
      /assertions aren't available yet/,
    ],
  ])("refuses %s and writes nothing", async (_name, over, pattern) => {
    const r = await propose(deps(), params(over as Partial<ProposeParams>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(pattern);
    expect(notebook()).toBe(NOTEBOOK);
    expect(activity()).toEqual([]);
  });

  it("refuses when Galaxy can't describe the target", async () => {
    const r = await propose(
      deps({
        fetcher: () => async () => {
          throw new TemplateUnavailableError("Galaxy couldn't describe tool nope: 404");
        },
      }),
      params(),
    );
    expect(r).toEqual({ ok: false, problems: ["Galaxy couldn't describe tool nope: 404"] });
    expect(notebook()).toBe(NOTEBOOK);
  });

  it("refuses without Galaxy, and takes the server from the session, not the model", async () => {
    galaxyUrl = null;
    expect(await propose(deps(), params())).toMatchObject({ ok: false });
  });

  it("never reuses an id the notebook or the registry already has", async () => {
    rnd = 0;
    await proposed();
    rnd = 0; // same random bytes again
    const second = await propose(deps(), params());
    if (!second.ok) throw new Error("expected a second proposal");
    expect(second.proposal.proposalId).not.toBe("prop-000000");
  });
});

describe("/approve", () => {
  it("freezes, records a live approval, echoes spec_revision, logs proposal.approved", async () => {
    const id = await proposed();
    const reply = await approveCommand(deps(), `${id} --yes`);
    expect(reply.level).toBe("info");
    expect(reply.message).toMatch(new RegExp(`Approved ${id}`));
    const live = liveApproval(session!.store.snapshot(), id);
    expect(live?.approval).toMatchObject({ status: "live", by: "user" });
    expect(notebook()).toContain(`spec_revision: ${live!.approval!.spec_revision}`);
    expect(activity().map((e) => e.kind)).toEqual(["proposal.created", "proposal.approved"]);
    expect(activity()[1]).toMatchObject({
      source: "user",
      payload: { proposal_id: id, attempt_id: live!.attempt_id },
    });
  });

  it("asks first when there is a UI, and records nothing on a no", async () => {
    const id = await proposed();
    let shown = "";
    const reply = await approveCommand(deps(), id, {
      confirm: async (_t, message) => {
        shown = message;
        return false;
      },
    });
    expect(shown).toMatch(/param threads +4 -- the queue gives four cores/);
    expect(reply.message).toMatch(/Not approved/);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("refuses if the block changed while the user was looking at it", async () => {
    const id = await proposed();
    const reply = await approveCommand(deps(), id, {
      confirm: async () => {
        fs.writeFileSync(nb, notebook().replace('"value":4', '"value":64'));
        return true;
      },
    });
    expect(reply.message).toMatch(/changed in the notebook while it was being approved/);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("re-validates a hand-written block against what Galaxy says now", async () => {
    fs.writeFileSync(
      nb,
      NOTEBOOK +
        "\n" +
        renderProposalBlock(toolProposal({ inputs: [{ slot: "nope", src: "hda", id: "d" }] })),
    );
    const reply = await approveCommand(deps(), "prop-abc123");
    expect(reply.message).toMatch(/doesn't match what Galaxy says now[\s\S]*"nope"/);
  });

  it("ignores a forged spec_revision in a hand-written block", async () => {
    fs.writeFileSync(
      nb,
      NOTEBOOK + "\n" + renderProposalBlock(toolProposal(), { specRevision: "f".repeat(64) }),
    );
    expect(liveApproval(session!.store.snapshot(), "prop-abc123")).toBeUndefined();
    expect((await pendingCommand(deps())).message).toMatch(/prop-abc123 -- not approved/);
  });

  it("refuses an unknown id, a duplicated id, and an unreadable block", async () => {
    expect((await approveCommand(deps(), "prop-zzzzzz")).message).toMatch(
      /No proposal prop-zzzzzz/,
    );
    const block = renderProposalBlock(toolProposal());
    fs.writeFileSync(nb, NOTEBOOK + "\n" + block + "\n" + block);
    expect((await approveCommand(deps(), "prop-abc123")).message).toMatch(/2 blocks claiming/);
    fs.writeFileSync(nb, NOTEBOOK + "\n" + block.replace(/^inputs: .*$/m, "inputs: [x"));
    expect((await approveCommand(deps(), "prop-abc123")).message).toMatch(/can't be read/);
  });

  it("refuses from a read-only registry", async () => {
    closeSessionRegistry();
    const holder = new RegistryStore({
      analysisDir: dir,
      serverUrl: SERVER,
      sessionId: "s-other",
      fs,
      clock: Date.now,
      pid: 999,
    });
    holder.open();
    session = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s-a",
      serverUrl: SERVER,
      heartbeatMs: null,
    }).session;
    fs.writeFileSync(nb, NOTEBOOK + "\n" + renderProposalBlock(toolProposal()));
    const reply = await approveCommand(deps(), "prop-abc123");
    expect(reply.message).toMatch(/Can't approve: the approval registry is read-only/);
    expect(fetches).toBe(0);
    holder.close();
  });

  it("refuses when Galaxy moved to another server since the session started", async () => {
    const id = await proposed();
    galaxyUrl = "https://elsewhere.example";
    expect((await approveCommand(deps(), id)).message).toMatch(/Restart the session/);
  });

  it("with no id, lists what is pending", async () => {
    await proposed();
    expect((await approveCommand(deps(), "")).message).toMatch(
      /1 pending proposal[\s\S]*Usage: \/approve/,
    );
  });
});

describe("/approve with no dialog to confirm in", () => {
  it("refuses without --yes, showing the table, and records nothing but the refusal", async () => {
    const id = await proposed();
    const reply = await approveCommand(deps(), id);
    expect(reply.level).toBe("warning");
    expect(reply.message).toMatch(/no dialog here to confirm in/);
    expect(reply.message).toMatch(/param threads +4 -- the queue gives four cores/);
    expect(reply.message).toContain(`/approve ${id} --yes`);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.approval_unconfirmed",
      payload: { proposal_id: id, table: expect.stringContaining("param threads") },
    });
  });

  it("approves with --yes and puts the frozen table on the record", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.approved",
      payload: {
        confirmed_by: "--yes",
        table: expect.stringMatching(/spec_revision +[0-9a-f]{12}/),
      },
    });
  });

  it("still asks in the dialog when there is one, --yes or not", async () => {
    const id = await proposed();
    let asked = false;
    await approveCommand(deps(), `${id} --yes`, {
      confirm: async () => {
        asked = true;
        return false;
      },
    });
    expect(asked).toBe(true);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("says when Galaxy's template changed since the proposal", async () => {
    const id = await proposed();
    snapshot = {
      ...TOOL_SNAPSHOT,
      body: { ...TOOL_SNAPSHOT.body, description: "updated upstream" },
    };
    const reply = await approveCommand(deps(), id);
    expect(reply.message).toMatch(/template for this target changed since it was proposed/);
  });

  it("does not take --yes as the proposal id", async () => {
    expect((await approveCommand(deps(), "--yes")).message).toMatch(/Usage: \/approve/);
  });
});

describe("edit after approve revokes, on the next read", () => {
  it("an edit that changes what would run revokes and logs proposal.revoked", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const attempt = liveApproval(session!.store.snapshot(), id)!.attempt_id;
    const edited = notebook().replace('"value":4', '"value":64');
    fs.writeFileSync(nb, edited);
    const drift = checkProposalDrift(deps(), edited);
    expect(drift).toEqual([{ attemptId: attempt, proposalId: id, reason: "edited" }]);
    expect(session!.store.snapshot().attempts[attempt].approval?.status).toBe("revoked");
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.revoked",
      source: "harness",
      payload: { proposal_id: id, attempt_id: attempt, reason: "edited" },
    });
    expect((await pendingCommand(deps())).message).toMatch(new RegExp(`${id} -- approval revoked`));
  });

  it("starts a turn to submit the run once approved, and only then", async () => {
    const sent: string[] = [];
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerTool: () => {},
      registerCommand: (name: string, c: { handler: typeof handler }) => {
        if (name === "approve") handler = c.handler;
      },
      on: () => {},
      sendUserMessage: (text: string) => sent.push(text),
    } as never;
    registerProposalCommands(pi, deps());
    const id = await proposed();
    const ctx = { hasUI: false, ui: { notify: () => {} } };
    await handler!(`${id} --yes`, ctx);
    expect(sent).toEqual([approvedRunPrompt(id)]);
    expect(sent[0]).toContain(`proposalId: "${id}"`);
    await handler!(`${id} --yes`, ctx); // already approved: nothing new to submit
    await handler!("prop-nope --yes", ctx);
    expect(sent).toHaveLength(1);
  });

  it("an edit to the label alone leaves the approval live", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const edited = notebook().replace("label: Trim reads", "label: Trim the reads");
    fs.writeFileSync(nb, edited);
    expect(checkProposalDrift(deps(), edited)).toEqual([]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
  });

  it("the drift check runs on every notebook change once registered", async () => {
    const state = await import("../extensions/orbit/state");
    const pi = { registerTool: () => {}, registerCommand: () => {}, on: () => {} } as never;
    registerProposalCommands(pi, deps());
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    state.setNotebookPath(nb);
    try {
      await state.reemitNotebookIfChanged();
      expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
      // A hand edit the watcher (or the after-tool re-sync) notices.
      fs.writeFileSync(
        nb,
        notebook().replace("step_anchor: plan-a-step-1", "step_anchor: plan-a-step-2"),
      );
      expect(await state.reemitNotebookIfChanged()).toBe(true);
      expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
    } finally {
      state.setNotebookPath(null);
    }
  });
});

describe("map-over through loom_propose and /approve (#615)", () => {
  it("proposes NanoPlot over a collection, says it runs per element, and approves it", async () => {
    snapshot = NANOPLOT_SNAPSHOT;
    let text = "";
    const pi = {
      registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
        if (t.name === "loom_propose") {
          void t
            .execute("call-1", {
              ...params({
                target: { kind: "tool", id: NANOPLOT_ID },
                inputs: [{ slot: "mode|reads|files", src: "hdca", id: "a1c62e0f5b3d7790" }],
                overrides: [],
              }),
            })
            .then((r) => {
              text = (r as { content: Array<{ text: string }> }).content[0].text;
            });
        }
      },
      registerCommand: () => {},
      on: () => {},
    } as never;
    registerProposalCommands(pi, deps());
    await vi.waitFor(() => expect(text).not.toBe(""));
    expect(text).toMatch(/^Proposed prop-/);
    expect(text).toMatch(/maps over the collection given to mode\|reads\|files/);
    expect(text).toMatch(/runs once per element, one job each/);

    const id = text.match(/^Proposed (\S+)\./)![1];
    const r = await approveCommand(deps(), `${id} --yes`);
    expect(r.message).toMatch(/^Approved /);
    expect(r.message).toMatch(/runs once per element/);
  });
});

describe("format check through loom_propose and /approve (#618)", () => {
  const formats =
    (exts: Record<string, string[]>): ProposalDeps["formats"] =>
    () =>
    async () => ({
      extensions: new Map(Object.entries(exts)),
      accepts: datatypeAccepts(DATATYPES, CONVERTERS),
    });
  const nanoplot = (id: string, src: "hda" | "hdca" = "hda") =>
    params({
      target: { kind: "tool", id: NANOPLOT_ID },
      inputs: [{ slot: "mode|reads|files", src, id }],
      overrides: [],
    });

  beforeEach(() => {
    snapshot = NANOPLOT_SNAPSHOT;
  });

  it("refuses Scott's manifest at proposal time and writes nothing", async () => {
    const r = await propose(
      deps({ formats: formats({ [`hda:${MANIFEST_ID}`]: ["tsv"] }) }),
      nanoplot(MANIFEST_ID),
    );
    expect(r).toEqual({
      ok: false,
      problems: [expect.stringMatching(/takes fastq, .* but dataset \S+ is tsv\./)],
    });
    expect(findProposalBlocks(notebook())).toEqual([]);
  });

  it("re-checks at /approve, so a dataset relabeled since then is refused", async () => {
    const r = await propose(
      deps({ formats: formats({ "hda:d1": ["fastqsanger"] }) }),
      nanoplot("d1"),
    );
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.formatsUnchecked).toEqual([]);
    const reply = await approveCommand(
      deps({ formats: formats({ "hda:d1": ["tabular"] }) }),
      `${r.proposal.proposalId} --yes`,
    );
    expect(reply.message).toMatch(/^Not approved -- .*\n- input slot "mode\|reads\|files" takes/);
    expect(liveApproval(session!.store.snapshot(), r.proposal.proposalId)).toBeUndefined();
  });

  it("shows the person approving what it couldn't check", async () => {
    const r = await propose(deps({ formats: formats({}) }), nanoplot("d3"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    let shown = "";
    await approveCommand(deps({ formats: formats({}) }), r.proposal.proposalId, {
      confirm: async (_t, message) => {
        shown = message;
        return false;
      },
    });
    expect(shown).toMatch(/Formats not checked:\n- mode\|reads\|files: Galaxy didn't say/);
  });

  it("puts what it couldn't check on the approval's record", async () => {
    const r = await propose(deps({ formats: formats({}) }), nanoplot("d4"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const unchecked = [expect.stringMatching(/didn't say what format dataset d4/)];
    await approveCommand(deps({ formats: formats({}) }), r.proposal.proposalId);
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.approval_unconfirmed",
      payload: { formats_unchecked: unchecked },
    });
    await approveCommand(deps({ formats: formats({}) }), `${r.proposal.proposalId} --yes`);
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.approved",
      payload: { formats_unchecked: unchecked },
    });
  });

  it("lists what it couldn't check in the tool's reply", async () => {
    let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
        if (t.name === "loom_propose") tool = t;
      },
      registerCommand: () => {},
      on: () => {},
    } as never;
    registerProposalCommands(pi, deps({ formats: formats({}) }));
    const r = (await tool!.execute("call-1", nanoplot("d2"))) as {
      content: Array<{ text: string }>;
    };
    expect(r.content[0].text).toMatch(
      /Formats not checked \(Galaxy will say at submission if they're wrong\):\n- mode\|reads\|files: Galaxy didn't say what format dataset d2/,
    );
  });

  it("lists what it couldn't check when there's no dialog to approve in", async () => {
    const r = await propose(deps({ formats: formats({}) }), nanoplot("d5"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const reply = await approveCommand(deps({ formats: formats({}) }), r.proposal.proposalId);
    expect(reply.message).toMatch(/^Not approved: there's no dialog/);
    expect(reply.message).toMatch(/Formats not checked:\n- mode\|reads\|files: Galaxy didn't say/);
  });
});

describe("/revoke and /pending", () => {
  it("revokes a live approval, then has nothing to revoke", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    expect((await revokeCommand(deps(), id)).message).toMatch(/Revoked the approval/);
    expect((await revokeCommand(deps(), id)).message).toMatch(/no live approval/);
    expect(activity().at(-1)).toMatchObject({ kind: "proposal.revoked", source: "user" });
  });

  it("says when nothing is pending", async () => {
    expect((await pendingCommand(deps())).message).toBe("No proposals in the notebook.");
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    expect((await pendingCommand(deps())).message).toBe("Nothing pending; 1 proposal(s) approved.");
  });
});

describe("the model has no way to approve", () => {
  it("registers exactly one tool, and it can't record an approval", async () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
    } as never;
    registerProposalCommands(pi, deps());
    expect(tools).toEqual(["loom_propose"]);
    expect(commands.sort()).toEqual(["approve", "pending", "revoke"]);
    await proposed();
    expect(Object.keys(session!.store.snapshot().attempts)).toEqual([]);
  });
});

describe("record tools binding a run to its proposal", () => {
  const run = { kind: "job" as const, id: "j1" };

  it("logs the agent's claim against the live approval's attempt, and touches nothing else", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const before = JSON.stringify(session!.store.snapshot());
    const nbBefore = notebook();
    const r = await noteProposalBinding(deps(), {
      proposalId: id,
      notebookAnchor: "plan-a-step-1",
      run,
    });
    const attempt = liveApproval(session!.store.snapshot(), id)!.attempt_id;
    expect(r).toEqual({ bound: true, attemptId: attempt });
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.bound",
      source: "record-tool",
      payload: { proposal_id: id, attempt_id: attempt, run_id: "j1", declared_by: "agent" },
    });
    expect(JSON.stringify(session!.store.snapshot())).toBe(before);
    expect(notebook()).toBe(nbBefore);
  });

  it("won't bind to a proposal that isn't approved, or to another step", async () => {
    const id = await proposed();
    expect(
      await noteProposalBinding(deps(), { proposalId: id, notebookAnchor: "plan-a-step-1", run }),
    ).toEqual({
      bound: false,
      reason: `${id} has no live approval in this session`,
    });
    await approveCommand(deps(), `${id} --yes`);
    expect(
      await noteProposalBinding(deps(), { proposalId: id, notebookAnchor: "plan-a-step-2", run }),
    ).toMatchObject({ bound: false, reason: expect.stringMatching(/approved for plan-a-step-1/) });
    expect(activity().some((e) => e.kind === "proposal.bound")).toBe(false);
  });
});

describe("review follow-ups", () => {
  it("deleting the approved step revokes", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    fs.writeFileSync(
      nb,
      notebook()
        .replace("## Plan A: QC [remote]", "## Notes")
        .replace(/^- \[ \] 1\. \*\*Trim\*\*.*$/m, ""),
    );
    expect(await checkProposalDriftNow(deps())).toEqual([
      expect.objectContaining({ proposalId: id, reason: "step_removed" }),
    ]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("deleting the notebook revokes", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    fs.rmSync(nb);
    expect(await checkProposalDriftNow(deps())).toEqual([
      expect.objectContaining({ proposalId: id, reason: "removed" }),
    ]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("an unreadable-but-present notebook revokes nothing", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    expect(await checkProposalDriftNow(deps({ notebookPath: () => dir }))).toEqual([]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
  });

  it("a record page Galaxy can't serve right now revokes nothing; a page that's gone does", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    let failure: Error = new GalaxyApiError(503, "", "Service Unavailable");
    setRecordStore({
      kind: "page",
      key: nb,
      label: "Galaxy page p1",
      pageId: "p1",
      stat: async () => null,
      read: async () => {
        throw failure;
      },
      write: async () => {},
      ensure: async () => false,
      onChange: () => () => {},
    });
    try {
      expect(await checkProposalDriftNow(deps())).toEqual([]);
      expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
      failure = new GalaxyApiError(404, "", "Not Found");
      expect(await checkProposalDriftNow(deps())).toEqual([
        expect.objectContaining({ proposalId: id, reason: "removed" }),
      ]);
    } finally {
      setRecordStore(null);
    }
  });

  it("the approval table shows a long value whole", async () => {
    const long = "y".repeat(150) + "END";
    const r = await propose(
      deps(),
      params({ overrides: [{ param: "threads", value: long, rationale: "r" }] }),
    );
    if (!r.ok) throw new Error(r.problems.join("; "));
    let shown = "";
    await approveCommand(deps(), r.proposal.proposalId, {
      confirm: async (_t, m) => {
        shown = m;
        return false;
      },
    });
    expect(shown).toContain("END");
  });
});

describe("drift when the registry can't be written", () => {
  it("a session that lost the lock stops treating an edited proposal as live", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const attempt = liveApproval(session!.store.snapshot(), id)!.attempt_id;
    // Lose the lock with nothing on disk to reload: the approval stays live
    // in this store's memory, now read-only.
    fs.rmSync(session!.store.registryPath);
    fs.writeFileSync(
      session!.store.lockPath,
      JSON.stringify({
        pid: 999,
        session_id: "s-thief",
        writer_token: "f".repeat(32),
        heartbeat: new Date().toISOString(),
      }),
    );
    expect(session!.store.heartbeat()).toBe(false);
    expect(session!.store.mode).toBe("read-only");
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();

    const edited = notebook().replace('"value":4', '"value":64');
    fs.writeFileSync(nb, edited);
    expect(checkProposalDrift(deps(), edited)).toEqual([
      { attemptId: attempt, proposalId: id, reason: "edited" },
    ]);
    expect(activity().at(-1)).toMatchObject({
      kind: "proposal.revoked",
      payload: { attempt_id: attempt, recorded: "in memory; registry not writable" },
    });
    expect(liveApproval(sessionView(session!), id)).toBeUndefined();
    expect(
      await noteProposalBinding(deps(), {
        proposalId: id,
        notebookAnchor: "plan-a-step-1",
        run: { kind: "job", id: "j1" },
      }),
    ).toMatchObject({ bound: false });
    expect((await pendingCommand(deps())).message).toMatch(new RegExp(`${id} -- approval revoked`));
    // Reported once, not on every later look.
    expect(checkProposalDrift(deps(), edited)).toEqual([]);
  });

  it("a writer whose revocation write fails holds it, then writes it on the next look", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const attempt = liveApproval(session!.store.snapshot(), id)!.attempt_id;
    const spy = vi.spyOn(session!.store, "update").mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: busy"), { code: "EPERM" });
    });
    const edited = notebook().replace('"value":4', '"value":64');
    fs.writeFileSync(nb, edited);
    expect(checkProposalDrift(deps(), edited)).toHaveLength(1);
    expect(session!.store.snapshot().attempts[attempt].approval?.status).toBe("live");
    expect(liveApproval(sessionView(session!), id)).toBeUndefined();
    spy.mockRestore();
    expect(checkProposalDrift(deps(), edited)).toEqual([]);
    expect(session!.store.snapshot().attempts[attempt].approval?.status).toBe("revoked");
  });
});

describe("classifyChatApproval", () => {
  const ID = "prop-abc123";
  it.each([
    "The parameters look right. Go ahead and run it.",
    "I approve.",
    "approved",
    "Yes, proceed.",
    "lgtm, run it",
    "Looks good -- do it.",
    `approve ${ID}`,
    "OK, go ahead.",
    "Go ahead and submit it please",
  ])("approves %j", (text) => {
    expect(classifyChatApproval(text, ID)).toBe("approve");
  });

  it.each([
    "I approve the plan above. Show the full parameter table for review before executing.",
    "don't run it yet",
    "go ahead?",
    "approve but set exp to 8",
    "approve prop-zzzzzz",
    "Wait, change the column value first.",
    "Not yet.",
    "Hold on",
    "Run the Add column tool on the first dataset.",
    "",
    `Go ahead. ${"x".repeat(300)}`,
    // Each of these reached "approve" through the old phrase-plus-blocklist check.
    "Never run it",
    "Go ahead if the checks pass",
    "Yes, explain the results",
    "yes",
    "lgtm",
    "My grant got approved. Now look at the BED file.",
    "Yes, use hg19 as the reference",
    "Yes, set the threshold to 5",
    "Proceed with sample 2 rather than sample 1",
    "Nope, do it with value 8",
    "go ahead and explain the parameters",
    "I approve the plan. Add a QC step.",
  ])("does not approve %j", (text) => {
    expect(classifyChatApproval(text, ID)).toBe("none");
  });
});

describe("a plain chat approval of the one pending proposal", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  function load(over: Partial<ProposalDeps> = {}) {
    const on = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
    const pi = {
      registerTool: (t: typeof tool) => (tool = t),
      registerCommand: () => {},
      on: (event: string, h: (event: unknown, ctx: unknown) => unknown) => on.set(event, h),
    } as never;
    registerProposalCommands(pi, deps({ chatWithoutDialog: () => true, ...over }));
    const reply = (text: string) =>
      (on.get("agent_end") as Handler)(
        {
          type: "agent_end",
          messages: [
            { role: "user", content: [{ type: "text", text: "earlier" }] },
            { role: "assistant", content: [{ type: "text", text }] },
          ],
        },
        {},
      );
    return {
      // What a model normally does: propose, then show the table with the id in its reply.
      propose: async (p: Partial<ProposeParams> = {}, { shown = true } = {}) => {
        const r = await tool.execute("c1", params(p), undefined);
        const id = r.content[0].text.match(/prop-[0-9a-z]{6}/)![0];
        if (shown) await reply(`| Proposal | ${id} |\nType /approve ${id} or say go ahead.`);
        return id;
      },
      reply,
      input: (text: string, event: object = {}, ctx: object = { hasUI: false }) =>
        (on.get("input") as Handler)({ type: "input", text, source: "interactive", ...event }, ctx),
      sessionStart: () => on.get("session_start")!({}, {}),
    };
  }
  const approvals = () => activity().filter((e) => e.kind === "proposal.approved");

  it("records the approval and tells the model to submit exactly that run", async () => {
    const h = load();
    const id = await h.propose();
    const text = "The parameters look right. Go ahead and run it.";
    const out = (await h.input(text)) as { action: string; text: string };
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
    expect(approvals()).toEqual([
      expect.objectContaining({
        source: "user",
        payload: expect.objectContaining({
          proposal_id: id,
          confirmed_by: "chat",
          chat_text: text,
          table: expect.stringContaining(id),
        }),
      }),
    ]);
    expect(out.action).toBe("transform");
    expect(out.text.startsWith(text)).toBe(true);
    expect(out.text).toContain(`[Orbit: approved ${id} (attempt `);
    // Without the id on the record call, the run never binds to this approval.
    expect(out.text).toContain(`proposalId: "${id}"`);
  });

  it("ignores text the model's own extensions sent, and input while streaming", async () => {
    const h = load();
    const id = await h.propose();
    expect(await h.input("Go ahead.", { source: "extension" })).toEqual({ action: "continue" });
    expect(await h.input("Go ahead.", { streamingBehavior: "steer" })).toEqual({
      action: "continue",
    });
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("asks for the id when two proposals are pending", async () => {
    const h = load();
    await h.propose();
    await h.propose({ step_anchor: "plan-a-step-2" });
    const out = (await h.input("Go ahead and run it.")) as { action: string; text: string };
    expect(approvals()).toEqual([]);
    expect(out.action).toBe("transform");
    expect(out.text).toContain("/approve <proposal-id>");
  });

  it("counts a revoked proposal as pending, so the approval doesn't say which", async () => {
    const h = load();
    const a = await h.propose();
    expect((await approveCommand(deps(), `${a} --yes`)).message).toMatch(/^Approved/);
    await revokeCommand(deps(), a);
    await h.propose({ step_anchor: "plan-a-step-2" });
    const out = (await h.input("Go ahead and run it.")) as { text: string };
    expect(approvals()).toHaveLength(1);
    expect(out.text).toContain("/approve <proposal-id>");
  });

  it("doesn't count a revoked proposal from before this session as pending", async () => {
    const earlier = await proposed();
    await approveCommand(deps(), `${earlier} --yes`);
    await revokeCommand(deps(), earlier);
    const h = load();
    const id = await h.propose({ step_anchor: "plan-a-step-2" });
    const out = (await h.input("Go ahead and run it.")) as { text: string };
    expect(out.text).toContain(`[Orbit: approved ${id} (attempt `);
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
  });

  it("doesn't count a revoked proposal that already ran as pending", async () => {
    const h = load();
    const a = await h.propose();
    await approveCommand(deps(), `${a} --yes`);
    const attempt = liveApproval(session!.store.snapshot(), a)!.attempt_id;
    session!.store.update((draft) => {
      draft.attempts[attempt].submission = {
        job_id: "7dd125b61b35d782",
        submitted_at: "2026-10-07T12:01:00.000Z",
        submitted_by: "harness",
        server_verified: true,
        check: { outcome: "conformant_by_construction", mode: "deny" },
        request_digest: "b".repeat(64),
        dispatch_recheck: {
          definition_digest_ok: true,
          template_digest_ok: true,
          at: "2026-10-07T12:00:59.000Z",
        },
      } as never;
    });
    await revokeCommand(deps(), a);
    const id = await h.propose({ step_anchor: "plan-a-step-2" });
    const out = (await h.input("Go ahead and run it.")) as { text: string };
    expect(out.text).toContain(`[Orbit: approved ${id} (attempt `);
  });

  it("never approves a proposal this session did not write", async () => {
    const h = load();
    const other = await proposed();
    await h.reply(`Type /approve ${other}.`);
    expect(await h.input("Go ahead and run it.")).toEqual({ action: "continue" });
    const id = await h.propose({ step_anchor: "plan-a-step-2" });
    await h.sessionStart();
    await h.reply(`Type /approve ${id}.`);
    expect(await h.input("Go ahead and run it.")).toEqual({ action: "continue" });
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("only answers the reply that put the proposal in front of the user", async () => {
    const h = load();
    const id = await h.propose({}, { shown: false });
    // Proposed, but the reply never named it: the user may not have seen the table.
    expect(await h.input("Go ahead and run it.")).toEqual({ action: "continue" });
    await h.reply(`Here it is: /approve ${id}`);
    expect(await h.input("What does the value column do?")).toEqual({ action: "continue" });
    await h.reply("It adds a constant column. Should I also add a QC step?");
    expect(await h.input("Go ahead.")).toEqual({ action: "continue" });
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
  });

  it("refuses when the block changed after loom_propose wrote it", async () => {
    const h = load();
    const id = await h.propose();
    fs.writeFileSync(nb, notebook().replace('"value":4', '"value":64'));
    const out = (await h.input("Go ahead and run it.")) as { text: string };
    expect(approvals()).toEqual([]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
    expect(out.text).toContain("[Orbit: not approved");
    expect(out.text).toContain(`/approve ${id}`);
  });

  it("without a dialog, outside an eval, shows the table and asks for /approve --yes", async () => {
    const h = load({ chatWithoutDialog: () => false });
    const id = await h.propose();
    const out = (await h.input("Go ahead and run it.")) as { text: string };
    expect(approvals()).toEqual([]);
    expect(out.text).toContain(`/approve ${id} --yes`);
    expect(out.text).toMatch(new RegExp(`Proposal\\s+${id}`));
  });

  it("shows the harness dialog where there is one", async () => {
    const h = load({ chatWithoutDialog: () => false });
    const id = await h.propose();
    const no = vi.fn(async () => false);
    const out = (await h.input("Go ahead.", {}, { hasUI: true, ui: { confirm: no } })) as {
      text: string;
    };
    expect(no).toHaveBeenCalledOnce();
    expect(out.text).toContain("still pending");
    expect(liveApproval(session!.store.snapshot(), id)).toBeUndefined();
    await h.reply(`Still waiting on ${id}.`);
    const yes = vi.fn(async () => true);
    await h.input("Go ahead.", {}, { hasUI: true, ui: { confirm: yes } });
    expect(approvals().at(-1)?.payload.confirmed_by).toBe("chat+dialog");
  });

  it("passes a refusal through to the model", async () => {
    const h = load();
    await h.propose();
    snapshot = { ...snapshot, body: { ...(snapshot.body as object), inputs: [] } };
    const out = (await h.input("Go ahead.")) as { text: string };
    expect(approvals()).toEqual([]);
    expect(out.text).toContain("[Orbit: not approved");
  });

  it("leaves input alone with nothing pending or no approval in it", async () => {
    const h = load();
    expect(await h.input("Go ahead.")).toEqual({ action: "continue" });
    await h.propose();
    expect(await h.input("What does the value column do?")).toEqual({ action: "continue" });
  });
});

describe("approveCommand's outcome", () => {
  it("says approved, with the attempt, both the first time and when already approved", async () => {
    const id = await proposed();
    const first = await approveCommand(deps(), `${id} --yes`);
    expect(first.attemptId).toMatch(/\S/);
    expect(first.approved).toBe(id);
    const again = await approveCommand(deps(), `${id} --yes`);
    expect(again.message).toMatch(/already approved/);
    expect(again.attemptId).toBe(first.attemptId);
    // Nothing new to submit, so /approve starts no follow-up turn.
    expect(again.approved).toBeUndefined();
  });

  it("says declined when the dialog is turned down", async () => {
    const id = await proposed();
    const r = await approveCommand(deps(), id, { confirm: async () => false });
    expect(r.declined).toBe(true);
    expect(r.attemptId).toBeUndefined();
    expect(r.approved).toBeUndefined();
  });
});

describe("seeded proposal ids for evals", () => {
  it("mints the seeded ids in order, reusing one a failed proposal never wrote", async () => {
    const d = deps({ seededIds: () => ["bogus", "prop-eva001", "prop-eva002"] });
    const bad = await propose(d, params({ step_anchor: "plan-z-step-9" }));
    expect(bad.ok).toBe(false);
    const first = await propose(d, params());
    const second = await propose(d, params({ step_anchor: "plan-a-step-2" }));
    const third = await propose(d, params({ step_anchor: "plan-a-step-2" }));
    if (!first.ok || !second.ok || !third.ok) throw new Error("not proposed");
    expect(first.proposal.proposalId).toBe("prop-eva001");
    expect(second.proposal.proposalId).toBe("prop-eva002");
    expect(third.proposal.proposalId).toMatch(/^prop-(?!eva)/);
    expect(activity().filter((e) => e.kind === "proposal.id_seeded")).toEqual([
      expect.objectContaining({ payload: { proposal_id: "prop-eva001" } }),
      expect.objectContaining({ payload: { proposal_id: "prop-eva002" } }),
    ]);
  });
});

describe("proposal wording accepts both kinds of approval", () => {
  it("the tool description and result name /approve and a plain chat approval", async () => {
    let tool: {
      description: string;
      execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }>;
    };
    const pi = {
      registerTool: (t: typeof tool) => (tool = t),
      registerCommand: () => {},
      on: () => {},
    } as never;
    registerProposalCommands(pi, deps());
    expect(tool!.description).toContain("/approve <proposal-id>");
    expect(tool!.description).toMatch(/approve it plainly in chat/);
    const text = (await tool!.execute("c1", params(), undefined)).content[0].text;
    expect(text).toMatch(/\/approve prop-/);
    expect(text).toMatch(/approve it plainly in chat/);
  });
});

describe("the system prompt's approval wording", () => {
  it("accepts /approve and a plain chat approval, and makes the table the review", async () => {
    const { executingAStep } = await import("../shared/prompt-blocks.js");
    const text = executingAStep();
    expect(text).toContain("`/approve <proposal-id>`");
    expect(text).toMatch(/approve it\s+plainly in\s+chat/);
    expect(text).toMatch(/table is that\s+review/);
  });
});
