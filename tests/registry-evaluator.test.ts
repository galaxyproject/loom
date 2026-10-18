import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GalaxyApiError } from "../extensions/loom/galaxy-api";
import {
  evaluateRegistryAttempts,
  renderRegistryProjection,
  resetRegistryEvaluator,
  type EvaluatorDeps,
} from "../extensions/loom/registry-evaluator";
import { findJobBlocks, renderJobYaml } from "../extensions/loom/galaxy-job-block";
import {
  closeSessionRegistry,
  openSessionRegistry,
  recordActiveAtShutdown,
} from "../extensions/loom/registry-runtime";
import {
  canonicalJson,
  sha256Hex,
  specRevision,
  type Attempt,
  type Registry,
} from "../extensions/loom/registry-schema";
import { eligibleAttempt, makeSpec, SERVER, tmpAnalysisDir } from "./registry-fixtures";

let dir: string;

const JOB = "7dd125b61b35d782";
const OUT = "0f3e9a1c2b4d6e87";

function rows(kind: string): Array<Record<string, any>> {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === kind);
}

/** Freeze a template for the attempt's Spec on disk, as /approve would have. */
function freezeTemplate(a: Attempt): Attempt {
  const body = { tool: "cat1", inputs: ["input1"] };
  const text = canonicalJson(body);
  const digest = sha256Hex(text);
  const dirT = path.join(dir, ".loom", "state", "templates");
  fs.mkdirSync(dirT, { recursive: true });
  fs.writeFileSync(path.join(dirT, `${digest}.json`), text);
  a.approval!.spec_snapshot.template_ref.digest = digest;
  a.approval!.spec_revision = specRevision(a.approval!.spec_snapshot);
  return a;
}

/** A registry another session wrote: on open it is an import. */
function plantForeignRegistry(...attempts: Attempt[]): void {
  for (const a of attempts) if (a.approval) freezeTemplate(a);
  const reg: Registry = {
    version: 3,
    revision: 4,
    writer_token: "theirs",
    session_sig: "f".repeat(64),
    analysis_id: "an-1",
    server_url: SERVER,
    attempts: Object.fromEntries(attempts.map((a) => [a.attempt_id, a])),
    exceptions: [],
    supervision: { active_at_shutdown: [] },
  };
  const stateDir = path.join(dir, ".loom", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "registry.json"), canonicalJson(reg));
}

function open() {
  return openSessionRegistry({
    analysisDir: dir,
    sessionId: "s-a",
    serverUrl: SERVER,
    heartbeatMs: null,
  }).session;
}

function jobDetails(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    tool_id: "cat1",
    state: "ok",
    history_id: "df8fe5ddadbf3ab1",
    params: {
      queries: JSON.stringify([{ input2: { values: [{ src: "hda", id: "8c1d3e5f7a9b0c21" }] } }]),
    },
    inputs: { input1: { id: "4b6e2f1a9c3d5e70", src: "hda" } },
    outputs: { out_file1: { id: OUT, src: "hda" } },
    ...over,
  };
}

function deps(over: Partial<EvaluatorDeps> = {}): Partial<EvaluatorDeps> {
  return {
    getJob: async (id) => {
      if (id !== JOB) throw new GalaxyApiError(404, "no such job", "");
      return jobDetails() as never;
    },
    getDataset: async () => ({ extension: "tabular", state: "ok" }),
    getInvocation: async () => {
      throw new GalaxyApiError(404, "no", "");
    },
    // The version Galaxy's job details drop, as capture recorded it at submission.
    records: async () => [
      {
        schema: 1,
        attempt_id: "01J0000000000000000000000A",
        kind: "jobs",
        galaxy_server_url: SERVER,
        history_id: "df8fe5ddadbf3ab1",
        submitted_by: "agent",
        created_at: "2026-09-25T12:00:02.000Z",
        ids: { job_ids: [JOB] },
        origin: "submission",
        seeds: { [JOB]: { tool_id: "cat1", tool_version: "1.0.0" } },
        enrichment: { state: "complete", attempts: 1, updated_at: "2026-09-25T12:01:00.000Z" },
        jobs: {},
      },
    ],
    now: () => Date.parse("2026-09-25T12:10:00.000Z"),
    connected: () => true,
    withinOrigin: (_origin, work) => work(),
    ...over,
  };
}

