import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { acquireLease, releaseLease } from "../lease/leases";
import { bumpLeaseGen } from "../storage/postgres-storage";
import { ensureDatabase, testDatabase } from "../test-db";
import { startStandIn, type StandIn } from "../test-stand-in";
import { bundleWorker, nodeEdges } from "./bundle";
import { WITHHELD_TOOLS } from "./guards";
import { SESSION_POISONED_EXIT_CODE, type WorkerData } from "./protocol";
import { runWorker, TEST_TOKEN, type Running, type Tokens } from "./test-workers";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, "..", "..", ".scratch", "worker");
const DATABASE = testDatabase("orbit_hosted_worker");
const LEASE_LOST = 75;

let pool: pg.Pool;
let bundle: string;
let standIn: StandIn;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await ensureDatabase(DATABASE)), max: 4 });
  await migrate(pool);
  bundle = await bundleWorker(join(HERE, "boot.ts"), join(SCRATCH, "boot.mjs"));
  standIn = await startStandIn();
});

afterAll(async () => {
  await pool?.end();
  await standIn?.close();
});

// Who holds each store's lease, so a reopen can hand it on the way a restart would.
const holders = new Map<string, string>();

async function workerData(overrides: Partial<WorkerData> = {}): Promise<WorkerData> {
  const storeId = overrides.storeId ?? `worker-${randomUUID()}`;
  const previous = holders.get(storeId);
  if (previous !== undefined) await releaseLease(pool, storeId, previous);
  const holder = `test-${randomUUID()}`;
  holders.set(storeId, holder);
  const leaseGen = (await acquireLease(pool, storeId, holder, 60_000))!;
  return {
    storeId,
    leaseGen,
    // The worker's environment is empty, so the user has to be in the URL.
    database: `postgres://${userInfo().username}@/${DATABASE}?host=${encodeURIComponent(process.env.PGHOST ?? "/tmp")}`,
    galaxyUrl: standIn.origin,
    pageId: "p1",
    model: { baseUrl: `${standIn.origin}/v1`, id: "m", apiKey: "model-key-0123456789", user: "user-sub-1" },
    limits: { maxTurns: 6, maxToolCalls: 20, outputBytes: 4 * 1024 * 1024 },
    ...overrides,
  };
}

const run = (data: WorkerData, tokens?: Tokens) => runWorker(bundle, data, tokens);

/** Close the worker's harness; with its pool and port closed, the thread exits on its own. */
async function stopped(running: Running): Promise<void> {
  running.worker.postMessage({ cmd: "close" });
  expect(await running.waitFor("closed")).toEqual({ type: "closed" });
  expect(await running.exited).toBe(0);
}

/** A worker on a new conversation, ready for a message. */
async function started(overrides: Partial<WorkerData> = {}, tokens?: Tokens) {
  const data = await workerData(overrides);
  const running = run(data, tokens);
  const ready = await running.waitFor("ready");
  return { data, running, ready };
}

/** Past one plain turn, by when the worker's startup reads of Galaxy are done too. */
async function settledIn(running: Running): Promise<void> {
  running.worker.postMessage({ cmd: "submit", text: "hello" });
  await running.waitFor("settled");
}

