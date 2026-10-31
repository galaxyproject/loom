// @vitest-environment node
/**
 * Step-0 stale-lease experiment (plan key decision 9, Step 0's "commit with a stale lease
 * generation: the worker should exit"). Each boot is a worker_thread running Orbit's brain on
 * pi-host over PostgresStorage fenced on generation G. Mid-turn, while a Galaxy tool's request is
 * held open, the test bumps the store's lease generation as another host taking the conversation
 * would, lets the request go, and watches the next commit.
 *
 * The control boot has no LeaseFence, to show what pi-durable and Orbit do on their own; the fatal
 * boots run behind it and exit with code 75. Where the request is held decides what the fence can
 * do: held in front of its generation check, a write is refused; held past the check (a slow
 * Galaxy), the write is delivered and the fence trips only at the next commit. After each fatal
 * boot a fresh worker on a fresh Pool, holding G+1, reopens the conversation and finishes the turn.
 *
 * "Nothing after lease-lost" checks hold by construction -- onLost exits the thread synchronously,
 * and the recording transport lives in that thread -- so they guard against a regression in that
 * wiring rather than measure network behavior. A real socket already written would not show here.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker } from "node:worker_threads";
import { build, type Plugin } from "esbuild";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../../../../shared/orbit-env.js";

import { LEASE_LOST_EXIT_CODE, LeaseFence, leaseLostIn } from "./lease-fence";
import {
  PROMPTS,
  type FromWorker,
  type HoldAt,
  type Inspection,
  type LeaseWorkerData,
  type ToWorker,
} from "./lease-fence-protocol";
import {
  bumpLeaseGen,
  currentLeaseGen,
  LeaseLostError,
  migratePostgresStorage,
} from "../storage/postgres-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const ORBIT_DIR = join(REPO, "extensions", "orbit");
const SHARED = join(REPO, "shared");
// The step-0 task reserves this database for this experiment.
const DATABASE = readEnv("STEP0_FENCE_DB") ?? "loom_step0_fence";
// Outside os.tmpdir() so the bundle's bare `pg` import resolves to this workspace's copy.
const OUT = join(HERE, "..", "..", ".scratch", "lease-fence");

// ── the worker bundle: recovery-bundle.ts's seams, for this entry ───────────────────────────────

const ORBIT_BRAIN = `
export { default as loom } from "${ORBIT_DIR}/index.ts";
export { setCapabilityProfile } from "${SHARED}/capability-profile.js";
export { setConfigSource } from "${SHARED}/config-source.js";
export { setInstructionSource } from "${ORBIT_DIR}/user-instructions.ts";
export { setVendorSkillsSource } from "${ORBIT_DIR}/vendor-skills.ts";
export { setGalaxyTransport } from "${ORBIT_DIR}/galaxy-api.ts";
export { setRecordStore } from "${ORBIT_DIR}/record-store.ts";
export { createPageRecordStore } from "${ORBIT_DIR}/record-store-page.ts";
export { setGalaxyToolSource } from "${ORBIT_DIR}/galaxy-tool-source.ts";
export { createGalaxyOpsToolSource } from "${ORBIT_DIR}/galaxy-ops-tools.ts";
`;
const INERT = `
const inert = () => new Proxy(function () {}, {
  get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : inert()),
  apply: () => inert(),
  construct: () => inert(),
});
const stub = inert();
export default stub;
export const watch = stub;
`;
const seams: Plugin = {
  name: "orbit-lease-fence",
  setup(b) {
    b.onResolve({ filter: /^orbit-brain$/ }, () => ({ path: "orbit-brain", namespace: "orbit" }));
    b.onLoad({ filter: /.*/, namespace: "orbit" }, () => ({
      contents: ORBIT_BRAIN,
      loader: "ts",
      resolveDir: ORBIT_DIR,
    }));
    b.onResolve({ filter: /^(chokidar|better-sqlite3)$/ }, (args) => ({
      path: args.path,
      namespace: "inert",
    }));
    b.onLoad({ filter: /.*/, namespace: "inert" }, () => ({ contents: INERT, loader: "js" }));
    b.onResolve({ filter: /^@galaxyproject\/galaxy-ops$/ }, (args) =>
      args.importer.startsWith(ORBIT_DIR) || args.importer.startsWith(SHARED)
        ? { path: join(REPO, "node_modules/@galaxyproject/galaxy-ops/dist/index.browser.js") }
        : undefined,
    );
  },
};