beforeEach(() => {
  dir = tmpAnalysisDir();
  resetRegistryEvaluator();
});
afterEach(() => {
  closeSessionRegistry();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("evaluation writer", () => {
  it("re-verifies an imported attempt against Galaxy and makes it eligible under its own label", async () => {
    const a = eligibleAttempt();
    plantForeignRegistry(a);
    const session = open();
    expect(session.store.snapshot().attempts[a.attempt_id].handoff_eligible).toBe(false);

    const pass = await evaluateRegistryAttempts("session_start", deps({ registry: () => session }));
    expect(pass.evaluated).toEqual([a.attempt_id]);
    const got = session.store.snapshot().attempts[a.attempt_id];
    expect(got.submission?.check.outcome).toBe("conformant_by_reconcile");
    expect(got.submission?.server_verified).toBe(true);
    expect(got.evaluation).toMatchObject({
      execution: "success",
      conformity: "conformant",
      predicate_result: "pass",
      integrity: "ok",
      authority: "established",
    });
    expect(got.provenance?.authority).toBe("established");
    expect(got.handoff_eligible).toBe(true);
    // The facts the provenance names are stored, content-addressed.
    expect(fs.existsSync(path.join(dir, got.provenance!.ref.id))).toBe(true);

    const evaluated = rows("registry.evaluated");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0].payload).toMatchObject({
      attempt_id: a.attempt_id,
      step_anchor: "step-2",
      check: "conformant_by_reconcile",
      handoff_eligible: true,
    });
  });

  it("writes nothing, and no row, when a second pass learns nothing new", async () => {
    plantForeignRegistry(eligibleAttempt());
    const session = open();
    await evaluateRegistryAttempts("command", deps({ registry: () => session }));
    const revision = session.store.snapshot().revision;
    const pass = await evaluateRegistryAttempts("command", deps({ registry: () => session }));
    expect(pass.unchanged).toHaveLength(1);
    expect(session.store.snapshot().revision).toBe(revision);
    expect(rows("registry.evaluated")).toHaveLength(1);
  });

  it("a tick only re-asks about attempts that aren't settled", async () => {
    plantForeignRegistry(eligibleAttempt());
    const session = open();
    await evaluateRegistryAttempts("command", deps({ registry: () => session }));
    let asked = 0;
    await evaluateRegistryAttempts(
      "tick",
      deps({
        registry: () => session,
        getJob: async () => {
          asked++;
          return jobDetails() as never;
        },
      }),
    );
    expect(asked).toBe(0);
  });

  it("records a run Galaxy doesn't know as unverified identity, never eligible", async () => {
    const a = eligibleAttempt();
    plantForeignRegistry(a);
    const session = open();
    await evaluateRegistryAttempts(
      "command",
      deps({
        registry: () => session,
        getJob: async () => {
          throw new GalaxyApiError(404, "gone", "");
        },
      }),
    );
    const got = session.store.snapshot().attempts[a.attempt_id];
    expect(got.evaluation?.integrity).toBe("unverified_identity");
    expect(got.handoff_eligible).toBe(false);
  });

  it("writes nothing when Galaxy can't be asked", async () => {
    const a = eligibleAttempt();
    plantForeignRegistry(a);
    const session = open();
    const before = session.store.snapshot();
    const pass = await evaluateRegistryAttempts(
      "command",
      deps({
        registry: () => session,
        getJob: async () => {
          throw new GalaxyApiError(502, "bad gateway", "");
        },
      }),
    );
    expect(pass.unreachable).toEqual([a.attempt_id]);
    expect(session.store.snapshot().revision).toBe(before.revision);
  });

  it("evaluates a mapped-over invocation across every job it ran", async () => {
    const spec = makeSpec({
      target: { kind: "workflow", workflow_id: "f2db41e1fa331b3e", version: "2" },
      inputs: [],
      overrides: [],
      predicate: { kind: "exists_with_ext", ext: "tabular", min_count: 2 },
    });
    const a = eligibleAttempt({ spec });
    a.kind = "workflow";
    a.submission!.job_id = undefined;
    a.submission!.invocation_id = "aa11bb22cc33dd44";
    plantForeignRegistry(a);
    const session = open();
    const jobs = ["1111111111111111", "2222222222222222"];
    await evaluateRegistryAttempts(
      "command",
      deps({
        registry: () => session,
        getInvocation: async (id) =>
          ({
            id,
            state: "scheduled",
            history_id: "df8fe5ddadbf3ab1",
            inputs: { "0": { id: "4b6e2f1a9c3d5e70", src: "hdca" } },
            steps: [
              { order_index: 0, jobs: [] },
              {
                order_index: 1,
                jobs: jobs.map((j) => ({ id: j, state: "ok", tool_id: "cat1" })),
              },
            ],
          }) as never,
        getJob: async (id) =>
          jobDetails({
            id,
            outputs: { out_file1: { id: `${id.slice(0, 15)}f`, src: "hda" } },
          }) as never,
      }),
    );
    const got = session.store.snapshot().attempts[a.attempt_id];
    expect(got.evaluation).toMatchObject({
      execution: "success",
      predicate_result: "pass",
      // A workflow can't be re-checked yet: the invocation doesn't say which version ran.
      conformity: "unverified",
    });
    expect(got.submission?.check.outcome).toBe("unverified");
    expect(got.handoff_eligible).toBe(false);
    expect(rows("registry.evaluated")[0].payload.run).toEqual({
      kind: "invocation",
      id: "aa11bb22cc33dd44",
    });
  });

  it("leaves an invocation with a job still running as unknown", async () => {
    const a = eligibleAttempt();
    a.submission!.job_id = undefined;
    a.submission!.invocation_id = "aa11bb22cc33dd44";
    plantForeignRegistry(a);
    const session = open();
    await evaluateRegistryAttempts(
      "command",
      deps({
        registry: () => session,
        getInvocation: async (id) =>
          ({
            id,
            state: "scheduled",
            steps: [{ order_index: 0, jobs: [{ id: JOB, state: "running", tool_id: "cat1" }] }],
          }) as never,
        getJob: async () => jobDetails({ state: "running" }) as never,
      }),
    );
    expect(session.store.snapshot().attempts[a.attempt_id].evaluation?.execution).toBe("unknown");
  });

  it("skips quietly when the registry is read-only or there's no Galaxy", async () => {
    plantForeignRegistry(eligibleAttempt());
    const session = open();
    const off = await evaluateRegistryAttempts(
      "command",
      deps({ registry: () => session, connected: () => false }),
    );
    expect(off.skipped).toMatch(/credentials/);
    session.store.close();
    const ro = await evaluateRegistryAttempts("command", deps({ registry: () => session }));
    expect(ro.skipped).toMatch(/read-only/);
  });

  it("lists attempts still running at shutdown in supervision", async () => {
    const a = eligibleAttempt();
    delete a.evaluation;
    plantForeignRegistry(a);
    const session = open();
    expect(recordActiveAtShutdown(session)).toBe(1);
    expect(session.store.snapshot().supervision.active_at_shutdown).toEqual([a.attempt_id]);
  });

  it("renders the verdict onto the run's block, and re-renders a block someone edited", async () => {
    const a = eligibleAttempt();
    plantForeignRegistry(a);
    const session = open();
    const nb = path.join(dir, "notebook.md");
    fs.writeFileSync(
      nb,
      "# N\n\n" +
        renderJobYaml({
          jobId: JOB,
          galaxyServerUrl: SERVER,
          notebookAnchor: "step-2",
          label: "cat",
          submittedAt: "2026-09-25T12:00:02.000Z",
          status: "completed",
        }) +
        "\n",
    );
    await evaluateRegistryAttempts("command", deps({ registry: () => session }));
    await renderRegistryProjection(session, nb);
    const [block] = findJobBlocks(fs.readFileSync(nb, "utf-8"));
    expect(block.handoffEligible).toBe(true);
    expect(block.evaluation).toMatchObject({
      execution: "success",
      check: "conformant_by_reconcile",
    });
    expect(block.registryRevision).toBe(session.store.snapshot().revision);

    // An edit to the rendering is representation only: put back on the next pass.
    fs.writeFileSync(
      nb,
      fs.readFileSync(nb, "utf-8").replace("handoff_eligible: true", "handoff_eligible: false"),
    );
    await renderRegistryProjection(session, nb);
    expect(findJobBlocks(fs.readFileSync(nb, "utf-8"))[0].handoffEligible).toBe(true);
    expect(rows("state.repaired")).toHaveLength(1);
  });
});
