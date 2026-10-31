import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type DocumentId,
  type EntryId,
  type StorageWrite,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEnv } from "../../../../shared/orbit-env.js";
import {
  LeaseLostError,
  PostgresStorage,
  TransactionAbortedError,
  bumpLeaseGen,
  currentLeaseGen,
  migratePostgresStorage,
} from "./postgres-storage";

// The spike's dedicated database; the step-0 task reserves this name for these tests.
const DATABASE = readEnv("STEP0_STORAGE_DB") ?? "loom_step0_storage";
const connection = { host: process.env.PGHOST ?? "/tmp", port: 5432, database: DATABASE };
const context = BACKGROUND_CONTEXT;

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ ...connection, max: 10 });
  await migratePostgresStorage(pool);
});

afterAll(async () => {
  await pool?.end();
});

const freshStoreId = (label: string) => `${label}-${randomUUID()}`;

const task = (id: number, status: "pending" | "running"): TaskRecord<any, any, any> => ({
  id: id as TaskId,
  conversationId: ROOT_CONVERSATION_ID,
  kind: "test.task",
  version: 1,
  input: { value: id },
  state: { status, checkpoint: { phase: status } },
  background: false,
  abortRequested: false,
});

const root: StorageWrite = { type: "conversation", value: { id: ROOT_CONVERSATION_ID } };

registerStorageConformance({ describe, expect, it }, "PostgresStorage conformance", async (use) => {
  // Each case gets its own store in the shared database, which is the production layout.
  const storage = await PostgresStorage.open(pool, freshStoreId("conformance"));
  try {
    await use(storage);
  } finally {
    await storage.close(context);
  }
});

describe("PostgresStorage store isolation", () => {
  it("keeps two stores in one database fully separate, including scheduler-visible task rows", async () => {
    const a = await PostgresStorage.open(pool, freshStoreId("iso-a"));
    const b = await PostgresStorage.open(pool, freshStoreId("iso-b"));
    try {
      // Both stores use the same reserved root ID and mint from the same starting point.
      await a.commit([root], context);
      await b.commit([root], context);
      const aEntry = await a.mintId<EntryId>();
      const bEntry = await b.mintId<EntryId>();
      expect(aEntry).toBe(2);
      expect(bEntry).toBe(2);
      const aTask = await a.mintId<TaskId>();
      await a.commit(
        [
          { type: "entry", value: { id: aEntry, conversationId: ROOT_CONVERSATION_ID, kind: "a-only" } },
          { type: "task", value: task(aTask, "running") },
          {
            type: "submission",
            value: { id: (await a.mintId()) as any, conversationId: ROOT_CONVERSATION_ID, requestId: "r", type: "input", status: "queued" },
          },
          {
            type: "document.create",
            record: { id: (await a.mintId()) as DocumentId, kind: "notes", scope: { kind: "session" } },
            content: { kind: "base", version: 1, value: { owner: "a" } },
          },
        ],
        context,
      );
      // The same ID is free in store b, and a write there does not collide with store a's record.
      await b.commit([{ type: "entry", value: { id: bEntry, conversationId: ROOT_CONVERSATION_ID, kind: "b-only" } }], context);

      expect((await a.entry(aEntry, context))?.entry.kind).toBe("a-only");
      expect((await b.entry(bEntry, context))?.entry.kind).toBe("b-only");
      // The scheduler's restart scan: a running task in store a must not appear when store b opens.
      expect((await a.scanTasks({ status: "running" }, 10, undefined, context)).items.map((t) => t.id)).toEqual([aTask]);
      expect((await b.scanTasks({ status: "running" }, 10, undefined, context)).items).toEqual([]);
      expect((await b.scanTasks({}, 10, undefined, context)).items).toEqual([]);
      expect(await b.task(aTask, context)).toBeUndefined();
      expect(await b.submissionByRequest(ROOT_CONVERSATION_ID, "r", context)).toBeUndefined();
      expect((await b.scanSubmissions({}, 10, undefined, context)).items).toEqual([]);
      expect(await b.findDocument({ kind: "notes", scope: { kind: "session" } }, "current", context)).toBeUndefined();
      expect((await b.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context)).items.map((e) => e.kind)).toEqual([
        "b-only",
      ]);
      // Seq is per store too.
      const aSeq = await a.commit([], context);
      const bSeq = await b.commit([], context);
      expect(aSeq).toBe(3);
      expect(bSeq).toBe(3);
    } finally {
      await a.close(context);
      await b.close(context);
    }
  });
});

