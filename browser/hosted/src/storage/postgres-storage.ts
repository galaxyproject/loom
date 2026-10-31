import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import {
  StorageRejected,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentCopySource,
  type DocumentCreate,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type JsonObject,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import type { Pool, PoolClient } from "pg";

import { applyMigrations } from "../db/migrations";

// A Postgres port of pi-durable's SqliteStorage (dist/storage/sqlite/storage.js). Every table carries
// store_id so one database holds one logical store per conversation: the pi-durable scheduler resets
// every running task in whatever store it opens, so stores must never share task rows.

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Queryable = Pick<PoolClient, "query">;
type SqlValue = string | number | null | readonly (string | number | null)[];

const MAX_ID = Number.MAX_SAFE_INTEGER;
const DEFAULT_ID_BLOCK = 64;

/** Thrown by `commit()` when the store's lease generation moved past the one this storage was opened with. */
export class LeaseLostError extends Error {
  readonly storeId: string;
  readonly expectedGen: number;
  readonly currentGen: number;
  constructor(storeId: string, expectedGen: number, currentGen: number) {
    super(`Lease lost on store ${storeId}: holding generation ${expectedGen}, current is ${currentGen}`);
    this.name = "LeaseLostError";
    this.storeId = storeId;
    this.expectedGen = expectedGen;
    this.currentGen = currentGen;
  }
}

/**
 * Thrown when COMMIT finds the transaction already aborted by a statement whose error was caught and
 * swallowed. Deliberately not a StorageRejected: nothing was stored, so a pi-durable Session must poison.
 */
export class TransactionAbortedError extends Error {
  constructor(tag: string) {
    super(`Transaction was aborted before COMMIT (server answered ${tag}); nothing was stored`);
    this.name = "TransactionAbortedError";
  }
}

/**
 * The open commit transaction handed to the commit hook. `executeSql` makes it a pg-boss `IDatabase`, so
 * `boss.send(queue, data, { db: tx })` inserts the job inside the commit and it exists iff the commit does.
 */
export interface PostgresCommitTransaction {
  readonly storeId: string;
  readonly seq: Seq;
  readonly leaseGen: number | undefined;
  readonly writes: readonly StorageWrite[];
  readonly client: PoolClient;
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Runs inside the commit transaction while it holds the store's row lock, so lease bumps and every other
 * commit on the store wait for it: keep it short. A failed statement in it aborts the commit even if the
 * hook catches the error. It must not call `mintId` on a storage for the same store when that commit
 * writes IDs this storage did not reserve, because then the commit also holds the ID-block row.
 */
export type PostgresCommitHook = (tx: PostgresCommitTransaction) => Promise<void>;

export interface PostgresStorageOptions {
  /** Fence every commit on this lease generation; omit only for single-writer tools and tests. */
  readonly leaseGen?: number;
  readonly onCommit?: PostgresCommitHook;
  /** IDs reserved per round trip. Reservations are durable, so a later opener never reissues them. */
  readonly idBlockSize?: number;
  /** End the pool on close. Off by default because a host shares one pool across many stores. */
  readonly ownsPool?: boolean;
}

const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE durable_stores (
      store_id TEXT PRIMARY KEY,
      next_id BIGINT NOT NULL,
      next_seq BIGINT NOT NULL,
      lease_gen BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE durable_record_ids (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
      PRIMARY KEY (store_id, id)
    )`,
    // Records stay TEXT, not JSONB: JSONB reorders keys and rejects the \u0000 and lone-surrogate
    // escapes that the conformance suite requires to round-trip.
    `CREATE TABLE durable_conversations (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      owner_conversation_id BIGINT,
      owner_task_id BIGINT,
      record TEXT NOT NULL,
      PRIMARY KEY (store_id, id)
    )`,
    "CREATE INDEX durable_conversations_by_owner_conversation ON durable_conversations (store_id, owner_conversation_id, id)",
    "CREATE INDEX durable_conversations_by_owner_task ON durable_conversations (store_id, owner_task_id, id)",
    `CREATE TABLE durable_entries (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      conversation_id BIGINT NOT NULL,
      head BIGINT,
      commit_seq BIGINT NOT NULL,
      record TEXT NOT NULL,
      PRIMARY KEY (store_id, id)
    )`,
    "CREATE INDEX durable_entries_by_conversation ON durable_entries (store_id, conversation_id, id DESC)",
    "CREATE INDEX durable_entry_heads_by_conversation ON durable_entries (store_id, conversation_id, id DESC) WHERE head IS NOT NULL",
    `CREATE TABLE durable_tasks (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      conversation_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
      abort_requested BOOLEAN NOT NULL,
      background BOOLEAN NOT NULL,
      record TEXT NOT NULL,
      PRIMARY KEY (store_id, id)
    )`,
    "CREATE INDEX durable_tasks_by_status ON durable_tasks (store_id, status, id)",
    "CREATE INDEX durable_tasks_by_conversation ON durable_tasks (store_id, conversation_id, id)",
    "CREATE INDEX durable_tasks_by_kind ON durable_tasks (store_id, kind, id)",
    `CREATE TABLE durable_submissions (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      conversation_id BIGINT NOT NULL,
      request_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
      record TEXT NOT NULL,
      PRIMARY KEY (store_id, id)
    )`,
    "CREATE INDEX durable_submissions_by_request ON durable_submissions (store_id, conversation_id, request_id)",
    "CREATE INDEX durable_submissions_by_conversation ON durable_submissions (store_id, conversation_id, id)",
    "CREATE INDEX durable_submissions_by_status ON durable_submissions (store_id, status, id)",
    `CREATE TABLE durable_documents (
      store_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      family BOOLEAN NOT NULL,
      key_value TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
      owner_id BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      retired_at BIGINT,
      record TEXT NOT NULL,
      PRIMARY KEY (store_id, id)
    )`,
    `CREATE INDEX durable_documents_by_address
      ON durable_documents (store_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
    "CREATE INDEX durable_documents_by_scope ON durable_documents (store_id, scope_kind, owner_id, id)",
    "CREATE INDEX durable_documents_by_scope_kind ON durable_documents (store_id, scope_kind, owner_id, kind, id)",
    `CREATE TABLE durable_document_revisions (
      store_id TEXT NOT NULL,
      document_id BIGINT NOT NULL,
      seq BIGINT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (store_id, document_id, seq)
    )`,
    "CREATE INDEX durable_document_revisions_by_kind ON durable_document_revisions (store_id, document_id, kind, seq DESC)",
  ],
  [
    // ID reservations get their own row so a mint never waits on the store row a commit holds until COMMIT.
    "CREATE TABLE durable_id_blocks (store_id TEXT PRIMARY KEY, next_id BIGINT NOT NULL)",
    "INSERT INTO durable_id_blocks (store_id, next_id) SELECT store_id, next_id FROM durable_stores",
    "ALTER TABLE durable_stores DROP COLUMN next_id",
  ],
];

/** Create or upgrade the shared tables. Safe to call concurrently from several hosts. */
export async function migratePostgresStorage(pool: Pool): Promise<void> {
  await applyMigrations(pool, { name: "durable Postgres", versionTable: "durable_schema", steps: MIGRATIONS });
}

/** Create the store's metadata row if it is missing. Starts at ID 2 because 1 is the root conversation. */
export async function ensureStore(db: Queryable, storeId: string): Promise<void> {
  // One statement, so the two rows of a store are always created together even outside a transaction.
  await db.query(
    `WITH ids AS (INSERT INTO durable_id_blocks (store_id, next_id) VALUES ($1, 2) ON CONFLICT DO NOTHING)
      INSERT INTO durable_stores (store_id, next_seq, lease_gen) VALUES ($1, 1, 0) ON CONFLICT DO NOTHING`,
    [storeId],
  );
}

/**
 * Bump the store's lease generation, creating the store if needed. Any storage still fenced on an older
 * generation fails its next commit with LeaseLostError; a commit already holding the metadata row lock
 * finishes first, so the bump is ordered strictly after it. The host takes leases through
 * lease/leases.ts, which bumps only when the holder changes; this is the bare takeover under it.
 */
export async function bumpLeaseGen(db: Queryable, storeId: string): Promise<number> {
  const { rows } = await db.query<{ lease_gen: string }>(
    `WITH ids AS (INSERT INTO durable_id_blocks (store_id, next_id) VALUES ($1, 2) ON CONFLICT DO NOTHING)
      INSERT INTO durable_stores (store_id, next_seq, lease_gen) VALUES ($1, 1, 1)
      ON CONFLICT (store_id) DO UPDATE SET lease_gen = durable_stores.lease_gen + 1
      RETURNING lease_gen`,
    [storeId],
  );
  return Number(rows[0]!.lease_gen);
}

export async function currentLeaseGen(db: Queryable, storeId: string): Promise<number | undefined> {
  const { rows } = await db.query<{ lease_gen: string }>("SELECT lease_gen FROM durable_stores WHERE store_id = $1", [
    storeId,
  ]);
  return rows[0] === undefined ? undefined : Number(rows[0].lease_gen);
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);
// Keeps indexed identities lossless: lone surrogates and NUL survive as JSON escapes in a TEXT column.
const encodeIndexedString = (value: string): string => JSON.stringify(value);
const num = (value: string | number): number => Number(value);

const cursorId = (cursor: Cursor | undefined): number | undefined => {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
  return after;
};

const page = <T extends { readonly id: number }>(values: readonly T[], limit: number): Page<T, Cursor> => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1)!.id } };
};