describe("the worker bootstrap", () => {
  it("offers exactly the pinned server surface, without the user-defined tools", async () => {
    const running = run(await workerData());
    const ready = await running.waitFor("ready");
    const tools = [...ready.tools].sort();
    for (const withheld of WITHHELD_TOOLS) expect(tools).not.toContain(withheld);
    expect(tools).toContain("get_history_details");
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot("../../__surface__/server/tools.json");
    await stopped(running);
  });

  it("boots and runs a Galaxy turn with no filesystem reach and nothing in its environment but the shim", async () => {
    const { running, ready } = await started({ traceReaches: true });
    expect([...ready.env].sort()).toEqual(["ORBIT_ACTIVE_LLM_API_KEY", "ORBIT_FRESH_SESSION"]);
    expect(ready.resuming).toBe(false);
    const before = standIn.galaxyCalls("GET", "/api/histories/h1");
    const from = standIn.seen.length;
    running.worker.postMessage({ cmd: "submit", text: "READ_H1 please" });
    expect(await running.waitFor("submitted")).toEqual({ type: "submitted", admitted: true });
    await running.waitFor("settled");
    expect(standIn.galaxyCalls("GET", "/api/histories/h1")).toBe(before + 1);
    // The service key is shared; each request names its user for the endpoint's usage log.
    const sent = standIn.seen.slice(from).filter((s) => s.to === "model");
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) expect(JSON.parse(request.body!).user).toBe("user-sub-1");
    expect(running.messages.filter((m) => m.type === "reach")).toEqual([]);
    expect(running.messages.filter((m) => m.type === "report")).toEqual([]);
    await stopped(running);
  });

  it("never greets, on a new conversation or a reopened one", async () => {
    const before = standIn.modelCalls();
    const { data, running: first, ready: opened } = await started();
    first.worker.postMessage({ cmd: "submit", text: "first words" });
    await first.waitFor("settled");
    await stopped(first);

    const second = run(await workerData({ storeId: data.storeId, conversationId: opened.conversationId }));
    const ready = await second.waitFor("ready");
    expect(ready.conversationId).toBe(opened.conversationId);
    second.worker.postMessage({ cmd: "submit", text: "back again" });
    await second.waitFor("settled");
    // Two runs, each answering the user's message; neither opened with a greeting.
    const calls = standIn.seen.filter((s) => s.to === "model").slice(before);
    expect(calls.map((c) => c.userText)).toEqual(["first words", "back again"]);
    await stopped(second);
  });

  it("stops calling tools at the cap for one user message, and the model is told why", async () => {
    const { running } = await started({ limits: { maxTurns: 6, maxToolCalls: 2, outputBytes: 1 << 20 } });
    const before = standIn.galaxyCalls("GET", "/api/histories/h1");
    running.worker.postMessage({ cmd: "submit", text: "KEEP_GOING" });
    await running.waitFor("settled");
    expect(standIn.galaxyCalls("GET", "/api/histories/h1")).toBe(before + 2);
    expect(standIn.seen.some((s) => s.to === "model" && s.lastText?.includes("has used its 2 tool calls"))).toBe(true);
    await stopped(running);
  });

  it("exits with 75 on a lost lease, before the model is asked anything", async () => {
    const { data, running } = await started();
    const before = standIn.modelCalls();
    await bumpLeaseGen(pool, data.storeId);
    running.worker.postMessage({ cmd: "submit", text: "hello again" });
    expect(await running.exited).toBe(LEASE_LOST);
    expect(standIn.modelCalls()).toBe(before);
  });

  it("exits for a reopen when a dropped database connection fails a commit and poisons its session", async () => {
    const { data, running } = await started();
    await settledIn(running);
    // Hold the store's row so the next commit waits on it, then drop that waiting connection.
    const blocker = new pg.Client({ ...(await ensureDatabase(DATABASE)) });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM durable_stores WHERE store_id = $1 FOR UPDATE", [data.storeId]);
      running.worker.postMessage({ cmd: "submit", text: "hello again" });
      const waiting = async () => {
        const { rows } = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> $2",
          [DATABASE, (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid],
        );
        return rows;
      };
      let rows = await waiting();
      for (let i = 0; rows.length === 0 && i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        rows = await waiting();
      }
      expect(rows.length).toBeGreaterThan(0);
      await pool.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [rows.map((r) => r.pid)]);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await Promise.race([running.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000))])).toBe(
      SESSION_POISONED_EXIT_CODE,
    );
  });
});

