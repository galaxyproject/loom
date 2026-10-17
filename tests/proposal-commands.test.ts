import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveCommand,
  checkProposalDrift,
  checkProposalDriftNow,
  noteProposalBinding,
  sessionView,
  pendingCommand,
  propose,
  registerProposalCommands,
  revokeCommand,
  type ProposalDeps,
  type ProposeParams,
} from "../extensions/loom/proposal-commands";
import { findProposalBlocks, renderProposalBlock } from "../extensions/loom/notebook-writer";
import { liveApproval } from "../extensions/loom/registry-proposal";
import {
  closeSessionRegistry,
  openSessionRegistry,
  type SessionRegistry,
} from "../extensions/loom/registry-runtime";
import { RegistryStore } from "../extensions/loom/registry";
import type { TemplateSnapshot } from "../extensions/loom/registry-submitter";
import { TemplateUnavailableError } from "../extensions/loom/registry-templates";
import { SERVER, tmpAnalysisDir } from "./registry-fixtures";
import { TOOL_ID, TOOL_SNAPSHOT, toolProposal } from "./registry-proposal-fixtures";

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
afterEach(() => {
  closeSessionRegistry();
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

  it("an edit to the label alone leaves the approval live", async () => {
    const id = await proposed();
    await approveCommand(deps(), `${id} --yes`);
    const edited = notebook().replace("label: Trim reads", "label: Trim the reads");
    fs.writeFileSync(nb, edited);
    expect(checkProposalDrift(deps(), edited)).toEqual([]);
    expect(liveApproval(session!.store.snapshot(), id)).toBeDefined();
  });

  it("the drift check runs on every notebook change once registered", async () => {
    const state = await import("../extensions/loom/state");
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
