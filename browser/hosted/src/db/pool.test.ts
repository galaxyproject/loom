import pg from "pg";
import { afterAll, expect, it } from "vitest";

import { withTransaction } from "../storage/postgres-storage";
import { connection, dropDatabase, freshDatabase, testDatabase } from "../test-db";
import { createPool } from "./pool";

const DATABASE = testDatabase("orbit_hosted_pool");

afterAll(async () => {
  await dropDatabase(DATABASE);
});

it("survives Postgres dropping its idle connections, and the next query reconnects", async () => {
  await freshDatabase(DATABASE);
  const lost: string[] = [];
  const pool = createPool({ ...connection(DATABASE), application_name: "pool-under-test" }, (m) => lost.push(m));
  try {
    await Promise.all([pool.query("SELECT 1"), pool.query("SELECT 1")]);
    expect(pool.idleCount).toBeGreaterThan(0);
    const admin = new pg.Client(connection(DATABASE));
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pool-under-test'");
    await admin.end();
    const deadline = Date.now() + 5000;
    while (lost.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lost[0]).toMatch(/database connection lost/);
    expect((await pool.query<{ one: number }>("SELECT 1 AS one")).rows[0]?.one).toBe(1);
  } finally {
    await pool.end();
  }
});

it("a transaction whose connection Postgres drops rejects, rather than taking the process down", async () => {
  await freshDatabase(DATABASE);
  const pool = createPool({ ...connection(DATABASE), application_name: "pool-under-test" });
  try {
    const dropped = withTransaction(pool, async (client) => {
      await client.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
      await client.query("SELECT 1");
    });
    await expect(dropped).rejects.toThrow();
    expect((await pool.query<{ one: number }>("SELECT 1 AS one")).rows[0]?.one).toBe(1);
  } finally {
    await pool.end();
  }
});