const scopeColumns = (scope: DocumentRecord["scope"]): { scopeKind: string; ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
};

const addressParts = (address: DocumentAddress) => ({
  kind: encodeIndexedString(address.kind),
  ...scopeColumns(address.scope),
  family: address.key !== undefined,
  keyValue: encodeIndexedString(address.key ?? ""),
});

const addressKey = (address: DocumentAddress): string => {
  const parts = addressParts(address);
  return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === "current") return record.retiredAt === undefined;
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): number | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return write.value.id;
    case "document.create":
    case "document.copy":
      return write.record.id;
    case "document.change":
    case "document.retire":
      return undefined;
  }
};

type DocumentAction = {
  create?: DocumentCreate;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
};

type RevisionRow = { seq: string; kind: "base" | "delta"; version: number; content: string };

export async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>, begin = "BEGIN"): Promise<T> {
  const client = await pool.connect();
  // A dropped connection also fails the query in flight, which is where it's handled; the pool only
  // listens to idle clients, so a checked-out one's 'error' would otherwise take the process down.
  const dropped = () => undefined;
  client.on("error", dropped);
  // Set when BEGIN, ROLLBACK or COMMIT fails: that connection is destroyed rather than reused.
  let broken: Error | undefined;
  try {
    try {
      await client.query(begin);
    } catch (error) {
      broken = error as Error;
      throw error;
    }
    let result: T;
    try {
      result = await run(client);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = rollbackError as Error;
        // A failed rollback leaves the outcome unknown, which must not look like a clean rejection.
        throw new AggregateError([error, rollbackError], "Rollback failed after a failed transaction");
      }
      throw error;
    }
    let committed;
    try {
      committed = await client.query("COMMIT");
    } catch (error) {
      broken = error as Error;
      throw error;
    }
    // On an aborted transaction Postgres answers COMMIT with a ROLLBACK tag instead of an error. That
    // happens when a statement failed and `run` swallowed the error, e.g. a best-effort send in a hook.
    if (committed.command !== "COMMIT") throw new TransactionAbortedError(committed.command);
    return result;
  } finally {
    client.off("error", dropped);
    client.release(broken);
  }
}

