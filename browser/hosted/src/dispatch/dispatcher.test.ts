import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { storedSnapshot } from "../server/snapshot";
import { currentLeaseGen } from "../storage/postgres-storage";
import { freshDatabase, testDatabase } from "../test-db";
import { startStandIn, type StandIn } from "../test-stand-in";
import { createTokenCache } from "../tokens/token-cache";
import { bundleWorker } from "../worker/bundle";
import type { FromWorker } from "../worker/protocol";
import { spawnWorker } from "../worker/spawn";
import { createConversation, getConversation, titleIfUntitled } from "./conversations";
import { Dispatcher, type DispatcherOptions, type DispatchEvent } from "./dispatcher";
import { galaxyPageCreator, galaxyPageRetitler } from "./pages";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATABASE = testDatabase("orbit_hosted_dispatch");
const SOCKET = process.env.PGHOST ?? "/tmp";

let pool: pg.Pool;
let bundle: string;
let standIn: StandIn;
const bosses: PgBoss[] = [];
const dispatchers: Dispatcher[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ ...(await freshDatabase(DATABASE)), max: 8 });
  await migrate(pool);
  bundle = await bundleWorker(
    join(HERE, "..", "worker", "boot.ts"),
    join(HERE, "..", "..", ".scratch", "dispatch", "boot.mjs"),
  );
  standIn = await startStandIn();
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.shutdown()));
  // Turns a test sent back for later would otherwise run in the next test's hosts.
  await bosses[0]?.deleteAllJobs("turn").catch(() => undefined);
  await Promise.all(bosses.splice(0).map((b) => b.stop({ graceful: false })));
});

afterAll(async () => {
  await pool?.end();
  await standIn?.close();
});

type Event = FromWorker | DispatchEvent;

interface Host {
  readonly dispatcher: Dispatcher;
  readonly events: Map<string, Event[]>;
  /** Workers this host started, by store. */
  readonly spawned: Array<{ storeId: string; worker: Worker }>;
}

async function host(
  name = "host",
  concurrency?: number,
  turnsDisabled?: () => string | undefined,
  supervise = false,
  extra: Partial<DispatcherOptions> = {},
  hostPool: pg.Pool = pool,
): Promise<Host> {
  const boss = new PgBoss({
    host: SOCKET,
    database: DATABASE,
    user: userInfo().username,
    schedule: false,
    supervise,
    ...(supervise && { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 }),
  });
  boss.on("error", () => undefined);
  await boss.start();
  bosses.push(boss);
  const events = new Map<string, Event[]>();
  const spawned: Host["spawned"] = [];
  const dispatcher = new Dispatcher({
    pool: hostPool,
    boss,
    bundle,
    hostId: `${name}-${randomUUID()}`,
    databaseUrl: `postgres://${userInfo().username}@/${DATABASE}?host=${encodeURIComponent(SOCKET)}`,
    galaxyUrl: standIn.origin,
    lease: { ttlMs: 60_000, renewMs: 15_000, maxTurnMs: 60_000 },
    limits: { maxTurns: 6, maxToolCalls: 20, outputBytes: 1 << 22 },
    tokens: createTokenCache({
      refresh: async () => ({ token: "access", expiresAt: Date.now() + 600_000 }),
    }),
    modelFor: (sub) => ({
      baseUrl: `${standIn.origin}/v1`,
      id: "m",
      apiKey: "model-key-0123456789",
      user: sub,
    }),
    pageFor: async () => "p1",
    onEvent: (id, event) => {
      if (process.env.DISPATCH_LOG) console.log(`[${name}] ${id.slice(0, 8)} ${event.type}`);
      events.set(id, [...(events.get(id) ?? []), event]);
    },
    retryDelayMs: () => 300,
    jobHeartbeatSeconds: 10,
    concurrency,
    turnsDisabled,
    log: process.env.DISPATCH_LOG ? (m) => console.log(`[${name}] ${m}`) : undefined,
    spawn: (b, data) => {
      const worker = spawnWorker(b, data);
      spawned.push({ storeId: data.storeId, worker });
      return worker;
    },
    ...extra,
  });
  await dispatcher.start();
  dispatchers.push(dispatcher);
  return { dispatcher, events, spawned };
}

async function user(): Promise<string> {
  const sub = `user-${randomUUID()}`;
  await pool.query("INSERT INTO orbit_users (sub) VALUES ($1)", [sub]);
  return sub;
}

async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const of = (h: Host, id: string, type: Event["type"]) =>
  (h.events.get(id) ?? []).filter((e) => e.type === type);
