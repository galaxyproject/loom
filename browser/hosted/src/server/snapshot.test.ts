import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { createConversation, getConversation } from "../dispatch/conversations";
import { PostgresStorage } from "../storage/postgres-storage";
import { freshDatabase, testDatabase } from "../test-db";
import { storedSnapshot } from "./snapshot";

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await freshDatabase(testDatabase("orbit_hosted_snapshot"))), max: 4 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

/** A conversation whose worker has gone: its entries are only in the store. */
async function stored(kinds: Array<string | { head: "first" }>) {
  const sub = `user-${randomUUID()}`;
  await pool.query("INSERT INTO orbit_users (sub) VALUES ($1)", [sub]);
  const conversation = await createConversation(pool, sub);
  const storage = await PostgresStorage.open(pool, conversation.storeId);
  await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
  const ids: EntryId[] = [];
  for (const kind of kinds) {
    const id = await storage.mintId<EntryId>();
    const value =
      typeof kind === "string"
        ? { id, conversationId: ROOT_CONVERSATION_ID, kind }
        : { id, conversationId: ROOT_CONVERSATION_ID, kind: "summary", head: ids[1]! };
    await storage.commit([{ type: "entry", value } as StorageWrite], BACKGROUND_CONTEXT);
    ids.push(id);
  }
  await storage.close(BACKGROUND_CONTEXT);
  await pool.query("UPDATE orbit_conversations SET durable_conversation_id = $2 WHERE id = $1", [conversation.id, String(ROOT_CONVERSATION_ID)]);
  return { conversation: (await getConversation(pool, conversation.id))!, ids };
}

describe("a stored snapshot", () => {
  it("reads the transcript oldest first", async () => {
    const { conversation } = await stored(["one", "two", "three"]);
    const snapshot = await storedSnapshot(pool, conversation);
    expect(snapshot.entries.map((e) => e.kind)).toEqual(["one", "two", "three"]);
  });

  it("after a compaction, shows the summary and what follows its head, as a worker's view does", async () => {
    const { conversation } = await stored(["old", "kept", { head: "first" }, "new"]);
    const snapshot = await storedSnapshot(pool, conversation);
    expect(snapshot.entries.map((e) => e.kind)).toEqual(["summary", "kept", "new"]);
  });

  it("is empty for a conversation no worker has opened yet", async () => {
    const sub = `user-${randomUUID()}`;
    await pool.query("INSERT INTO orbit_users (sub) VALUES ($1)", [sub]);
    expect((await storedSnapshot(pool, await createConversation(pool, sub))).entries).toEqual([]);
  });
});