describe("a pending confirm", () => {
  it("Stop withdraws it, the run settles, and the delete never reaches Galaxy", async () => {
    const { running } = await started();
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    running.worker.postMessage({ cmd: "submit", text: "DELETE_H1" });
    const ask = await running.waitFor("ask");
    running.worker.postMessage({ cmd: "stop" });
    expect(await running.waitFor("ask-withdrawn")).toEqual({ type: "ask-withdrawn", id: ask.id });
    expect((await running.waitFor("settled")).aborted).toBe(true);
    // A late answer to the withdrawn ask changes nothing.
    running.worker.postMessage({ cmd: "answer", id: ask.id, value: true });
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);
    await stopped(running);
  });

  it("closing withdraws it without waiting for the host, and the reopened worker asks again", async () => {
    const { data, running, ready: opened } = await started();
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    running.worker.postMessage({ cmd: "submit", text: "DELETE_H1" });
    const first = await running.waitFor("ask");
    running.worker.postMessage({ cmd: "close" });
    expect(await running.waitFor("ask-withdrawn")).toEqual({ type: "ask-withdrawn", id: first.id });
    await running.waitFor("closed");
    expect(await running.exited).toBe(0);
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);

    const reopened = run(await workerData({ storeId: data.storeId, conversationId: opened.conversationId }));
    expect((await reopened.waitFor("ready")).resuming).toBe(true);
    const again = await reopened.waitFor("ask");
    expect(again.request).toEqual(first.request);
    reopened.worker.postMessage({ cmd: "answer", id: again.id, value: true });
    await reopened.waitFor("settled");
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts + 1);
    await stopped(reopened);
  });
});

describe("Galaxy as the signed-in user", () => {
  it("sends the host's access token and no API key", async () => {
    const { running } = await started();
    const from = standIn.seen.length;
    running.worker.postMessage({ cmd: "submit", text: "READ_H1 please" });
    await running.waitFor("settled");
    const galaxy = standIn.seen.slice(from).filter((s) => s.to === "galaxy");
    expect(galaxy.length).toBeGreaterThan(0);
    for (const request of galaxy) {
      expect(request.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(request.apiKey).toBeUndefined();
    }
    await stopped(running);
  });

  it("a sign-in outage reaches the model as service_outage, and Galaxy is never asked", async () => {
    let down = false;
    const { running } = await started({}, () =>
      down ? { failure: { kind: "outage", message: "The sign-in service couldn't be reached." } } : { token: TEST_TOKEN },
    );
    await settledIn(running);
    down = true;
    const from = standIn.seen.length;
    running.worker.postMessage({ cmd: "submit", text: "READ_H1 please" });
    await running.waitFor("settled", 2);
    const after = standIn.seen.slice(from);
    expect(after.filter((s) => s.to === "galaxy")).toEqual([]);
    const toolResult = after.find((s) => s.to === "model" && s.lastRole === "tool");
    expect(toolResult?.lastText).toContain("service_outage");
    expect(toolResult?.lastText).toContain("is down");
    await stopped(running);
  });

  it("a token refused for a moved lease stops the worker like a lost lease", async () => {
    let moved = false;
    const { running } = await started({}, () =>
      moved ? { failure: { kind: "lease", message: "This conversation moved to another worker." } } : { token: TEST_TOKEN },
    );
    await settledIn(running);
    moved = true;
    running.worker.postMessage({ cmd: "submit", text: "READ_H1 please" });
    expect(await running.exited).toBe(LEASE_LOST);
  });
});

describe("the server surface", () => {
  it("pins which of Orbit's sources import Node-only modules", async () => {
    const edges = await nodeEdges(join(HERE, "boot.ts"));
    expect(edges.length).toBeGreaterThan(0);
    await expect(`${JSON.stringify(edges, null, 2)}\n`).toMatchFileSnapshot("../../__surface__/server/edges.json");
  });
});

describe("the tripwire", () => {
  it("sees named, namespace and require'd calls inside a bundled worker", async () => {
    const probe = await bundleWorker(join(HERE, "tripwire-probe.ts"), join(SCRATCH, "tripwire-probe.mjs"));
    const worker = new Worker(probe, { env: {} });
    const seen = await new Promise<string[]>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(seen).toEqual(["fs.existsSync", "fs.statSync", "fs.readdirSync", "os.homedir"]);
  });
});