const asked = (h: Host, id: string, n = 1) =>
  until(() => of(h, id, "ask")[n - 1] as Extract<Event, { type: "ask" }> | undefined, `ask #${n}`);
const settledCount = (h: Host, id: string) => of(h, id, "settled").length;
const modelSaw = (text: string) =>
  standIn.seen.filter((s) => s.to === "model" && s.userText === text).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The stored transcript as kind and text, one line per entry, system entries left out. */
async function transcript(id: string): Promise<string[]> {
  const entries = (await storedSnapshot(pool, (await getConversation(pool, id))!))
    .entries as unknown as Array<{
    kind: string;
    model?: Array<{ content: string | Array<{ type: string; text?: string; name?: string }> }>;
  }>;
  return entries
    .filter((e) => e.kind !== "pi.system")
    .map((e) => {
      const text = (e.model ?? [])
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content
                .map((c) => (c.type === "toolCall" ? `call ${c.name}` : (c.text ?? "")))
                .join(""),
        )
        .join("");
      return `${e.kind} ${text}`.trim();
    });
}
const leaseHeld = async (storeId: string) =>
  ((await pool.query("SELECT 1 FROM orbit_leases WHERE store_id = $1", [storeId])).rowCount ?? 0) >
  0;

describe("dispatch", () => {
  it("a sticky worker's second turn runs on the same worker with no generation change", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, `hello ${c.id}`);
    await until(
      () => modelSaw(`hello ${c.id}`) > 0 && settledCount(h, c.id) >= 1,
      "the first turn",
    );
    const gen = await currentLeaseGen(pool, c.storeId);
    await h.dispatcher.submit(c.id, `hello again ${c.id}`);
    await until(
      () => modelSaw(`hello again ${c.id}`) > 0 && settledCount(h, c.id) >= 2,
      "the second turn",
    );
    expect(await currentLeaseGen(pool, c.storeId)).toBe(gen);
    expect(h.spawned.filter((w) => w.storeId === c.storeId)).toHaveLength(1);
  });

  it("two messages during a running turn become one queued turn carrying both", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, "DELETE_H1");
    const ask = await asked(h, c.id);
    await h.dispatcher.submit(c.id, "first");
    await h.dispatcher.submit(c.id, "second");
    h.dispatcher.answer(c.id, ask.id, true);
    await until(() => modelSaw("first\n\nsecond") > 0, "the coalesced turn");
    await until(() => settledCount(h, c.id) >= 2, "it to settle");
    expect(modelSaw("first")).toBe(0);
    expect(modelSaw("second")).toBe(0);
  });

  it("a user's second conversation waits while the first is asking, without holding a handler", async () => {
    const h = await host();
    const sub = await user();
    const a = await createConversation(pool, sub);
    const b = await createConversation(pool, sub);
    await h.dispatcher.submit(a.id, "DELETE_H1");
    const ask = await asked(h, a.id);
    await h.dispatcher.submit(b.id, "hello from b");
    await until(() => of(h, b.id, "waiting").length > 0, "b to be sent back");
    // Still sent back a few retries later: b never got a worker while a was asking.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(h.dispatcher.isLive(b.id)).toBe(false);
    expect(modelSaw("hello from b")).toBe(0);
    h.dispatcher.answer(a.id, ask.id, true);
    await until(() => modelSaw("hello from b") > 0, "b's turn once a is done");
  });

  it("a pending confirm holds no handler: with two slots, two asking users don't block a third", async () => {
    const h = await host("narrow", 2);
    for (const _ of [0, 1]) {
      const c = await createConversation(pool, await user());
      await h.dispatcher.submit(c.id, "DELETE_H1");
      await asked(h, c.id);
    }
    const third = await createConversation(pool, await user());
    await h.dispatcher.submit(third.id, "third user");
    await until(() => modelSaw("third user") > 0, "the third user's turn", 10_000);
  });

  it("a message during a running turn queues no job behind it, and the turn's end sends it", async () => {
    // A job queued behind an active one trips pg-boss's stately unique index on fetch, and with its
    // queue cache up to a minute stale that empties the fetch for every conversation.
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, "hello");
    await until(() => settledCount(h, c.id) >= 1, "the first turn");
    await h.dispatcher.submit(c.id, `SLOW ${c.id}`);
    await until(() => modelSaw(`SLOW ${c.id}`) > 0, "the slow run to start");
    await h.dispatcher.submit(c.id, `while you wait ${c.id}`);
    const queued = await pool.query(
      "SELECT 1 FROM pgboss.job WHERE name = 'turn' AND singleton_key = $1 AND state IN ('created', 'retry')",
      [c.id],
    );
    expect(queued.rowCount).toBe(0);
    await until(() => modelSaw(`while you wait ${c.id}`) > 0, "the waiting message's turn");
  });

  it("a restart mid-run with nothing pending marks the conversation, and the next host finishes it", async () => {
    const first = await host("before");
    const c = await createConversation(pool, await user());
    await first.dispatcher.submit(c.id, "hello");
    await until(() => settledCount(first, c.id) >= 1, "the first turn");
    await first.dispatcher.submit(c.id, `SLOW ${c.id}`);
    await until(() => modelSaw(`SLOW ${c.id}`) > 0, "the slow run to start");
    await first.dispatcher.shutdown();
    expect((await getConversation(pool, c.id))?.interrupted).toBe(true);
    const second = await host("after");
    await until(() => settledCount(second, c.id) >= 1, "the resumed run to settle", 20_000);
    await until(
      async () => !(await getConversation(pool, c.id))?.interrupted,
      "the interruption to clear",
    );
  });

  it("a running turn is marked from its start, so a host killed outright leaves it for the sweeper", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, `SLOW ${c.id}`);
    await until(() => modelSaw(`SLOW ${c.id}`) > 0, "the slow run to start");
    expect((await getConversation(pool, c.id))?.interrupted).toBe(true);
    await until(() => settledCount(h, c.id) >= 1, "the run to settle");
    await until(async () => !(await getConversation(pool, c.id))?.interrupted, "the mark to clear");
  });

  it("a turn job a dead host left active stops blocking the conversation once its heartbeat goes stale", async () => {
    const dead = await host("dead");
    const c = await createConversation(pool, await user());
    // The dead host claimed a turn and was killed before finishing it: active, and nobody beating.
    await bosses[0]!.offWork("turn");
    // The dead host's sweeper queued turns for conversations earlier tests left interrupted.
    await bosses[0]!.deleteAllJobs("turn");
    await bosses[0]!.send("turn", { conversationId: c.id }, { singletonKey: c.id });
    const [claimed] = await bosses[0]!.fetch("turn");
    expect(claimed?.data).toEqual({ conversationId: c.id });
    expect(dead.spawned.filter((w) => w.storeId === c.storeId)).toHaveLength(0);
    const next = await host("next", undefined, undefined, true);
    await next.dispatcher.submit(c.id, `after the crash ${c.id}`);
    await until(
      () => modelSaw(`after the crash ${c.id}`) > 0,
      "the turn behind the dead job",
      30_000,
    );
  });

  it("the kill switch stops every turn, queued ones included, and they run once it's lifted", async () => {
    const paused = await host("paused", undefined, () => "Orbit is paused.");
    const c = await createConversation(pool, await user());
    await paused.dispatcher.submit(c.id, `held ${c.id}`);
    await until(() => of(paused, c.id, "failed").length > 0, "the turn to be turned away");
    expect(modelSaw(`held ${c.id}`)).toBe(0);
    expect((await getConversation(pool, c.id))?.interrupted).toBe(true);
    await paused.dispatcher.shutdown();
    await host("resumed");
    await until(() => modelSaw(`held ${c.id}`) > 0, "the held message to run once lifted");
  });

  it("Stop during a pending confirm settles the call as not run, and Galaxy sees no write", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    await h.dispatcher.submit(c.id, "DELETE_H1");
    await asked(h, c.id);
    h.dispatcher.stop(c.id);
    const settled = await until(
      () => of(h, c.id, "settled").find((e) => (e as Extract<Event, { type: "settled" }>).aborted),
      "the aborted run",
    );
    expect(settled).toBeDefined();
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);
  });

  it("a restart during a pending confirm asks again when the new host resumes the conversation", async () => {
    const first = await host("before");
    const c = await createConversation(pool, await user());
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    await first.dispatcher.submit(c.id, "DELETE_H1");
    await asked(first, c.id);
    await first.dispatcher.shutdown();
    expect((await getConversation(pool, c.id))?.interrupted).toBe(true);
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);

    const second = await host("after");
    const again = await asked(second, c.id);
    second.dispatcher.answer(c.id, again.id, true);
    await until(
      () => standIn.galaxyCalls("PUT", "/api/histories/h1") === puts + 1,
      "the delete, once",
    );
    await until(
      async () => !(await getConversation(pool, c.id))?.interrupted,
      "the interruption to clear",
    );
  });

  it("a crashed worker's conversation resumes on the next turn, on a fresh worker", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, "DELETE_H1");
    await asked(h, c.id);
    const gen = await currentLeaseGen(pool, c.storeId);
    await h.spawned.find((w) => w.storeId === c.storeId)!.worker.terminate();
    await until(() => of(h, c.id, "worker-exit").length > 0, "the crash");
    await h.dispatcher.submit(c.id, "after the crash");
    const again = await asked(h, c.id, 2);
    expect(h.spawned.filter((w) => w.storeId === c.storeId)).toHaveLength(2);
    expect(await currentLeaseGen(pool, c.storeId)).toBe(gen! + 1);
    h.dispatcher.answer(c.id, again.id, true);
    await until(() => modelSaw("after the crash") > 0, "the new message's turn");
  });

  it("a crash with a message in the inbox resends the turn only once the dead worker's lease is gone", async () => {
    // A slow lease release, so a turn sent before it would find the lease still held.
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    const slowRelease = new Proxy(pool, {
      get(target, prop) {
        if (prop === "query") {
          return (text: unknown, ...rest: unknown[]) =>
            typeof text === "string" && text.startsWith("DELETE FROM orbit_leases")
              ? new Promise((resolve) => setTimeout(resolve, 1500)).then(() => query(text, ...rest))
              : query(text, ...rest);
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const h = await host("host", undefined, undefined, false, {}, slowRelease);
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, `SLOW ${c.id}`);
    await until(() => modelSaw(`SLOW ${c.id}`) > 0, "the slow run to start");
    await h.dispatcher.submit(c.id, `queued behind the crash ${c.id}`);
    await h.spawned.find((w) => w.storeId === c.storeId)!.worker.terminate();
    await until(() => modelSaw(`queued behind the crash ${c.id}`) > 0, "the queued message's turn");
    expect(of(h, c.id, "waiting")).toEqual([]);
  });

  it("a worker that crashes mid-run is replaced at once, and the run resumes without a new message", async () => {
    const h = await host();
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, `SLOW ${c.id}`);
    await until(() => modelSaw(`SLOW ${c.id}`) > 0, "the slow run to start");
    await h.spawned.find((w) => w.storeId === c.storeId)!.worker.terminate();
    await until(
      () => h.spawned.filter((w) => w.storeId === c.storeId).length === 2,
      "a fresh worker",
    );
    await until(() => settledCount(h, c.id) >= 1, "the resumed run to settle");
    await until(async () => !(await getConversation(pool, c.id))?.interrupted, "the mark to clear");
  });

  it("two hosts can't both hold a conversation: the second sends the turn back instead of booting", async () => {
    const a = await host("a");
    const c = await createConversation(pool, await user());
    await a.dispatcher.submit(c.id, `hello ${c.id}`);
    await until(() => modelSaw(`hello ${c.id}`) > 0 && settledCount(a, c.id) >= 1, "a's turn");
    // a keeps its worker and lease but stops taking turns, so b gets the next one.
    await bosses[0]!.offWork("turn");
    const b = await host("b");
    await b.dispatcher.submit(c.id, "from b");
    await until(() => of(b, c.id, "waiting").length > 0, "b to find the lease taken");
    expect(b.spawned.filter((w) => w.storeId === c.storeId)).toHaveLength(0);
    expect(modelSaw("from b")).toBe(0);
  });
});