describe("PostgresStorage lease fence", () => {
  // The fence is the commit's first statement, so a stale commit is refused before it writes anything;
  // rollback of writes already applied is covered by the hook tests below.
  it("rejects a stale-generation commit with LeaseLostError before it writes anything", async () => {
    const storeId = freshStoreId("fence");
    const firstGen = await bumpLeaseGen(pool, storeId);
    expect(firstGen).toBe(1);
    const stale = await PostgresStorage.open(pool, storeId, { leaseGen: firstGen });
    await stale.commit([root], context);
    const keptEntry = await stale.mintId<EntryId>();
    const keptSeq = await stale.commit(
      [{ type: "entry", value: { id: keptEntry, conversationId: ROOT_CONVERSATION_ID, kind: "kept" } }],
      context,
    );

    const secondGen = await bumpLeaseGen(pool, storeId);
    expect(secondGen).toBe(2);
    const lostEntry = await stale.mintId<EntryId>();
    const lostTask = await stale.mintId<TaskId>();
    const error = await stale
      .commit(
        [
          { type: "entry", value: { id: lostEntry, conversationId: ROOT_CONVERSATION_ID, kind: "lost" } },
          { type: "task", value: task(lostTask, "running") },
        ],
        context,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LeaseLostError);
    expect(error).toMatchObject({ storeId, expectedGen: 1, currentGen: 2 });

    const owner = await PostgresStorage.open(pool, storeId, { leaseGen: secondGen });
    try {
      expect(await owner.entry(lostEntry, context)).toBeUndefined();
      expect(await owner.task(lostTask, context)).toBeUndefined();
      const ids = await pool.query("SELECT id FROM durable_record_ids WHERE store_id = $1 AND id = ANY($2::bigint[])", [
        storeId,
        [lostEntry, lostTask],
      ]);
      expect(ids.rowCount).toBe(0);
      // The rejected commit consumed no sequence number.
      expect(await owner.commit([], context)).toBe(keptSeq + 1);
      expect((await owner.entry(keptEntry, context))?.entry.kind).toBe("kept");
      // Mints by the stale holder are durable reservations, so the new holder never reissues them.
      expect(await owner.mintId()).toBeGreaterThan(lostTask);
    } finally {
      await stale.close(context);
      await owner.close(context);
    }
  });

  it("poisons a pi-durable Session that loses its lease, so the stale worker cannot commit again", async () => {
    const storeId = freshStoreId("fence-session");
    const gen = await bumpLeaseGen(pool, storeId);
    const storage = await PostgresStorage.open(pool, storeId, { leaseGen: gen });
    await storage.commit([root], context);
    const session = createSession(storage);
    await session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "before" }), context);
    await bumpLeaseGen(pool, storeId);
    await expect(session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "after" }), context)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    // LeaseLostError is deliberately not StorageRejected: Session treats it as an unknown outcome and poisons.
    await expect(session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "again" }), context)).rejects.toThrow(
      "poisoned",
    );
    await session.close(context).catch(() => undefined);
  });

  it("orders a lease takeover strictly after a commit that already holds the store row", async () => {
    const storeId = freshStoreId("fence-order");
    const gen = await bumpLeaseGen(pool, storeId);
    let releaseHook!: () => void;
    let hookEntered!: () => void;
    const entered = new Promise<void>((resolve) => (hookEntered = resolve));
    const storage = await PostgresStorage.open(pool, storeId, { leaseGen: gen });
    await storage.commit([root], context);
    storage.setCommitHook(async () => {
      hookEntered();
      await new Promise<void>((resolve) => (releaseHook = resolve));
    });
    const entryId = await storage.mintId<EntryId>();
    const committing = storage.commit(
      [{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "in-flight" } }],
      context,
    );
    await entered;
    let takeoverDone = false;
    const takeover = bumpLeaseGen(pool, storeId).then((next) => {
      takeoverDone = true;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The bump is blocked on the row lock the in-flight commit holds.
    expect(takeoverDone).toBe(false);
    releaseHook();
    await committing;
    expect(await takeover).toBe(gen + 1);
    storage.setCommitHook(undefined);
    await expect(storage.commit([], context)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await currentLeaseGen(pool, storeId)).toBe(gen + 1);
    await storage.close(context);
  });
});

