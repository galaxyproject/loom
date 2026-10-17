import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  INVOCATION_LISTING_LIMIT,
  boundHistoryId,
  inferAnalysisStart,
  parseGalaxyTime,
  reconcile,
  resetReconcileState,
  runReconcile,
  type ReconcileDeps,
} from "../extensions/loom/galaxy-reconcile";
import type { GalaxyJobListing, InvocationDetail } from "../extensions/loom/galaxy-api";
import { findJobBlocks, upsertJobBlock, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { findInvocationBlocks, upsertInvocationBlock } from "../extensions/loom/notebook-writer";
import { renderGalaxyPageBlock } from "../extensions/loom/galaxy-page-binding";
import {
  readAttemptRecord,
  readReconcileState,
  type AttemptRecord,
} from "../extensions/loom/galaxy-provenance";
import { setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { isUlid, ulid } from "../extensions/loom/ulid";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const SERVER = "https://usegalaxy.org";
const HISTORY = "0a248a1f62a0cc04";
const SINCE = Date.parse("2026-10-07T00:00:00Z");

function binding(historyId = HISTORY, server = SERVER): string {
  return renderGalaxyPageBlock({
    pageId: "aaaa000000000001",
    pageSlug: null,
    galaxyServerUrl: server,
    historyId,
    lastSyncedRevision: null,
    boundAt: "2026-10-07T00:00:00Z",
  });
}

function job(over: Partial<JobYaml> = {}): JobYaml {
  return {
    jobId: "aa11",
    galaxyServerUrl: SERVER,
    notebookAnchor: "plan-a-step-1",
    label: "fastp",
    submittedAt: "2026-10-07T09:00:00.000Z",
    status: "completed",
    serverVerified: true,
    ...over,
  };
}

describe("reconcile helpers", () => {
  it("reads Galaxy's naive timestamps as UTC", () => {
    expect(parseGalaxyTime("2026-10-07T10:00:00.123456")).toBe(
      Date.parse("2026-10-07T10:00:00.123Z"),
    );
    expect(parseGalaxyTime("2026-10-07T10:00:00Z")).toBe(Date.parse("2026-10-07T10:00:00Z"));
    expect(parseGalaxyTime("soon")).toBeNaN();
  });

  const rec = (over: Partial<AttemptRecord>): AttemptRecord => ({
    schema: 1,
    attempt_id: ulid(),
    kind: "jobs",
    galaxy_server_url: SERVER,
    history_id: "bbbb000000000002",
    submitted_by: "harness",
    created_at: "2026-10-07T10:00:00.000Z",
    ids: { job_ids: ["aa11"] },
    origin: "submission",
    enrichment: { state: "pending", attempts: 0, updated_at: "" },
    jobs: {},
    ...over,
  });

  it("binds to the history the harness last submitted into, over a page binding", () => {
    const records = [
      rec({ created_at: "2026-10-07T09:00:00Z", history_id: "cccc000000000003" }),
      rec({}),
    ];
    // A page binding names another history: notebook text loses to the record.
    expect(boundHistoryId(binding(), SERVER, records)).toEqual({
      historyId: "bbbb000000000002",
      source: "submission",
    });
  });

  it("falls back to the page binding only when the harness has submitted nothing here", () => {
    expect(boundHistoryId(binding(), SERVER, [])).toEqual({
      historyId: HISTORY,
      source: "page_binding",
    });
    expect(boundHistoryId(binding(HISTORY, "https://other.org"), SERVER, [])).toBeNull();
    // Records made by reconcile, from a fixture, or on another server don't count.
    expect(
      boundHistoryId("", SERVER, [
        rec({ origin: "reconcile" }),
        rec({ fixture: true }),
        rec({ galaxy_server_url: "https://other.org" }),
      ]),
    ).toBeNull();
    // A recorded block's history_id is notebook text, not a binding.
    const recorded = upsertJobBlock("", job(), {
      historyId: "bbbb000000000002",
      submittedBy: "harness",
    });
    expect(boundHistoryId(recorded, SERVER, [])).toBeNull();
  });

  it("dates the analysis from its earliest protected submission, never from editable text", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(inferAnalysisStart([], now)).toBe(now);
    expect(
      inferAnalysisStart(
        [
          rec({ created_at: "2026-10-05T08:00:00Z" }),
          rec({ origin: "reconcile", created_at: "2026-01-01T00:00:00Z" }),
        ],
        now,
      ),
    ).toBe(Date.parse("2026-10-05T08:00:00Z"));
  });
});

describe("reconcile", () => {
  let dir: string;
  let nbPath: string;
  let jobs: GalaxyJobListing[];
  let invocations: { id: string; create_time?: string; state?: string; workflow_id?: string }[];
  let invocationDetails: Record<string, InvocationDetail>;
  let verdicts: Record<string, "found" | "absent" | "unreachable">;
  let verifyCalls: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-reconcile-"));
    nbPath = path.join(dir, "notebook.md");
    resetState();
    resetReconcileState();
    setNotebookPath(nbPath);
    process.env.GALAXY_URL = SERVER;
    process.env.GALAXY_API_KEY = "k";
    jobs = [];
    invocations = [];
    invocationDetails = {};
    verdicts = {};
    verifyCalls = [];
  });

  afterEach(() => {
    resetState();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  const deps = (): Partial<ReconcileDeps> => ({
    listJobs: async ({ offset }) => (offset === 0 ? jobs : []),
    listInvocations: async () => invocations,
    getInvocation: async (id) => {
      const inv = invocationDetails[id];
      if (!inv) throw new Error(`503 for ${id}`);
      return inv;
    },
    verify: async (kind, id) => {
      verifyCalls.push(`${kind}:${id}`);
      const v = verdicts[id] ?? "found";
      return v === "found" ? { outcome: "found" } : { outcome: v, detail: `${v} ${id}` };
    },
    now: () => Date.parse("2026-10-07T12:00:00Z"),
  });

  const write = (content: string) => fs.writeFileSync(nbPath, content);
  const read = () => fs.readFileSync(nbPath, "utf-8");
  const rows = (kind: string) => {
    const file = path.join(dir, "activity.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === kind);
  };

  it("records a job no block claims, as unattributed and unknown, and only once", async () => {
    write(
      binding() + "\n" + upsertJobBlock("", job(), { submittedBy: "harness", attemptId: ulid() }),
    );
    jobs = [
      { id: "aa11", state: "ok", tool_id: "fastp", create_time: "2026-10-07T09:00:00" },
      {
        id: "cc33",
        state: "ok",
        tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0",
        tool_version: "0.24.0",
        create_time: "2026-10-07T10:00:00",
      },
    ];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed.map((u) => u.id)).toEqual(["cc33"]);

    const found = findJobBlocks(read()).find((b) => b.jobId === "cc33")!;
    expect(found).toMatchObject({
      notebookAnchor: "unattributed",
      submittedBy: "unknown",
      serverVerified: true,
      status: "completed",
      historyId: HISTORY,
      enrichment: "pending",
      label: "fastp (found on Galaxy)",
    });
    expect(found.jobs).toEqual([
      {
        jobId: "cc33",
        toolId: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0",
        toolVersion: "0.24.0",
      },
    ]);
    expect(isUlid(found.attemptId!)).toBe(true);
    expect((await readAttemptRecord(dir, found.attemptId!))!.ids).toEqual({ job_ids: ["cc33"] });
    expect(rows("reconcile.unattributed")[0].payload).toMatchObject({
      block_kind: "job",
      id: "cc33",
      trigger: "command",
    });

    const before = read();
    const again = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(again.unattributed).toEqual([]);
    expect(read()).toBe(before);
    expect(rows("reconcile.unattributed")).toHaveLength(1);
  });

  it("files a workflow's step jobs under the invocation, not as standalone runs", async () => {
    write(binding());
    invocations = [
      { id: "dd44", create_time: "2026-10-07T10:00:00", state: "scheduled", workflow_id: "ee55" },
    ];
    invocationDetails.dd44 = {
      id: "dd44",
      steps: [{ order_index: 1, jobs: [{ id: "ff66", state: "ok" }] }],
    } as unknown as InvocationDetail;
    jobs = [{ id: "ff66", state: "ok", create_time: "2026-10-07T10:01:00" }];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed).toEqual([
      expect.objectContaining({ kind: "invocation", id: "dd44" }),
    ]);
    expect(findJobBlocks(read())).toEqual([]);
    expect(findInvocationBlocks(read())[0]).toMatchObject({
      invocationId: "dd44",
      status: "in_progress",
      submittedBy: "unknown",
      notebookAnchor: "unattributed",
      label: "workflow ee55 (found on Galaxy)",
    });
  });

  it("holds standalone jobs back when an invocation's jobs could not be listed", async () => {
    write(binding());
    invocations = [{ id: "dd44", create_time: "2026-10-07T10:00:00", state: "scheduled" }];
    jobs = [{ id: "ff66", state: "ok", create_time: "2026-10-07T10:01:00" }];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.error).toContain("dd44");
    expect(findJobBlocks(read())).toEqual([]);
    expect(rows("reconcile.incomplete")).toHaveLength(1);
  });

  it("ignores work from before the window", async () => {
    write(binding());
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-06T23:59:00" }];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed).toEqual([]);
  });

  it("downgrades a block Galaxy says is gone, and only on an explicit trigger", async () => {
    write(
      binding() +
        "\n" +
        upsertJobBlock("", job({ jobId: "aa11" })) +
        "\n" +
        upsertJobBlock("", job({ jobId: "bb22" })),
    );
    verdicts = { aa11: "absent", bb22: "unreachable" };

    await reconcile(HISTORY, SINCE, { trigger: "tick", deps: deps() });
    expect(verifyCalls).toEqual([]);

    const result = await reconcile(HISTORY, SINCE, { trigger: "session_start", deps: deps() });
    expect(result.unverified).toEqual([{ kind: "job", id: "aa11" }]);
    const blocks = findJobBlocks(read());
    expect(blocks.find((b) => b.jobId === "aa11")!.serverVerified).toBe(false);
    // No answer is not an answer.
    expect(blocks.find((b) => b.jobId === "bb22")!.serverVerified).toBe(true);
    expect(rows("reconcile.unverified")[0].payload).toMatchObject({ id: "aa11" });
  });

  it("counts in-flight blocks Galaxy lists as finished, for the poller to transition", async () => {
    write(
      binding() + "\n" + upsertJobBlock("", job({ status: "in_progress" }), { attemptId: ulid() }),
    );
    jobs = [{ id: "aa11", state: "ok", create_time: "2026-10-07T09:00:00" }];
    const result = await reconcile(HISTORY, SINCE, { trigger: "tick", deps: deps() });
    expect(result.terminalSeen).toBe(1);
    // Reconcile did not write the transition itself.
    expect(findJobBlocks(read())[0].status).toBe("in_progress");
  });

  it("adopts a block recorded before enrichment existed", async () => {
    write(binding() + "\n" + upsertJobBlock("", job()));
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.adopted).toBe(1);
    const [block] = findJobBlocks(read());
    expect(block.enrichment).toBe("pending");
    expect(isUlid(block.attemptId!)).toBe(true);
    expect(block.submittedBy).toBeUndefined();
  });

  it("keeps a cursor: the analysis start is fixed, the stamp only moves forward", async () => {
    write(binding());
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-07T10:00:00" }];
    await runReconcile("command", deps());
    const state = await readReconcileState(dir);
    expect(state!.histories[`${SERVER}|${HISTORY}`].stamp).toBe("2026-10-07T10:00:00.000Z");
    const start = state!.analysis_started_at;

    jobs = [];
    await runReconcile("command", deps());
    const after = await readReconcileState(dir);
    expect(after!.analysis_started_at).toBe(start);
    expect(after!.histories[`${SERVER}|${HISTORY}`].stamp).toBe("2026-10-07T10:00:00.000Z");
  });

  it("under a page notebook keeps the cursor in memory and touches no .loom directory", async () => {
    write("# Notebook\n");
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    try {
      const result = await runReconcile("session_start", deps());
      expect(result.skipped).toBe("no history is bound to this analysis yet");
      expect(await readReconcileState(dir)).toMatchObject({ schema: 1 });
      expect(fs.existsSync(path.join(dir, ".loom"))).toBe(false);
    } finally {
      setCapabilityProfile(null);
    }
  });

  it("with no bound history, lists nothing but still checks what is recorded", async () => {
    write(upsertJobBlock("", job()));
    verdicts = { aa11: "absent" };
    const result = await runReconcile("command", deps());
    expect(result.skipped).toMatch(/no history/);
    expect(result.unverified).toEqual([{ kind: "job", id: "aa11" }]);
  });

  it("an unclaimed invocation id that is not a Galaxy id is never written", async () => {
    write(binding());
    invocations = [{ id: "../histories", create_time: "2026-10-07T10:00:00", state: "scheduled" }];
    jobs = [{ id: "a b", state: "ok" } as GalaxyJobListing];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed).toEqual([]);
    expect(findInvocationBlocks(read())).toEqual([]);
  });

  it("does not record a run a concurrent writer recorded first", async () => {
    write(binding());
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-07T10:00:00" }];
    const racing = deps();
    const listJobs = racing.listJobs!;
    racing.listJobs = async (params) => {
      const rows = await listJobs(params);
      // The submission hook lands its block while reconcile is listing.
      fs.appendFileSync(
        nbPath,
        "\n" + upsertJobBlock("", job({ jobId: "cc33" }), { submittedBy: "harness" }),
      );
      return rows;
    };
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: racing });
    expect(result.unattributed).toEqual([]);
    const blocks = findJobBlocks(read()).filter((b) => b.jobId === "cc33");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].submittedBy).toBe("harness");
  });

  it("skips rows Galaxy says belong to another history", async () => {
    write(binding());
    jobs = [
      {
        id: "cc33",
        state: "ok",
        history_id: "ffff000000000000",
        create_time: "2026-10-07T10:00:00",
      },
    ];
    invocations = [
      {
        id: "dd44",
        state: "scheduled",
        history_id: "ffff000000000000",
        create_time: "2026-10-07T10:00:00",
      },
    ];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed).toEqual([]);
  });

  it("holds standalone jobs and the cursor back when the invocation listing may be cut short", async () => {
    write(binding());
    invocations = Array.from({ length: INVOCATION_LISTING_LIMIT }, (_, i) => ({
      id: (0xa000 + i).toString(16).padStart(16, "0"),
      state: "scheduled",
      create_time: "2026-10-06T00:00:00",
    }));
    for (const inv of invocations) {
      invocationDetails[inv.id] = { id: inv.id, steps: [] } as unknown as InvocationDetail;
    }
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-07T10:00:00" }];
    const result = await runReconcile("command", deps());
    expect(result.unattributed.filter((u) => u.kind === "job")).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect((await readReconcileState(dir))!.histories).toEqual({});
  });

  it("a planted jobs summary does not hide a real run from reconcile", async () => {
    write(
      binding() + "\n" + upsertJobBlock("", job({ jobId: "aa11" }), { jobs: [{ jobId: "cc33" }] }),
    );
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-07T10:00:00" }];
    const result = await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    expect(result.unattributed.map((u) => u.id)).toEqual(["cc33"]);
  });

  it("blocks written from fixture answers claim no server verification", async () => {
    write(binding());
    jobs = [{ id: "cc33", state: "ok", create_time: "2026-10-07T10:00:00" }];
    setGalaxyFetchOverride(async () => new Response("{}"));
    try {
      await reconcile(HISTORY, SINCE, { trigger: "command", deps: deps() });
    } finally {
      setGalaxyFetchOverride(null);
    }
    const [block] = findJobBlocks(read());
    expect(block.serverVerified).toBeUndefined();
    expect((await readAttemptRecord(dir, block.attemptId!))!.fixture).toBe(true);
  });

  it("seals the first page binding: editing it later does not move reconcile", async () => {
    write(binding());
    jobs = [];
    expect((await runReconcile("command", deps())).historyId).toBe(HISTORY);
    write(binding("eeee000000000009"));
    expect((await runReconcile("command", deps())).historyId).toBe(HISTORY);
  });
});