describe("idle release and the unanswered-confirm pause", () => {
  it("releases a quiet worker once no page has it open, and the next message resumes from the store", async () => {
    let watched = true;
    const h = await host("idle", undefined, undefined, false, {
      idle: { releaseMs: 800, askPauseMs: 60_000, checkMs: 100 },
      watched: () => watched,
    });
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, `first ${c.id}`);
    await until(() => settledCount(h, c.id) >= 1, "the first turn");
    const gen = await currentLeaseGen(pool, c.storeId);
    // Open in a page: kept well past the quiet period.
    await sleep(1_500);
    expect(h.dispatcher.isLive(c.id)).toBe(true);
    watched = false;
    await until(() => !h.dispatcher.isLive(c.id), "the release");
    await until(async () => !(await leaseHeld(c.storeId)), "the lease to be given back");
    expect(of(h, c.id, "worker-exit")).toHaveLength(0);
    expect(await getConversation(pool, c.id)).toMatchObject({ interrupted: false, paused: false });

    await h.dispatcher.submit(c.id, `second ${c.id}`);
    await until(() => settledCount(h, c.id) >= 2, "the turn after the release");
    expect(h.spawned.filter((w) => w.storeId === c.storeId)).toHaveLength(2);
    expect(await currentLeaseGen(pool, c.storeId)).toBe(gen! + 1);
    expect(modelSaw(`second ${c.id}`)).toBe(1);
    // No greeting on the fresh worker, and nothing the first one wrote shows up twice.
    expect(await transcript(c.id)).toEqual([
      `pi.user first ${c.id}`,
      "pi.assistant ok",
      `pi.user second ${c.id}`,
      "pi.assistant ok",
    ]);
  });

  it("a message that lands while the worker is being released waits for it and boots a fresh one", async () => {
    let h!: Host;
    const c = await createConversation(pool, await user());
    h = await host("racing", undefined, undefined, false, {
      idle: { releaseMs: 300, askPauseMs: 60_000, checkMs: 50 },
      log: (message) => {
        if (message === `releasing ${c.id}`)
          void h.dispatcher.submit(c.id, `during the release ${c.id}`);
      },
    });
    await h.dispatcher.submit(c.id, `before ${c.id}`);
    await until(() => modelSaw(`during the release ${c.id}`) > 0, "the racing message's turn");
    await until(() => settledCount(h, c.id) >= 2, "it to settle");
    expect(h.spawned.filter((w) => w.storeId === c.storeId).length).toBeGreaterThanOrEqual(2);
    expect(modelSaw(`during the release ${c.id}`)).toBe(1);
    expect((await transcript(c.id)).filter((line) => line.startsWith("pi.user"))).toEqual([
      `pi.user before ${c.id}`,
      `pi.user during the release ${c.id}`,
    ]);
  });

  it("an unanswered confirm pauses: the worker and the user's loop go, and coming back asks again, once", async () => {
    const h = await host("pause", undefined, undefined, false, {
      idle: { releaseMs: 300, askPauseMs: 2_000, checkMs: 100 },
    });
    const sub = await user();
    const c = await createConversation(pool, sub);
    const other = await createConversation(pool, sub);
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    await h.dispatcher.submit(c.id, "DELETE_H1");
    const first = await asked(h, c.id);
    // Quiet and unwatched for longer than the release time, but a pending ask is never idle.
    await sleep(1_000);
    expect(h.dispatcher.isLive(c.id)).toBe(true);

    await until(() => !h.dispatcher.isLive(c.id) && of(h, c.id, "paused").length > 0, "the pause");
    await until(
      async () => (await getConversation(pool, c.id))?.paused,
      "the pause to be recorded",
    );
    expect((await getConversation(pool, c.id))?.interrupted).toBe(false);
    expect(
      (await pool.query("SELECT 1 FROM orbit_live_loops WHERE user_sub = $1", [sub])).rowCount,
    ).toBe(0);
    expect(of(h, c.id, "ask-withdrawn")).toHaveLength(1);
    expect(h.dispatcher.answer(c.id, first.id, true)).toBe(false);
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);
    // Withdrawn by the close, not denied: the call has no result yet.
    expect((await transcript(c.id)).filter((line) => line.startsWith("pi.tool-result"))).toEqual(
      [],
    );

    // The user's other conversation runs while this one waits for them.
    await h.dispatcher.submit(other.id, `meanwhile ${other.id}`);
    await until(
      () => modelSaw(`meanwhile ${other.id}`) > 0 && settledCount(h, other.id) >= 1,
      "the other conversation's turn",
    );

    // Two tabs coming back at once still ask once.
    await Promise.all([h.dispatcher.resume(c.id), h.dispatcher.resume(c.id)]);
    const again = await asked(h, c.id, 2);
    await sleep(500);
    expect(of(h, c.id, "ask")).toHaveLength(2);
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts);
    expect(h.dispatcher.answer(c.id, again.id, true)).toBe(true);
    await until(() => standIn.galaxyCalls("PUT", "/api/histories/h1") === puts + 1, "the delete");
    await until(async () => {
      const row = await getConversation(pool, c.id);
      return row && !row.paused && !row.interrupted && settledCount(h, c.id) >= 1;
    }, "the run to finish");
    await sleep(300);
    expect(standIn.galaxyCalls("PUT", "/api/histories/h1")).toBe(puts + 1);
    expect(
      (await transcript(c.id)).filter((line) => line.startsWith("pi.tool-result")),
    ).toHaveLength(1);
  });

  it("a page that opens while the pause is closing the worker resumes it, and the old ask isn't shown", async () => {
    let h!: Host;
    const c = await createConversation(pool, await user());
    let during: { pausing: boolean; asks: number } | undefined;
    h = await host("pause-window", undefined, undefined, false, {
      idle: { releaseMs: 60_000, askPauseMs: 1_000, checkMs: 100 },
      log: (message) => {
        if (message !== `pausing ${c.id}`) return;
        during = { pausing: h.dispatcher.pausing(c.id), asks: h.dispatcher.pendingAsks(c.id).length };
        void h.dispatcher.resume(c.id);
      },
    });
    await h.dispatcher.submit(c.id, "DELETE_H1");
    await asked(h, c.id);
    const again = await asked(h, c.id, 2);
    expect(during).toEqual({ pausing: true, asks: 0 });
    await sleep(500);
    expect(of(h, c.id, "ask")).toHaveLength(2);
    expect(h.dispatcher.pausing(c.id)).toBe(false);
    expect((await getConversation(pool, c.id))?.paused).toBe(false);
    h.dispatcher.answer(c.id, again.id, false);
    await until(() => settledCount(h, c.id) >= 1, "the run to settle");
  });

  it("a message to a paused conversation resumes it and asks again before the message's turn", async () => {
    const h = await host("pause-submit", undefined, undefined, false, {
      idle: { releaseMs: 60_000, askPauseMs: 1_000, checkMs: 100 },
    });
    const c = await createConversation(pool, await user());
    await h.dispatcher.submit(c.id, "DELETE_H1");
    await asked(h, c.id);
    await until(async () => (await getConversation(pool, c.id))?.paused, "the pause");
    await h.dispatcher.submit(c.id, `back again ${c.id}`);
    const again = await asked(h, c.id, 2);
    expect(modelSaw(`back again ${c.id}`)).toBe(0);
    h.dispatcher.answer(c.id, again.id, false);
    await until(() => modelSaw(`back again ${c.id}`) > 0, "the message's turn after the answer");
    expect((await getConversation(pool, c.id))?.paused).toBe(false);
  });
});