describe("PostgresStorage commit hook", () => {
  it("fails the commit when the hook swallows a SQL error, instead of reporting a seq that was rolled back", async () => {
    const storage = await PostgresStorage.open(pool, freshStoreId("hook-swallow"));
    await storage.commit([root], context);
    storage.setCommitHook(async (tx) => {
      try {
        await tx.executeSql("SELECT 1/0");
      } catch {
        // A best-effort wake that hides its failure: Postgres has still aborted the transaction.
      }
    });
    const entryId = await storage.mintId<EntryId>();
    const error = await storage
      .commit([{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "x" } }], context)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransactionAbortedError);
    storage.setCommitHook(undefined);
    expect(await storage.entry(entryId, context)).toBeUndefined();
    // The aborted commit's seq was never stored, so the next commit reuses it rather than skipping it.
    expect(await storage.commit([], context)).toBe(2);
    await storage.close(context);
  });

  it("poisons a pi-durable Session whose commit hook swallowed an error", async () => {
    const storage = await PostgresStorage.open(pool, freshStoreId("hook-swallow-session"));
    await storage.commit([root], context);
    const session = createSession(storage);
    storage.setCommitHook(async (tx) => {
      await tx.executeSql("SELECT 1/0").catch(() => undefined);
    });
    await expect(session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "lost" }), context)).rejects.toBeInstanceOf(
      TransactionAbortedError,
    );
    storage.setCommitHook(undefined);
    await expect(session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "again" }), context)).rejects.toThrow(
      "poisoned",
    );
    await session.close(context).catch(() => undefined);
    await storage.close(context).catch(() => undefined);
  });

  it("lets mintId reserve a new block while another commit's hook is still open", async () => {
    const storage = await PostgresStorage.open(pool, freshStoreId("hook-mint"), { idBlockSize: 1 });
    await storage.commit([root], context);
    let release!: () => void;
    let entered!: () => void;
    const inHook = new Promise<void>((resolve) => (entered = resolve));
    storage.setCommitHook(async () => {
      entered();
      await new Promise<void>((resolve) => (release = resolve));
    });
    const entryId = await storage.mintId<EntryId>();
    const committing = storage.commit(
      [{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "held" } }],
      context,
    );
    await inHook;
    // idBlockSize 1 means this mint must reserve a block in Postgres while the commit holds the store row.
    const minted = await Promise.race([
      storage.mintId<EntryId>(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    release();
    await committing;
    expect(minted).toBe(entryId + 1);
    storage.setCommitHook(undefined);
    await storage.close(context);
  });
});

describe("PostgresStorage batched writes", () => {
  it("applies repeated task and submission writes in one commit as last-write-wins", async () => {
    const storage = await PostgresStorage.open(pool, freshStoreId("batch"));
    try {
      await storage.commit([root], context);
      const taskId = await storage.mintId<TaskId>();
      const entries = await Promise.all(Array.from({ length: 50 }, () => storage.mintId<EntryId>()));
      await storage.commit(
        [
          { type: "task", value: task(taskId, "pending") },
          ...entries.map((id): StorageWrite => ({ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: `e${id}` } })),
          { type: "task", value: task(taskId, "running") },
        ],
        context,
      );
      expect((await storage.task(taskId, context))?.state.status).toBe("running");
      for (const id of entries) expect((await storage.entry(id, context))?.entry.kind).toBe(`e${id}`);
      const claimed = await pool.query("SELECT count(*)::int AS n FROM durable_record_ids WHERE store_id = $1", [storage.storeId]);
      expect(claimed.rows[0].n).toBe(1 + 1 + entries.length);
    } finally {
      await storage.close(context);
    }
  });
});

describe("PostgresStorage reopen", () => {
  it("sees all state from a fresh Pool and keeps minting above every ID the previous holder reserved", async () => {
    const storeId = freshStoreId("reopen");
    const firstPool = new pg.Pool({ ...connection, max: 2 });
    const first = await PostgresStorage.open(firstPool, storeId, { ownsPool: true, idBlockSize: 16 });
    await first.commit([root], context);
    const entryId = await first.mintId<EntryId>();
    const taskId = await first.mintId<TaskId>();
    const submissionId = await first.mintId();
    const documentId = await first.mintId<DocumentId>();
    const forkId = await first.mintId<ConversationId>();
    await first.commit(
      [
        { type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "user", head: entryId, data: { text: "hi" } } },
        { type: "task", value: task(taskId, "running") },
        {
          type: "submission",
          value: { id: submissionId as any, conversationId: ROOT_CONVERSATION_ID, requestId: "req", type: "input", status: "placed", entry: entryId },
        },
        {
          type: "document.create",
          record: {
            id: documentId,
            kind: "notebook",
            scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
            history: "rewindable",
            fork: "asOf",
          },
          content: { kind: "base", version: 1, value: { cells: [] } },
        },
      ],
      context,
    );
    const deltaSeq = await first.commit(
      [{ type: "document.change", id: documentId, content: { kind: "delta", version: 1, ops: [["s", ["title"], "t"]] } }],
      context,
    );
    await first.commit([{ type: "conversation", value: { id: forkId, parent: { conversationId: ROOT_CONVERSATION_ID, at: entryId } } }], context);
    // Reserved but never committed, as when a host dies mid-turn.
    const unusedId = await first.mintId();
    await first.close(context);

    const secondPool = new pg.Pool({ ...connection, max: 2 });
    const second = await PostgresStorage.open(secondPool, storeId, { ownsPool: true });
    try {
      expect(await second.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
      expect((await second.entry(entryId, context))?.entry).toMatchObject({ kind: "user", data: { text: "hi" } });
      expect((await second.entry(forkId, entryId, context))?.entry.id).toBe(entryId);
      expect((await second.findLatestHeadMarker(forkId, undefined, context))?.id).toBe(entryId);
      expect((await second.scanTasks({ status: "running" }, 10, undefined, context)).items.map((t) => t.id)).toEqual([taskId]);
      expect((await second.submissionByRequest(ROOT_CONVERSATION_ID, "req", context))?.id).toBe(submissionId);
      const doc = await second.document(documentId, "current", context);
      expect(doc).toMatchObject({ version: 1, value: { cells: [], title: "t" }, deltasSinceBase: 1 });
      expect((await second.document(documentId, (deltaSeq - 1) as any, context))?.value).toEqual({ cells: [] });
      const next = await second.mintId();
      expect(next).toBeGreaterThan(unusedId);
      // Sequence continues from the stored counter, not from 1.
      expect(await second.commit([], context)).toBe(deltaSeq + 2);
    } finally {
      await second.close(context);
    }
  });
});

