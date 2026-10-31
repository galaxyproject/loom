import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { migratePostgresStorage, PostgresStorage } from "../storage/postgres-storage";
import { dropDatabase, freshDatabase, testDatabase } from "../test-db";
import { HOST_MIGRATIONS, migrate } from "./migrate";

const EMPTY = testDatabase("orbit_hosted_migrate_empty");
const SPIKE = testDatabase("orbit_hosted_migrate_spike");
const NEWER = testDatabase("orbit_hosted_migrate_newer");

const pools: pg.Pool[] = [];
const poolFor = async (name: string) => {
  const pool = new pg.Pool({ ...(await freshDatabase(name)), max: 4 });
  pools.push(pool);
  return pool;
};

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all([EMPTY, SPIKE, NEWER].map(dropDatabase));
});

const version = async (pool: pg.Pool, table: string) =>
  (await pool.query<{ version: number }>(`SELECT version FROM ${table}`)).rows[0]?.version;

const tables = async (pool: pg.Pool) =>
  (
    await pool.query<{ name: string }>(
      "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema IN ('public', 'pgboss')",
    )
  ).rows.map((r) => r.name);

describe("migrate", () => {
  it("builds every schema on an empty database, and a second run changes nothing", async () => {
    const pool = await poolFor(EMPTY);
    // Two hosts booting at once: the lock serializes them.
    await Promise.all([migrate(pool), migrate(pool)]);
    expect(await version(pool, "durable_schema")).toBe(2);
    expect(await version(pool, "orbit_schema")).toBe(HOST_MIGRATIONS.steps.length);
    const after = await tables(pool);
    expect(after).toEqual(
      expect.arrayContaining([
        "public.durable_stores",
        "public.orbit_users",
        "public.orbit_conversations",
        "public.orbit_sessions",
        "public.orbit_leases",
        "pgboss.job",
        "pgboss.queue",
      ]),
    );
    await migrate(pool);
    expect((await tables(pool)).sort()).toEqual(after.sort());
  });

  it("adds the host's tables to a spike database and keeps what it stored", async () => {
    const pool = await poolFor(SPIKE);
    // The spike's state: storage at v2 and nothing else.
    await migratePostgresStorage(pool);
    const storage = await PostgresStorage.open(pool, "spike-store");
    await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
    const entry = await storage.mintId<EntryId>();
    await storage.commit(
      [{ type: "entry", value: { id: entry, conversationId: ROOT_CONVERSATION_ID, kind: "kept" } }],
      BACKGROUND_CONTEXT,
    );
    await storage.close(BACKGROUND_CONTEXT);
    expect(await tables(pool)).not.toContain("public.orbit_users");

    await migrate(pool);
    expect(await version(pool, "durable_schema")).toBe(2);
    expect(await version(pool, "orbit_schema")).toBe(HOST_MIGRATIONS.steps.length);
    const reopened = await PostgresStorage.open(pool, "spike-store");
    expect((await reopened.entry(entry, BACKGROUND_CONTEXT))?.entry.kind).toBe("kept");
    await reopened.close(BACKGROUND_CONTEXT);
  });

  it("refuses a database newer than this host", async () => {
    const pool = await poolFor(NEWER);
    await migrate(pool);
    await pool.query("UPDATE orbit_schema SET version = 99");
    await expect(migrate(pool)).rejects.toThrow(/Orbit host schema is at version 99, newer than supported/);
  });
});