describe("the conversation's Galaxy page", () => {
  it("is created as the user, once, with a slug Galaxy accepts", async () => {
    const sent: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const create = galaxyPageCreator({
      galaxyUrl: "https://galaxy.test",
      tokens: createTokenCache({
        refresh: async () => ({ token: "user-token", expiresAt: Date.now() + 600_000 }),
      }),
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({
          url,
          auth: new Headers(init.headers).get("authorization"),
          body: JSON.parse(String(init.body)),
        });
        return Response.json({ id: "page-7" });
      }) as typeof fetch,
    });
    const c = await createConversation(pool, await user(), "Variant calling");
    expect(await create(c)).toBe("page-7");
    expect(sent).toEqual([
      {
        url: "https://galaxy.test/api/pages",
        auth: "Bearer user-token",
        body: {
          slug: `orbit-${c.id}`,
          title: "Variant calling",
          content_format: "markdown",
          content: "",
        },
      },
    ]);
    expect(sent[0]!.body.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("takes the conversation's title once it has one, through Galaxy's page update as the user", async () => {
    const sent: Array<{ url: string; method?: string; auth: string | null; body: unknown }> = [];
    let status = 200;
    const retitle = galaxyPageRetitler({
      galaxyUrl: "https://galaxy.test",
      tokens: createTokenCache({
        refresh: async () => ({ token: "user-token", expiresAt: Date.now() + 600_000 }),
      }),
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({
          url,
          method: init.method,
          auth: new Headers(init.headers).get("authorization"),
          body: JSON.parse(String(init.body)),
        });
        return Response.json({}, { status });
      }) as typeof fetch,
    });
    const c = await createConversation(pool, await user());
    await retitle(c);
    expect(sent).toEqual([]);
    await pool.query("UPDATE orbit_conversations SET page_id = 'page-7' WHERE id = $1", [c.id]);
    const titled = await titleIfUntitled(pool, c.id, "  Call variants\non chr6");
    expect(titled).toMatchObject({ title: "Call variants", pageId: "page-7" });
    expect(await titleIfUntitled(pool, c.id, "something else")).toBeUndefined();
    await retitle(titled!);
    expect(sent).toEqual([
      {
        url: "https://galaxy.test/api/pages/page-7",
        method: "PUT",
        auth: "Bearer user-token",
        body: { title: "Call variants" },
      },
    ]);
    status = 500;
    await expect(retitle(titled!)).rejects.toThrow("HTTP 500");
  });
});