describe("PostgresStorage transactional wake through pg-boss", () => {
  const queue = "orbit-wake";
  let boss: PgBoss;

  beforeAll(async () => {
    boss = new PgBoss({ ...connection, schema: "pgboss_step0", supervise: false, schedule: false });
    boss.on("error", (error) => console.error("pg-boss", error));
    await boss.start();
    await boss.createQueue(queue);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  const jobsFor = async (storeId: string) =>
    (await boss.findJobs<{ storeId: string; seq: number }>(queue, { data: { storeId } })).map((job) => job.data);

  it("sends the wake job inside the commit: present iff the commit succeeded, absent when the fence rejects", async () => {
    const storeId = freshStoreId("wake");
    const gen = await bumpLeaseGen(pool, storeId);
    let hookCalls = 0;
    const storage = await PostgresStorage.open(pool, storeId, {
      leaseGen: gen,
      // The tx object is passed as pg-boss's `db` directly: it implements IDatabase.executeSql.
      onCommit: async (tx) => {
        hookCalls++;
        await boss.send(queue, { storeId: tx.storeId, seq: tx.seq }, { db: tx });
      },
    });
    const committedSeq = await storage.commit([root], context);
    expect(await jobsFor(storeId)).toEqual([{ storeId, seq: committedSeq }]);

    await bumpLeaseGen(pool, storeId);
    await expect(storage.commit([], context)).rejects.toBeInstanceOf(LeaseLostError);
    // The fence runs before the hook, so a stale holder never even attempts the send.
    expect(hookCalls).toBe(1);
    expect(await jobsFor(storeId)).toEqual([{ storeId, seq: committedSeq }]);
    await storage.close(context);
  });

  it("rolls the wake job back with the commit when anything after the send fails", async () => {
    const storeId = freshStoreId("wake-rollback");
    const gen = await bumpLeaseGen(pool, storeId);
    const storage = await PostgresStorage.open(pool, storeId, { leaseGen: gen });
    await storage.commit([root], context);
    let sentId: string | null = null;
    storage.setCommitHook(async (tx) => {
      sentId = await boss.send(queue, { storeId: tx.storeId, seq: tx.seq }, { db: tx });
      throw new Error("host failed after enqueueing the wake");
    });
    const entryId = await storage.mintId<EntryId>();
    await expect(
      storage.commit([{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "x" } }], context),
    ).rejects.toThrow("host failed after enqueueing the wake");
    // The send really ran and got an id inside the transaction; rollback removed both it and the entry.
    expect(sentId).not.toBeNull();
    expect(await boss.findJobs(queue, { id: sentId! })).toEqual([]);
    expect(await jobsFor(storeId)).toEqual([]);
    expect(await storage.entry(entryId, context)).toBeUndefined();

    // A takeover that lands after the send but before COMMIT cannot happen: the fence holds the row lock.
    // So the only fence outcome to cover is the one above, where the hook never runs.
    storage.setCommitHook(async (tx) => {
      await boss.send(queue, { storeId: tx.storeId, seq: tx.seq }, { db: tx });
    });
    const seq = await storage.commit([], context);
    expect(await jobsFor(storeId)).toEqual([{ storeId, seq }]);
    await storage.close(context);
  });
});