/** pi-durable `Storage` over one logical store, identified by `storeId`, in a shared Postgres database. */
export class PostgresStorage implements Storage {
  readonly storeId: string;
  readonly leaseGen: number | undefined;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly idBlockSize: number;
  private onCommit: PostgresCommitHook | undefined;
  // Local slice [nextId, idBlockEnd) of a block already reserved in durable_id_blocks. idBlockEnd only
  // grows and durable next_id is always at or above it.
  private nextId = 0;
  private idBlockEnd = 0;
  // Highest ID + 1 this storage has committed; a reserved block below it is skipped.
  private idFloor = 0;
  private minting: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private inFlight = 0;
  private drained: (() => void) | undefined;

  private constructor(pool: Pool, storeId: string, options: PostgresStorageOptions) {
    this.pool = pool;
    this.storeId = storeId;
    this.leaseGen = options.leaseGen;
    this.onCommit = options.onCommit;
    this.ownsPool = options.ownsPool ?? false;
    this.idBlockSize = Math.max(1, options.idBlockSize ?? DEFAULT_ID_BLOCK);
  }

  /** Open one store, migrating the shared tables and creating the store row on first use. */
  static async open(pool: Pool, storeId: string, options: PostgresStorageOptions = {}): Promise<PostgresStorage> {
    await migratePostgresStorage(pool);
    await ensureStore(pool, storeId);
    return new PostgresStorage(pool, storeId, options);
  }

  /** Replace the hook that runs inside every commit transaction after the writes and before COMMIT. */
  setCommitHook(hook: PostgresCommitHook | undefined): void {
    this.onCommit = hook;
  }

