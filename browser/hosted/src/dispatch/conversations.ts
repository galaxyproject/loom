/** The host's conversation records: who owns each, its store, its Galaxy page and its pi-durable id. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export interface ConversationRow {
  readonly id: string;
  readonly ownerSub: string;
  readonly title: string | null;
  readonly storeId: string;
  readonly pageId: string | null;
  readonly durableConversationId: string | null;
  readonly interrupted: boolean;
  /** Paused on an unanswered confirm; it asks again when the user comes back. */
  readonly paused: boolean;
  readonly lastActiveAt: Date;
}

const COLUMNS = `id, owner_sub, title, store_id, page_id, durable_conversation_id, interrupted, paused, last_active_at`;

type Row = {
  id: string;
  owner_sub: string;
  title: string | null;
  store_id: string;
  page_id: string | null;
  durable_conversation_id: string | null;
  interrupted: boolean;
  paused: boolean;
  last_active_at: Date;
};

const fromRow = (row: Row): ConversationRow => ({
  id: row.id,
  ownerSub: row.owner_sub,
  title: row.title,
  storeId: row.store_id,
  pageId: row.page_id,
  durableConversationId: row.durable_conversation_id,
  interrupted: row.interrupted,
  paused: row.paused,
  lastActiveAt: row.last_active_at,
});

/** A new conversation in its own store: pi-durable resets running tasks store-wide, so none share. */
export async function createConversation(db: Queryable, ownerSub: string, title?: string): Promise<ConversationRow> {
  const id = randomUUID();
  const { rows } = await db.query<Row>(
    `INSERT INTO orbit_conversations (id, owner_sub, title, store_id) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [id, ownerSub, title ?? null, `conversation-${id}`],
  );
  return fromRow(rows[0]!);
}

/** Name an untitled conversation, from its first message; a title once set stays. Returns the row when this call named it. */
export async function titleIfUntitled(db: Queryable, id: string, text: string): Promise<ConversationRow | undefined> {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
  const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  if (!title) return undefined;
  const { rows } = await db.query<Row>(
    `UPDATE orbit_conversations SET title = $2 WHERE id = $1 AND title IS NULL RETURNING ${COLUMNS}`,
    [id, title],
  );
  return rows[0] && fromRow(rows[0]);
}

export async function getConversation(db: Queryable, id: string): Promise<ConversationRow | undefined> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM orbit_conversations WHERE id = $1`, [id]);
  return rows[0] && fromRow(rows[0]);
}

/** The user's conversations, most recently active first. */
export async function listConversations(db: Queryable, ownerSub: string): Promise<ConversationRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM orbit_conversations WHERE owner_sub = $1 ORDER BY last_active_at DESC`,
    [ownerSub],
  );
  return rows.map(fromRow);
}

export async function interruptedConversations(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM orbit_conversations WHERE interrupted");
  return rows.map((r) => r.id);
}