async function bundleWorker(): Promise<string> {
  const outfile = join(OUT, "lease-fence-worker.mjs");
  await build({
    entryPoints: [join(HERE, "lease-fence-worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    plugins: [seams],
    external: ["pg"],
    define: { "import.meta.main": "false" },
    banner: {
      js: [
        'import { createRequire as __lfRequire } from "node:module";',
        "const require = __lfRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  return outfile;
}

// ── one worker ───────────────────────────────────────────────────────────────────────────────────

const ORIGINAL_CWD = process.cwd();
const tmp = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "orbit-lease-fence-")));
let bundle: string;
let pool: pg.Pool;

beforeAll(async () => {
  bundle = await bundleWorker();
  pool = new pg.Pool({ host: "/tmp", port: 5432, database: DATABASE, max: 4 });
  await migratePostgresStorage(pool);
  process.chdir(tmp);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Boot {
  readonly log: FromWorker[] = [];
  readonly worker: Worker;
  exitCode: number | undefined;
  error: unknown;
  #rpc = 0;
  #waiters = new Set<() => void>();

  constructor(data: LeaseWorkerData) {
    this.worker = new Worker(bundle, {
      workerData: data,
      env: { HOME: data.dir, USERPROFILE: data.dir, PI_CODING_AGENT_DIR: join(data.dir, ".pi") },
    });
    const wake = () => {
      for (const w of this.#waiters) w();
    };
    this.worker.on("message", (m: FromWorker) => {
      this.log.push(m);
      wake();
    });
    this.worker.on("error", (e) => {
      this.error = e;
      wake();
    });
    this.worker.on("exit", (code) => {
      this.exitCode = code;
      wake();
    });
  }

  send(message: ToWorker) {
    this.worker.postMessage(message);
  }

  async until(done: () => boolean, what: string, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (this.error) throw this.error;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}: ${this.summary()}`);
      await new Promise<void>((r) => {
        const finish = () => {
          clearTimeout(timer);
          this.#waiters.delete(finish);
          r();
        };
        const timer = setTimeout(finish, left);
        this.#waiters.add(finish);
      });
    }
  }

  async next<T extends FromWorker["type"]>(
    type: T,
    { from = 0, ms = 30_000 } = {},
  ): Promise<Extract<FromWorker, { type: T }>> {
    let found: Extract<FromWorker, { type: T }> | undefined;
    await this.until(
      () => {
        found = this.of(type, from)[0];
        if (!found && this.exitCode !== undefined) throw new Error(`worker exited before ${type}`);
        return found !== undefined;
      },
      type,
      ms,
    );
    return found!;
  }

  exited(ms = 30_000) {
    return this.until(() => this.exitCode !== undefined, "exit", ms);
  }

  async call<T>(cmd: "idle" | "inspect"): Promise<T> {
    const rpc = ++this.#rpc;
    const from = this.log.length;
    this.send({ cmd, rpc });
    await this.until(
      () => this.log.slice(from).some((m) => m.type === "rpc" && m.rpc === rpc),
      cmd,
    );
    return (this.log.find((m) => m.type === "rpc" && m.rpc === rpc) as { value: T }).value;
  }

  of<T extends FromWorker["type"]>(type: T, from = 0): Array<Extract<FromWorker, { type: T }>> {
    return this.log
      .slice(from)
      .filter((m): m is Extract<FromWorker, { type: T }> => m.type === type);
  }

  indexOf(type: FromWorker["type"]) {
    return this.log.findIndex((m) => m.type === type);
  }

  summary() {
    return JSON.stringify(this.log.filter((m) => m.type !== "model").slice(-20));
  }
}

let n = 0;
/** A fresh store whose lease the test takes first, as the host does before dispatching a worker. */
async function conversationStore() {
  const storeId = `fence-${++n}-${randomUUID()}`;
  const dir = join(tmp, `x${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const leaseGen = await bumpLeaseGen(pool, storeId);
  return { storeId, dir, leaseGen };
}

/**
 * Boot a worker holding G, let its startup settle, hold the Galaxy request the prompt's tool makes
 * at `at`, and bump the generation while it is parked. Returns before the request is let go.
 */
async function bootAndTakeOver(
  fatal: boolean,
  prompt: keyof typeof PROMPTS,
  { at = "outside" as HoldAt, defaultOnLost = false } = {},
) {
  const store = await conversationStore();
  const boot = new Boot({
    repo: REPO,
    dir: store.dir,
    database: DATABASE,
    user: os.userInfo().username,
    storeId: store.storeId,
    leaseGen: store.leaseGen,
    fatal,
    defaultOnLost,
  });
  const { conversationId } = await boot.next("ready");
  // Orbit's startup greeting is a turn of its own; a prompt sent while it runs is turned away busy.
  await boot.next("model");
  await boot.call("idle");
  const request =
    prompt === "read"
      ? { method: "GET", path: "/api/histories/h1" }
      : { method: "PUT", path: "/api/histories/h1" };
  boot.send({ cmd: "hold", ...request, at });
  boot.send({ cmd: "submit", text: PROMPTS[prompt].text });
  const admitted = await boot.next("submit-settled");
  expect(admitted).toMatchObject({ ok: true, admitted: true });
  await boot.next("held");
  // Another host takes the conversation: the same upsert the host's dispatcher runs.
  const newGen = await bumpLeaseGen(pool, store.storeId);
  return { ...store, boot, conversationId, request, newGen };
}

/** The new holder: a fresh Pool and worker on G+1 reopen the conversation and finish the turn. */
async function takeOver(store: {
  storeId: string;
  dir: string;
  conversationId: string;
  newGen: number;
}) {
  const tasksAtTakeover = await taskRows(store.storeId);
  expect(await currentLeaseGen(pool, store.storeId)).toBe(store.newGen);
  const fresh = new Boot({
    repo: REPO,
    dir: store.dir,
    database: DATABASE,
    user: os.userInfo().username,
    storeId: store.storeId,
    leaseGen: store.newGen,
    fatal: true,
    conversationId: store.conversationId,
    deferResume: true,
  });
  const ready = await fresh.next("ready");
  const tasksAfterOpen = await taskRows(store.storeId);
  const resumed = fresh.log.length;
  fresh.send({ cmd: "resume" });
  await sleep(200);
  await fresh.call("idle");
  const finished = await fresh.call<Inspection>("inspect");
  const tasksAfterResume = await taskRows(store.storeId);
  const result = {
    fresh,
    ready,
    resumed,
    finished,
    view: {
      tasksAtTakeover,
      tasksAfterOpen,
      beforeResume: ready.beforeResume,
      galaxyAfterResume: fresh.of("galaxy", resumed),
      modelAfterResume: fresh.of("model", resumed).map((m) => m.lastRole),
      reportsAfterResume: fresh.of("report", resumed).map((r) => r.error),
      finished,
      tasksAfterResume,
    },
  };
  return result;
}

async function closeHolder(fresh: Boot) {
  fresh.send({ cmd: "close" });
  await fresh.next("closed");
  await fresh.worker.terminate();
}

/** The resumed turn's verdict on the stale worker's tool call, and what the new holder did about it. */
function expectInterruptedNotRerun(
  holder: Awaited<ReturnType<typeof takeOver>>,
  callId: string,
  galaxyPath: string,
) {
  const { fresh, ready, resumed, finished, view } = holder;
  // At takeover the store still says what the dead worker last committed: the tool running.
  expect(view.tasksAtTakeover).toContainEqual({ kind: "pi.tool", status: "running" });
  expect(fresh.exitCode).toBeUndefined();
  expect(fresh.of("galaxy", resumed).filter((g) => g.path.startsWith(galaxyPath))).toEqual([]);
  expect(fresh.of("model", resumed).map((m) => m.lastRole)).toEqual(["tool"]);
  expect(view.tasksAfterResume.filter((t) => t.status !== "terminal")).toEqual([]);
  expect(fresh.of("commit-rejected")).toEqual([]);
  expect(finished.ok).toBe(true);
  if (finished.ok) {
    const result = finished.toolResults.find((r) => r.toolCallId === callId);
    // Not re-run: a tool task checkpointed in `execute` settles as interrupted on reopen, the
    // model hears that, and the turn finishes.
    expect(result).toMatchObject({ isError: true });
    expect(result?.text).toMatch(/interrupted and may have partially run/);
  }
  expect(ready.beforeResume).toMatchObject({ ok: true });
  if (ready.beforeResume?.ok) {
    expect(ready.beforeResume.tasks).toContainEqual(
      expect.objectContaining({ kind: "pi.tool", status: "running", phase: "execute" }),
    );
  }
}

// kind is stored JSON-encoded, as PostgresStorage keeps every indexed string lossless.
const taskRows = async (storeId: string) =>
  (
    await pool.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM durable_tasks WHERE store_id = $1 ORDER BY id",
      [storeId],
    )
  ).rows.map((r) => ({ kind: JSON.parse(r.kind) as string, status: r.status }));

/** Everything the parent learned, written for the spike report. */
const evidence: Record<string, unknown> = {};
afterAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
});

describe("a commit on a stale lease generation", () => {
  it("without the fence: the Session poisons itself, the turn stalls, and the worker keeps running", async () => {
    const { boot, storeId, leaseGen, newGen, request } = await bootAndTakeOver(false, "rename");
    expect(newGen).toBe(leaseGen + 1);
    const released = boot.log.length;
    boot.send({ cmd: "release" });
    const rejected = await boot.next("commit-rejected", { from: released });
    // Give anything still running time to show itself.
    await sleep(2_000);
    const after = boot.log.indexOf(rejected);

    // The rejection itself: the typed error from PostgresStorage.fence(), raised to pi-durable's
    // Session.#runCommit, which is not a StorageRejected and so poisons the Session.
    expect(rejected.error.name).toBe("LeaseLostError");
    expect(rejected.error.message).toContain(
      `holding generation ${leaseGen}, current is ${newGen}`,
    );
    expect(rejected.caller.join("\n")).toMatch(/runCommit/);

    // The write already landed: the tool ran to completion before anything committed.
    const writes = boot
      .of("galaxy")
      .filter((g) => g.method === request.method && g.path === request.path);
    expect(writes).toHaveLength(1);
    expect(boot.log.indexOf(writes[0]!)).toBeLessThan(after);

    // Where the error went: to onReport (the scheduler's catch), never to the submit caller.
    const reports = boot.of("report", after);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.some((r) => r.error.chain.some((c) => c.startsWith("LeaseLostError")))).toBe(
      true,
    );

    // Later commits fail on the poisoned Session without reaching storage again.
    const inspection = await boot.call<Inspection>("inspect");
    const followUp = boot.log.length;
    boot.send({ cmd: "submit", text: PROMPTS.read.text });
    const settled = await boot.next("submit-settled", { from: followUp });
    // Orbit's own timers are not tasks and never touch the Session: galaxy-poller.ts ticks every
    // 15 s and reads the notebook, a Galaxy page, so the stale worker keeps talking to Galaxy.
    const timerRead = await boot.next("galaxy", { from: after, ms: 20_000 });

    evidence.control = {
      leaseGen,
      newGen,
      rejected,
      reportsAfterRejection: reports.map((r) => r.error),
      unhandledAfterRejection: boot.of("unhandled", after).map((u) => u.error),
      commitsAfterRejection: boot.of("commit", after).length,
      rejectionsAfterRejection: boot.of("commit-rejected", after + 1).map((r) => r.error),
      galaxyAfterRejection: boot.of("galaxy", after),
      modelAfterRejection: boot.of("model", after),
      inspection,
      followUpSubmit: settled,
      galaxyAfterFollowUp: boot.of("galaxy", followUp),
      modelAfterFollowUp: boot.of("model", followUp),
      submitSettlements: boot.of("submit-settled"),
      exitCode: boot.exitCode,
      tasksInDb: await taskRows(storeId),
      galaxyFromTimerAfterRejection: timerRead,
      msFromStaleWriteToTimerRead: timerRead.at - writes[0]!.at,
    };

    expect(boot.exitCode).toBeUndefined();
    expect(timerRead).toMatchObject({ method: "GET", path: "/api/pages/p1" });
    expect(boot.of("commit", after)).toHaveLength(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) expect(inspection.error.message).toMatch(/poisoned/);
    expect(settled.ok).toBe(false);
    expect(settled.error?.message).toMatch(/poisoned/);
    // The poisoned Session commits nothing, so no new turn reaches the model.
    expect(boot.of("model", followUp)).toHaveLength(0);
    await boot.worker.terminate();
  });

  it("with the fence: the worker exits on the rejected commit and Galaxy hears nothing more", async () => {
    const { boot, storeId, leaseGen, newGen, conversationId, dir } = await bootAndTakeOver(
      true,
      "read",
    );
    const released = boot.log.length;
    boot.send({ cmd: "release" });
    await boot.exited();
    // By construction nothing follows lease-lost (onLost exits synchronously); the wait only
    // catches a regression in that wiring.
    await sleep(1_000);

    expect(boot.exitCode).toBe(LEASE_LOST_EXIT_CODE);
    const lostAt = boot.indexOf("lease-lost");
    expect(lostAt).toBeGreaterThan(released);
    expect(boot.log[lostAt]).toMatchObject({ storeId, expectedGen: leaseGen, currentGen: newGen });
    expect(boot.of("commit-rejected", released)[0]?.error.name).toBe("LeaseLostError");
    // The held read and the tool's other reads went out before the commit that failed; nothing
    // went out after it.
    expect(boot.of("galaxy", released).map((g) => `${g.method} ${g.path}`)).toContain(
      "GET /api/histories/h1",
    );
    expect(boot.of("galaxy", lostAt)).toEqual([]);
    expect(boot.of("model", lostAt)).toEqual([]);
    expect(boot.log.slice(lostAt + 1)).toEqual([]);

    const holder = await takeOver({ storeId, dir, conversationId, newGen });
    evidence.fatal = {
      leaseGen,
      newGen,
      log: boot.log.filter((m) => m.type !== "model" && m.type !== "event").slice(-12),
      exitCode: boot.exitCode,
      ...holder.view,
    };
    expectInterruptedNotRerun(holder, PROMPTS.read.callId, "/api/histories/h1");
    await closeHolder(holder.fresh);
  });

  it("with the fence: a Galaxy write whose generation check runs after the bump is refused, and the worker exits", async () => {
    const { boot, storeId, leaseGen, newGen, request, conversationId, dir } = await bootAndTakeOver(
      true,
      "rename",
      { at: "outside" },
    );
    const released = boot.log.length;
    boot.send({ cmd: "release" });
    await boot.exited();
    await sleep(1_000);

    expect(boot.exitCode).toBe(LEASE_LOST_EXIT_CODE);
    expect(boot.of("lease-lost", released)[0]).toMatchObject({
      expectedGen: leaseGen,
      currentGen: newGen,
    });
    // No commit was attempted: the fence tripped on the generation check inside fetch.
    expect(boot.of("commit-rejected", released)).toEqual([]);
    expect(
      boot.of("galaxy").filter((g) => g.method === request.method && g.path === request.path),
    ).toEqual([]);
    expect(boot.of("galaxy", released)).toEqual([]);

    const holder = await takeOver({ storeId, dir, conversationId, newGen });
    evidence.fatalWrite = {
      leaseGen,
      newGen,
      log: boot.log.slice(released),
      exitCode: boot.exitCode,
      ...holder.view,
    };
    // The PUT provably never reached Galaxy, yet recovery cannot tell: the tool is still `running`
    // in `execute`, so the model is told it may have partially run.
    expectInterruptedNotRerun(holder, PROMPTS.rename.callId, "/api/histories/h1");
    await closeHolder(holder.fresh);
  });

  it("with the fence: a Galaxy write already past the check when the lease moves is delivered; the fence trips at the next commit", async () => {
    // defaultOnLost: this boot exits through LeaseFence's own default, not the worker's onLost.
    const { boot, storeId, leaseGen, newGen, request, conversationId, dir } = await bootAndTakeOver(
      true,
      "rename",
      { at: "inside", defaultOnLost: true },
    );
    const released = boot.log.length;
    boot.send({ cmd: "release" });
    await boot.exited();
    await sleep(1_000);

    expect(boot.exitCode).toBe(LEASE_LOST_EXIT_CODE);
    // The stale write landed: the check passed on G before the bump, and nothing re-checks once
    // the request is with Galaxy.
    const writes = boot
      .of("galaxy", released)
      .filter((g) => g.method === request.method && g.path === request.path);
    expect(writes).toHaveLength(1);
    expect(boot.of("galaxy-refused", released)).toEqual([]);
    // The storage fence then catches it: the next commit is refused and the thread exits.
    const rejected = boot.of("commit-rejected", released);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.error.name).toBe("LeaseLostError");
    expect(boot.log.indexOf(writes[0]!)).toBeLessThan(boot.log.indexOf(rejected[0]!));
    // No worker onLost here, so no lease-lost message: exit code 75 came from the default.
    expect(boot.of("lease-lost")).toEqual([]);
    expect(boot.log.at(-1)).toBe(rejected[0]);

    const holder = await takeOver({ storeId, dir, conversationId, newGen });
    evidence.fatalWriteInFlight = {
      leaseGen,
      newGen,
      log: boot.log.slice(released),
      exitCode: boot.exitCode,
      ...holder.view,
    };
    // Here "may have partially run" is true: the PUT reached Galaxy, and the new holder does not resend it.
    expectInterruptedNotRerun(holder, PROMPTS.rename.callId, "/api/histories/h1");
    await closeHolder(holder.fresh);
  });
});

// ── LeaseFence on its own: the paths the worker boots do not reach ──────────────────────────────

describe("LeaseFence", () => {
  const STORE = "unit-store";
  const lost = () => new LeaseLostError(STORE, 1, 2);
  /** A db whose lease_gen the test moves, standing in for durable_stores. */
  const fakeDb = (gen: { value: number }) => ({
    query: async () => ({ rows: [{ lease_gen: String(gen.value) }] }),
  });
  const fence = (gen = { value: 1 }) => {
    const seen: LeaseLostError[] = [];
    const f = new LeaseFence({
      storeId: STORE,
      leaseGen: 1,
      db: fakeDb(gen) as never,
      onLost: (e) => seen.push(e),
    });
    return { f, seen, gen };
  };

  it("finds the LeaseLostError through the Session's poisoned wrapper, and trips once", () => {
    const { f, seen } = fence();
    const inner = lost();
    const poisoned = new Error(
      "Session is poisoned by a failed commit after storage admission; reopen it",
      {
        cause: inner,
      },
    );
    f.check(poisoned);
    f.check(new Error("again", { cause: lost() }));
    f.check(lost());
    expect(seen).toEqual([inner]);
    expect(f.lost).toBe(inner);
  });

  it("matches a LeaseLostError from another copy of the class by name", () => {
    const foreign = Object.assign(new Error("from another bundle"), { name: "LeaseLostError" });
    expect(leaseLostIn(new Error("wrap", { cause: foreign }))).toBe(foreign);
    const { f, seen } = fence();
    f.check(new Error("wrap", { cause: foreign }));
    expect(seen).toEqual([foreign]);
  });

  it("leaves other errors alone", () => {
    const { f, seen } = fence();
    f.check(new Error("connection reset", { cause: new Error("ECONNRESET") }));
    f.check(undefined);
    expect(seen).toEqual([]);
    expect(f.lost).toBeUndefined();
  });

  it("refuses a write whose check sees a newer generation, and sends nothing once tripped", async () => {
    const { f, seen, gen } = fence();
    const sent: string[] = [];
    const fetch = f.fetch(async (url, init) => {
      sent.push(`${init.method ?? "GET"} ${url}`);
      return new Response("{}");
    });
    await fetch("http://g/a", { method: "PUT" });
    gen.value = 2;
    // A read does not consult the generation.
    await fetch("http://g/b", {});
    await expect(fetch("http://g/c", { method: "POST" })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(fetch("http://g/d", {})).rejects.toBeInstanceOf(LeaseLostError);
    expect(sent).toEqual(["PUT http://g/a", "GET http://g/b"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ expectedGen: 1, currentGen: 2 });
  });

  it("lets a write through when the bump lands between the check and the send", async () => {
    const { f, seen, gen } = fence();
    const sent: string[] = [];
    // The bump happens as the request leaves: after currentLeaseGen() returned, before Galaxy acts.
    const fetch = f.fetch(async (url, init) => {
      gen.value = 2;
      sent.push(`${init.method} ${url}`);
      return new Response("{}");
    });
    await fetch("http://g/a", { method: "PUT" });
    expect(sent).toEqual(["PUT http://g/a"]);
    expect(seen).toEqual([]);
  });

  it.runIf(isMainThread)("will not default to exiting when built on the main thread", () => {
    expect(
      () => new LeaseFence({ storeId: STORE, leaseGen: 1, db: fakeDb({ value: 1 }) as never }),
    ).toThrow(/main thread/);
  });
});