  async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    return this.admit(async () => {
      const documentActions = this.prepareDocumentActions(writes);
      const candidateNextId = this.candidateNextId(writes);
      // IDs minted here are already durably reserved, so only foreign IDs need to lock the ID-block row.
      const raiseNextId = candidateNextId > this.idBlockEnd;
      const seq = await withTransaction(this.pool, async (client) => {
        const committedSeq = await this.fence(client);
        await this.checkGlobalIds(client, writes);
        await this.checkDocumentActions(client, documentActions);
        await this.applyTableWrites(client, writes, committedSeq);
        await this.applyDocumentActions(client, documentActions, committedSeq);
        if (raiseNextId) {
          await client.query("UPDATE durable_id_blocks SET next_id = GREATEST(next_id, $2) WHERE store_id = $1", [
            this.storeId,
            candidateNextId,
          ]);
        }
        if (this.onCommit !== undefined) {
          await this.onCommit({
            storeId: this.storeId,
            seq: committedSeq,
            leaseGen: this.leaseGen,
            writes,
            client,
            executeSql: (text, values) => client.query(text, values as SqlValue[]),
          });
        }
        return committedSeq;
      });
      this.idFloor = Math.max(this.idFloor, candidateNextId);
      return seq;
    });
  }

  /**
   * Claim the next commit sequence and check the lease in one statement. The row lock it takes serializes
   * commits and lease bumps on this store until COMMIT (mints use durable_id_blocks instead), so a lease taken over mid-commit is seen
   * either entirely before this commit (rejected here) or entirely after it.
   */
  private async fence(client: PoolClient): Promise<Seq> {
    const fenced = this.leaseGen !== undefined;
    const { rows } = await client.query<{ seq: string }>(
      `UPDATE durable_stores SET next_seq = next_seq + 1
        WHERE store_id = $1 ${fenced ? "AND lease_gen = $2" : ""}
        RETURNING next_seq - 1 AS seq`,
      fenced ? [this.storeId, this.leaseGen!] : [this.storeId],
    );
    if (rows[0] !== undefined) return num(rows[0].seq) as Seq;
    const current = await currentLeaseGen(client, this.storeId);
    if (current === undefined) throw new Error(`Durable Postgres store ${this.storeId} is missing`);
    throw new LeaseLostError(this.storeId, this.leaseGen!, current);
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return this.admit(() => {
      const minted = this.minting.then(() => this.mintNext());
      this.minting = minted.catch(() => undefined);
      return minted as Promise<I>;
    });
  }

  private async mintNext(): Promise<number> {
    while (true) {
      this.nextId = Math.max(this.nextId, this.idFloor);
      if (this.nextId < this.idBlockEnd) return this.nextId++;
      await this.reserveIdBlock();
    }
  }

  private async reserveIdBlock(): Promise<void> {
    const { rows } = await this.pool.query<{ start: string; end_id: string }>(
      `WITH old AS (SELECT next_id FROM durable_id_blocks WHERE store_id = $1 FOR UPDATE)
        UPDATE durable_id_blocks s SET next_id = LEAST(old.next_id + $2, $3::bigint + 1)
        FROM old WHERE s.store_id = $1 AND old.next_id <= $3
        RETURNING old.next_id AS start, s.next_id AS end_id`,
      [this.storeId, this.idBlockSize, MAX_ID],
    );
    if (rows[0] === undefined) {
      if ((await currentLeaseGen(this.pool, this.storeId)) === undefined) {
        throw new Error(`Durable Postgres store ${this.storeId} is missing`);
      }
      throw new Error("ID space is exhausted");
    }
    this.nextId = num(rows[0].start);
    this.idBlockEnd = num(rows[0].end_id);
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.admit(() => this.readConversation(id));
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.admit(async () => {
      const where = new Where(this.storeId);
      where.add("id > ?", cursorId(cursor) ?? -1);
      if (query.ownerConversationId !== undefined) where.add("owner_conversation_id = ?", query.ownerConversationId);
      if (query.ownerTaskId !== undefined) where.add("owner_task_id = ?", query.ownerTaskId);
      const rows = await this.all<{ record: string }>(
        `SELECT record FROM durable_conversations WHERE ${where.sql()} ORDER BY id LIMIT ${where.param(limit + 1)}`,
        where.params,
      );
      return page(
        rows.map((row) => parseJson<ConversationRecord>(row.record)),
        limit,
      );
    });
  }

  entry(
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    idOrConversationId: number,
    idOrContext: EntryId | Context,
    context?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    return this.admit(() => this.readEntry(idOrConversationId, idOrContext, context));
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.admit(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.admit(() => this.readEntries(query, limit, cursor));
  }

  private async readEntry(
    idOrConversationId: number,
    idOrContext: EntryId | Context,
    context: Context | undefined,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    const id =
      context === undefined ? idOrConversationId : typeof idOrContext === "number" ? idOrContext : undefined;
    if (id === undefined) throw new TypeError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      conversation = await this.readConversation(idOrConversationId as ConversationId);
      if (conversation === undefined) throw new Error(`Unknown conversation: ${idOrConversationId}`);
    }
    const row = await this.one<{ record: string; commit_seq: string }>(
      "SELECT record, commit_seq FROM durable_entries WHERE store_id = $1 AND id = $2",
      [this.storeId, id],
    );
    if (row === undefined) return undefined;
    const entry = parseJson<EntryRecord>(row.record);
    if (conversation !== undefined) {
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        if (conversation.parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, conversation.parent.at);
        conversation = (await this.readConversation(conversation.parent.conversationId))!;
      }
      if (entry.id > upperEntryId) return undefined;
    }
    return { entry, commitSeq: num(row.commit_seq) as Seq };
  }

  private async readLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    let conversation = await this.readConversation(conversationId);
    if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
    let upper: number | undefined = atOrBeforeEntryId;
    while (true) {
      const row =
        upper === undefined
          ? await this.one<{ record: string }>(
              `SELECT record FROM durable_entries WHERE store_id = $1 AND conversation_id = $2 AND head IS NOT NULL
                ORDER BY id DESC LIMIT 1`,
              [this.storeId, conversation.id],
            )
          : await this.one<{ record: string }>(
              `SELECT record FROM durable_entries WHERE store_id = $1 AND conversation_id = $2 AND head IS NOT NULL
                AND id <= $3 ORDER BY id DESC LIMIT 1`,
              [this.storeId, conversation.id, upper],
            );
      if (row !== undefined) return parseJson(row.record);
      if (conversation.parent === undefined) return undefined;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      conversation = (await this.readConversation(conversation.parent.conversationId))!;
    }
  }

  private async readEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<Page<EntryRecord, Cursor>> {
    let conversation = await this.readConversation(query.conversationId);
    if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
    const after = cursorId(cursor);
    let upper: number | undefined = query.maxEntryId;
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    while (true) {
      const where = new Where(this.storeId);
      where.add("conversation_id = ?", conversation.id);
      if (query.minEntryId !== undefined) where.add("id >= ?", query.minEntryId);
      if (upper !== undefined) where.add("id <= ?", upper);
      const rows = await this.all<{ record: string }>(
        `SELECT record FROM durable_entries WHERE ${where.sql()} ORDER BY id DESC LIMIT ${where.param(limit + 1 - values.length)}`,
        where.params,
      );
      values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
      if (values.length > limit || conversation.parent === undefined) break;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = (await this.readConversation(conversation.parent.conversationId))!;
    }
    return page(values, limit);
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    return this.admit(async () => {
      const row = await this.one<{ record: string }>("SELECT record FROM durable_tasks WHERE store_id = $1 AND id = $2", [
        this.storeId,
        id,
      ]);
      return row === undefined ? undefined : parseJson<StoredTask>(row.record);
    });
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    return this.admit(async () => {
      const where = new Where(this.storeId);
      where.add("id > ?", cursorId(cursor) ?? -1);
      if (query.conversationId !== undefined) where.add("conversation_id = ?", query.conversationId);
      if (query.kind !== undefined) where.add("kind = ?", encodeIndexedString(query.kind));
      if (query.status !== undefined) where.add("status = ?", query.status);
      if (query.abortRequested !== undefined) where.add("abort_requested = ?", query.abortRequested);
      if (query.background !== undefined) where.add("background = ?", query.background);
      const rows = await this.all<{ record: string }>(
        `SELECT record FROM durable_tasks WHERE ${where.sql()} ORDER BY id LIMIT ${where.param(limit + 1)}`,
        where.params,
      );
      return page(
        rows.map((row) => parseJson<StoredTask>(row.record)),
        limit,
      );
    });
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.admit(async () => {
      const row = await this.one<{ record: string }>(
        "SELECT record FROM durable_submissions WHERE store_id = $1 AND id = $2",
        [this.storeId, id],
      );
      return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
    });
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.admit(async () => {
      const where = new Where(this.storeId);
      where.add("id > ?", cursorId(cursor) ?? -1);
      if (query.conversationId !== undefined) where.add("conversation_id = ?", query.conversationId);
      if (query.status !== undefined) where.add("status = ?", query.status);
      const rows = await this.all<{ record: string }>(
        `SELECT record FROM durable_submissions WHERE ${where.sql()} ORDER BY id LIMIT ${where.param(limit + 1)}`,
        where.params,
      );
      return page(
        rows.map((row) => parseJson<SubmissionRecord>(row.record)),
        limit,
      );
    });
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.admit(async () => {
      const row = await this.one<{ record: string }>(
        "SELECT record FROM durable_submissions WHERE store_id = $1 AND conversation_id = $2 AND request_id = $3",
        [this.storeId, conversationId, encodeIndexedString(requestId)],
      );
      return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
    });
  }

  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    return this.admit(async () => {
      const parts = addressParts(address);
      const params: SqlValue[] = [
        this.storeId,
        parts.kind,
        parts.scopeKind,
        parts.ownerId,
        String(parts.family),
        parts.keyValue,
      ];
      const lifetime =
        at === "current" ? "retired_at IS NULL" : "created_at <= $7 AND (retired_at IS NULL OR retired_at > $7)";
      if (at !== "current") params.push(at);
      const row = await this.one<{ record: string }>(
        `SELECT record FROM durable_documents
          WHERE store_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
          AND ${lifetime} ORDER BY created_at DESC LIMIT 1`,
        params,
      );
      return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
    });
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    // The record and revision queries must observe one committed state; a commit between them can replace the base.
    return this.admit(() =>
      withTransaction(
        this.pool,
        (client) => this.materializeDocument(client, id, at),
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ),
    );
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.admit(async () => {
      const scope = scopeColumns(query.scope);
      const where = new Where(this.storeId);
      where.add("scope_kind = ?", scope.scopeKind);
      where.add("owner_id = ?", scope.ownerId);
      where.add("id > ?", cursorId(cursor) ?? -1);
      if (query.kind !== undefined) where.add("kind = ?", encodeIndexedString(query.kind));
      if (query.at === "current") {
        where.add("retired_at IS NULL");
      } else {
        const at = where.param(query.at);
        where.add(`created_at <= ${at} AND (retired_at IS NULL OR retired_at > ${at})`);
      }
      const rows = await this.all<{ record: string }>(
        `SELECT record FROM durable_documents WHERE ${where.sql()} ORDER BY id LIMIT ${where.param(limit + 1)}`,
        where.params,
      );
      return page(
        rows.map((row) => parseJson<DocumentRecord>(row.record)),
        limit,
      );
    });
  }

  close(_context: Context): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = this.drain();
    }
    return this.closing;
  }

  private async drain(): Promise<void> {
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
    if (this.ownsPool) await this.pool.end();
  }

  /** Every operation is admitted here so close() can wait for queries already sent to the shared pool. */
  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("PostgresStorage is closed");
    this.inFlight++;
    try {
      return await operation();
    } finally {
      if (--this.inFlight === 0) this.drained?.();
    }
  }

  private async one<T extends object>(sql: string, params: SqlValue[], db: Queryable = this.pool): Promise<T | undefined> {
    const { rows } = await db.query<T & Record<string, unknown>>(sql, params);
    return rows[0];
  }

  private async all<T extends object>(sql: string, params: SqlValue[], db: Queryable = this.pool): Promise<T[]> {
    const { rows } = await db.query<T & Record<string, unknown>>(sql, params);
    return rows;
  }

  private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
    const row = await this.one<{ record: string }>(
      "SELECT record FROM durable_conversations WHERE store_id = $1 AND id = $2",
      [this.storeId, id],
    );
    return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
  }

  private async materializeDocument(db: Queryable, id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const row = await this.one<{ record: string }>(
      "SELECT record FROM durable_documents WHERE store_id = $1 AND id = $2",
      [this.storeId, id],
      db,
    );
    if (row === undefined) return undefined;
    const record = parseJson<DocumentRecord>(row.record);
    if (at !== "current" && isCurrentOnly(record)) {
      throw new Error(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? MAX_ID : at;
    const base = await this.one<RevisionRow>(
      `SELECT seq, kind, version, content FROM durable_document_revisions
        WHERE store_id = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3 ORDER BY seq DESC LIMIT 1`,
      [this.storeId, id, upper],
      db,
    );
    if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
    let value = parseJson<JsonObject>(base.content);
    const tail = await this.all<RevisionRow>(
      `SELECT seq, kind, version, content FROM durable_document_revisions
        WHERE store_id = $1 AND document_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq`,
      [this.storeId, id, base.seq, upper],
      db,
    );
    for (const revision of tail) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      }
      value = apply(value, parseJson<Op[]>(revision.content));
    }
    return { record, version: base.version, value, deltasSinceBase: tail.length };
  }

  private candidateNextId(writes: readonly StorageWrite[]): number {
    let nextId = 0;
    for (const write of writes) {
      const id = writeId(write);
      if (id !== undefined) nextId = Math.max(nextId, id + 1);
    }
    return nextId;
  }

  private async checkGlobalIds(db: Queryable, writes: readonly StorageWrite[]): Promise<void> {
    const ids: number[] = [];
    for (const write of writes) {
      const id = writeId(write);
      if (id !== undefined) ids.push(id);
    }
    if (ids.length === 0) return;
    // One round trip for the whole batch instead of one per write.
    const { rows } = await db.query<{ id: string; record_type: string }>(
      "SELECT id, record_type FROM durable_record_ids WHERE store_id = $1 AND id = ANY($2::bigint[])",
      [this.storeId, ids],
    );
    const existingTypes = new Map(rows.map((row) => [num(row.id), row.record_type]));
    const claimed = new Map<number, string>();
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const document = write.type === "document.create" || write.type === "document.copy";
      const table = document ? "document" : write.type;
      const id = document ? write.record.id : write.value.id;
      const existing = existingTypes.get(id);
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
    const actions = new Map<DocumentId, DocumentAction>();
    for (const write of writes) {
      if (
        write.type !== "document.create" &&
        write.type !== "document.copy" &&
        write.type !== "document.change" &&
        write.type !== "document.retire"
      ) {
        continue;
      }
      const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
      let action = actions.get(id);
      if (action === undefined) {
        action = { retire: false };
        actions.set(id, action);
      }
      switch (write.type) {
        case "document.create":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.create = write.record;
          action.content = write.content;
          break;
        case "document.copy":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.create = write.record;
          action.copy = write.source;
          break;
        case "document.change":
          if (action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.content = write.content;
          break;
        case "document.retire":
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
          break;
      }
    }
    return actions;
  }

  private async checkDocumentActions(db: Queryable, actions: Map<DocumentId, DocumentAction>): Promise<void> {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) {
        throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`);
      }
      const row = await this.one<{ record: string }>(
        "SELECT record FROM durable_documents WHERE store_id = $1 AND id = $2",
        [this.storeId, id],
        db,
      );
      const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = await this.one<{ version: number }>(
          `SELECT version FROM durable_document_revisions WHERE store_id = $1 AND document_id = $2
            ORDER BY seq DESC LIMIT 1`,
          [this.storeId, id],
          db,
        );
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous.version !== action.content.version) {
          throw new Error(`Document ${id} version transition requires a base`);
        }
      }
      const record = (action.create ?? existing)!;
      const key = addressKey(record);
      let live = liveCounts.get(key);
      if (live === undefined) live = (await this.currentDocumentId(db, record)) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }

  private async currentDocumentId(db: Queryable, address: DocumentAddress): Promise<DocumentId | undefined> {
    const parts = addressParts(address);
    const row = await this.one<{ id: string }>(
      `SELECT id FROM durable_documents
        WHERE store_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
        AND retired_at IS NULL LIMIT 1`,
      [this.storeId, parts.kind, parts.scopeKind, parts.ownerId, String(parts.family), parts.keyValue],
      db,
    );
    return row === undefined ? undefined : (num(row.id) as DocumentId);
  }

  /**
   * One statement per table rather than per write: commit latency is dominated by round trips, which a
   * hosted database multiplies by its network RTT. Also claims the IDs of documents created in the batch.
   */
  private async applyTableWrites(db: Queryable, writes: readonly StorageWrite[], seq: Seq): Promise<void> {
    const store = this.storeId;
    const claims = { ids: [] as number[], types: [] as string[] };
    const conversations: Extract<StorageWrite, { type: "conversation" }>["value"][] = [];
    const entries: Extract<StorageWrite, { type: "entry" }>["value"][] = [];
    // Last write wins, as with sequential upserts; one statement may not upsert the same row twice.
    const tasks = new Map<number, Extract<StorageWrite, { type: "task" }>["value"]>();
    const submissions = new Map<number, Extract<StorageWrite, { type: "submission" }>["value"]>();
    for (const write of writes) {
      const id = writeId(write);
      if (id !== undefined) {
        claims.ids.push(id);
        claims.types.push(write.type === "document.create" || write.type === "document.copy" ? "document" : write.type);
      }
      if (write.type === "conversation") conversations.push(write.value);
      else if (write.type === "entry") entries.push(write.value);
      else if (write.type === "task") tasks.set(write.value.id, write.value);
      else if (write.type === "submission") submissions.set(write.value.id, write.value);
    }
    if (claims.ids.length > 0) {
      await db.query(
        `INSERT INTO durable_record_ids (store_id, id, record_type)
          SELECT $1, * FROM unnest($2::bigint[], $3::text[]) ON CONFLICT DO NOTHING`,
        [store, claims.ids, claims.types],
      );
    }
    if (conversations.length > 0) {
      await db.query(
        `INSERT INTO durable_conversations (store_id, id, owner_conversation_id, owner_task_id, record)
          SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::text[])`,
        [
          store,
          conversations.map((value) => value.id),
          conversations.map((value) => value.owner?.conversationId ?? null),
          conversations.map((value) => value.owner?.taskId ?? null),
          conversations.map((value) => encodeJson(value)),
        ],
      );
    }
    if (entries.length > 0) {
      await db.query(
        `INSERT INTO durable_entries (store_id, id, conversation_id, head, commit_seq, record)
          SELECT $1, id, conversation_id, head, $2, record
          FROM unnest($3::bigint[], $4::bigint[], $5::bigint[], $6::text[]) AS w(id, conversation_id, head, record)`,
        [
          store,
          seq,
          entries.map((value) => value.id),
          entries.map((value) => value.conversationId),
          entries.map((value) => value.head ?? null),
          entries.map((value) => encodeJson(value)),
        ],
      );
    }
    if (tasks.size > 0) {
      const values = [...tasks.values()];
      await db.query(
        `INSERT INTO durable_tasks (store_id, id, conversation_id, kind, status, abort_requested, background, record)
          SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::boolean[], $7::boolean[], $8::text[])
          ON CONFLICT (store_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
          status = excluded.status, abort_requested = excluded.abort_requested,
          background = excluded.background, record = excluded.record`,
        [
          store,
          values.map((value) => value.id),
          values.map((value) => value.conversationId),
          values.map((value) => encodeIndexedString(value.kind)),
          values.map((value) => value.state.status),
          values.map((value) => String(value.abortRequested)),
          values.map((value) => String(value.background)),
          values.map((value) => encodeJson(value)),
        ],
      );
    }
    if (submissions.size > 0) {
      const values = [...submissions.values()];
      await db.query(
        `INSERT INTO durable_submissions (store_id, id, conversation_id, request_id, status, record)
          SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[])
          ON CONFLICT (store_id, id) DO UPDATE SET conversation_id = excluded.conversation_id,
          request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
        [
          store,
          values.map((value) => value.id),
          values.map((value) => value.conversationId),
          values.map((value) => (value.requestId === undefined ? null : encodeIndexedString(value.requestId))),
          values.map((value) => value.status),
          values.map((value) => encodeJson(value)),
        ],
      );
    }
  }

  private async applyDocumentActions(db: Queryable, actions: Map<DocumentId, DocumentAction>, seq: Seq): Promise<void> {
    const store = this.storeId;
    for (const [id, action] of actions) {
      let content = action.content;
      if (action.copy !== undefined) {
        try {
          const stored = await this.materializeDocument(db, action.copy.id, action.copy.at);
          if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
          const create = action.create!;
          if (
            stored.record.scope.kind !== "conversation" ||
            create.scope.kind !== "conversation" ||
            stored.record.kind !== create.kind ||
            stored.record.key !== create.key ||
            stored.record.history !== create.history ||
            stored.record.fork !== create.fork
          ) {
            throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
          }
          content = { kind: "base", version: stored.version, value: stored.value };
        } catch (error) {
          if (error instanceof StorageRejected) throw error;
          throw new StorageRejected(`Document copy ${id} was rejected`, { cause: error });
        }
      }
      let record: DocumentRecord;
      if (action.create !== undefined) {
        record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        const parts = addressParts(record);
        await db.query(
          `INSERT INTO durable_documents
            (store_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            store,
            id,
            parts.kind,
            String(parts.family),
            parts.keyValue,
            parts.scopeKind,
            parts.ownerId,
            seq,
            action.retire ? seq : null,
            encodeJson(record),
          ],
        );
      } else {
        const row = (await this.one<{ record: string }>(
          "SELECT record FROM durable_documents WHERE store_id = $1 AND id = $2",
          [store, id],
          db,
        ))!;
        record = parseJson<DocumentRecord>(row.record);
      }
      if (content !== undefined) {
        if (content.kind === "base" && isCurrentOnly(record)) {
          await db.query("DELETE FROM durable_document_revisions WHERE store_id = $1 AND document_id = $2", [store, id]);
        }
        const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
        await db.query(
          `INSERT INTO durable_document_revisions (store_id, document_id, seq, kind, version, content)
            VALUES ($1, $2, $3, $4, $5, $6)`,
          [store, id, seq, content.kind, content.version, encodedContent],
        );
      }
      if (action.retire) {
        if (action.create === undefined) {
          record = { ...record, retiredAt: seq };
          await db.query(
            "UPDATE durable_documents SET retired_at = $3, record = $4 WHERE store_id = $1 AND id = $2",
            [store, id, seq, encodeJson(record)],
          );
        }
        if (isCurrentOnly(record)) {
          await db.query("DELETE FROM durable_document_revisions WHERE store_id = $1 AND document_id = $2", [store, id]);
        }
      }
    }
  }
}

/** Builds a `store_id = $1 AND ...` clause, numbering placeholders as the SQLite port's `?` markers are added. */
class Where {
  readonly params: SqlValue[];
  private readonly clauses: string[] = ["store_id = $1"];
  constructor(storeId: string) {
    this.params = [storeId];
  }
  param(value: SqlValue | boolean): string {
    this.params.push(typeof value === "boolean" ? String(value) : value);
    return `$${this.params.length}`;
  }
  add(clause: string, value?: SqlValue | boolean): void {
    this.clauses.push(value === undefined ? clause : clause.replace("?", this.param(value)));
  }
  sql(): string {
    return this.clauses.join(" AND ");
  }
}
