import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { currentLeaseGen, LeaseLostError, PostgresStorage } from "../storage/postgres-storage";
import { ensureDatabase, testDatabase } from "../test-db";
import { acquireLease, acquireLeaseInTransaction, releaseLease, renewLease } from "./leases";

const TTL = 60_000;

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await ensureDatabase(testDatabase("orbit_hosted_leases"))), max: 8 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

const freshStoreId = () => `lease-${randomUUID()}`;

const holderOf = async (storeId: string) =>
  (await pool.query<{ holder: string }>("SELECT holder FROM orbit_leases WHERE store_id = $1", [storeId])).rows[0]
    ?.holder;

const expire = (storeId: string) =>
  pool.query("UPDATE orbit_leases SET expires_at = now() - interval '1 second' WHERE store_id = $1", [storeId]);

/** One commit on storage fenced at `leaseGen`, the way a worker writes each turn. */
async function commitTurn(storage: PostgresStorage): Promise<void> {
  const id = await storage.mintId<EntryId>();
  await storage.commit(
    [{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "turn" } }],
    BACKGROUND_CONTEXT,
  );
}

async function openFenced(storeId: string, leaseGen: number): Promise<PostgresStorage> {
  const storage = await PostgresStorage.open(pool, storeId, { leaseGen });
  await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
  return storage;
}

describe("conversation leases", () => {
  it("a first acquire creates the store, bumps to generation 1 and records the holder", async () => {
    const storeId = freshStoreId();
    expect(await acquireLease(pool, storeId, "worker-a", TTL)).toBe(1);
    expect(await currentLeaseGen(pool, storeId)).toBe(1);
    expect(await holderOf(storeId)).toBe("worker-a");
  });

  it("a sticky worker's renewals and re-acquires never move the generation, so its next turn commits", async () => {
    const storeId = freshStoreId();
    const gen = (await acquireLease(pool, storeId, "worker-a", TTL))!;
    const storage = await openFenced(storeId, gen);
    for (let turn = 0; turn < 3; turn++) {
      expect(await renewLease(pool, storeId, "worker-a", TTL)).toBe(true);
      expect(await acquireLease(pool, storeId, "worker-a", TTL)).toBe(gen);
      await commitTurn(storage);
    }
    expect(await currentLeaseGen(pool, storeId)).toBe(gen);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("another holder can't take a live lease, and can't renew it", async () => {
    const storeId = freshStoreId();
    const gen = await acquireLease(pool, storeId, "worker-a", TTL);
    expect(await acquireLease(pool, storeId, "worker-b", TTL)).toBeUndefined();
    expect(await renewLease(pool, storeId, "worker-b", TTL)).toBe(false);
    expect(await currentLeaseGen(pool, storeId)).toBe(gen);
    expect(await holderOf(storeId)).toBe("worker-a");
  });

  it("a new holder takes an expired lease with a bump, which fences the old worker out", async () => {
    const storeId = freshStoreId();
    const gen = (await acquireLease(pool, storeId, "worker-a", TTL))!;
    const old = await openFenced(storeId, gen);
    await expire(storeId);
    expect(await acquireLease(pool, storeId, "worker-b", TTL)).toBe(gen + 1);
    expect(await holderOf(storeId)).toBe("worker-b");
    expect(await renewLease(pool, storeId, "worker-a", TTL)).toBe(false);
    await expect(commitTurn(old)).rejects.toBeInstanceOf(LeaseLostError);
    await old.close(BACKGROUND_CONTEXT);
  });

  it("an expired lease nobody took is still its holder's, with no bump", async () => {
    const storeId = freshStoreId();
    const gen = (await acquireLease(pool, storeId, "worker-a", TTL))!;
    const storage = await openFenced(storeId, gen);
    await expire(storeId);
    expect(await renewLease(pool, storeId, "worker-a", TTL)).toBe(true);
    await commitTurn(storage);
    await storage.close(BACKGROUND_CONTEXT);
  });

  it("a released lease is taken at once, still with a bump", async () => {
    const storeId = freshStoreId();
    const gen = (await acquireLease(pool, storeId, "worker-a", TTL))!;
    expect(await releaseLease(pool, storeId, "worker-b")).toBe(false);
    expect(await releaseLease(pool, storeId, "worker-a")).toBe(true);
    expect(await acquireLease(pool, storeId, "worker-b", TTL)).toBe(gen + 1);
  });

  it("a renew racing a takeover waits for it and then reports the lease lost", async () => {
    const storeId = freshStoreId();
    await acquireLease(pool, storeId, "worker-a", TTL);
    await expire(storeId);
    const takeover = await pool.connect();
    // Hold the takeover between reading the lease and writing the new holder, the window a renew
    // could otherwise slip into.
    let readLease!: () => void;
    const leaseRead = new Promise<void>((resolve) => (readLease = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    const paused = {
      query: async (text: string, values?: unknown[]) => {
        const result = await takeover.query(text, values);
        if (text.includes("AS live FROM orbit_leases")) {
          readLease();
          await resumed;
        }
        return result;
      },
    } as unknown as pg.PoolClient;
    try {
      await takeover.query("BEGIN");
      const acquiring = acquireLeaseInTransaction(paused, storeId, "worker-b", TTL);
      await leaseRead;
      let settled = false;
      const renewing = renewLease(pool, storeId, "worker-a", TTL).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
      resume();
      expect(await acquiring).toBe(2);
      await takeover.query("COMMIT");
      expect(await renewing).toBe(false);
    } finally {
      takeover.release();
    }
    expect(await holderOf(storeId)).toBe("worker-b");
  });

  it("of two holders acquiring at once, exactly one gets the lease", async () => {
    const storeId = freshStoreId();
    const results = await Promise.all(
      ["worker-a", "worker-b", "worker-c", "worker-d"].map((holder) => acquireLease(pool, storeId, holder, TTL)),
    );
    expect(results.filter((gen) => gen !== undefined)).toEqual([1]);
    expect(await currentLeaseGen(pool, storeId)).toBe(1);
  });
});
