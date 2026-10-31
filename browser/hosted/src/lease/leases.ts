/**
 * The host's conversation leases (brief decision 9).
 *
 * A worker's storage is fenced on the generation it opened with, so the generation may change only
 * when the holder does: a sticky worker renews every turn and keeps committing, and only a new holder
 * (after a crash, an expiry or a restart) bumps it. The generation lives in durable_stores.lease_gen
 * alone; orbit_leases records who holds it and until when, written in the same transaction.
 */
import type { Pool, PoolClient } from "pg";

import { ensureStore, withTransaction } from "../storage/postgres-storage";

type Queryable = Pick<PoolClient, "query">;

/**
 * Take the store's lease for `holder`, creating the store if needed, and return the generation its
 * storage should be fenced on; undefined when another holder's lease is still live. The same holder
 * acquiring again extends its lease without a bump, so `holder` must name one worker instance, never a
 * host or a reused id: a restarted worker under an old name would inherit the old generation and leave
 * a hung predecessor unfenced.
 */
export async function acquireLease(
  pool: Pool,
  storeId: string,
  holder: string,
  ttlMs: number,
): Promise<number | undefined> {
  return withTransaction(pool, (client) => acquireLeaseInTransaction(client, storeId, holder, ttlMs));
}

/** acquireLease inside the caller's transaction, for a check that has to commit with it. */
export async function acquireLeaseInTransaction(
  client: Queryable,
  storeId: string,
  holder: string,
  ttlMs: number,
): Promise<number | undefined> {
  await ensureStore(client, storeId);
  // The store row is the lock every acquirer and every commit on this store takes, so two acquirers
  // are serialized here and a bump lands strictly between commits.
  const { rows: stores } = await client.query<{ lease_gen: string }>(
    "SELECT lease_gen FROM durable_stores WHERE store_id = $1 FOR UPDATE",
    [storeId],
  );
  // Locked too, so a renew or release racing this takeover waits for it and then finds the new holder,
  // rather than reporting a lease its caller no longer has.
  const { rows: leases } = await client.query<{ holder: string; live: boolean }>(
    "SELECT holder, expires_at > now() AS live FROM orbit_leases WHERE store_id = $1 FOR UPDATE",
    [storeId],
  );
  const held = leases[0];
  if (held?.holder === holder) {
    await extend(client, storeId, holder, ttlMs);
    return Number(stores[0]!.lease_gen);
  }
  if (held?.live) return undefined;
  const { rows: bumped } = await client.query<{ lease_gen: string }>(
    "UPDATE durable_stores SET lease_gen = lease_gen + 1 WHERE store_id = $1 RETURNING lease_gen",
    [storeId],
  );
  await client.query(
    `INSERT INTO orbit_leases (store_id, holder, acquired_at, expires_at)
      VALUES ($1, $2, now(), now() + $3 * interval '1 millisecond')
      ON CONFLICT (store_id) DO UPDATE
        SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at`,
    [storeId, holder, ttlMs],
  );
  return Number(bumped[0]!.lease_gen);
}

/**
 * Extend `holder`'s lease without touching the generation. False when it no longer holds it. An expired
 * lease nobody else took is still the holder's: no other writer was fenced in, so nothing it has
 * committed since could conflict.
 */
export async function renewLease(db: Queryable, storeId: string, holder: string, ttlMs: number): Promise<boolean> {
  return extend(db, storeId, holder, ttlMs);
}

/** Give the lease up, so the next acquirer needn't wait out the TTL. Its acquire still bumps. */
export async function releaseLease(db: Queryable, storeId: string, holder: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM orbit_leases WHERE store_id = $1 AND holder = $2", [
    storeId,
    holder,
  ]);
  return rowCount === 1;
}

async function extend(db: Queryable, storeId: string, holder: string, ttlMs: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE orbit_leases SET expires_at = now() + $3 * interval '1 millisecond'
      WHERE store_id = $1 AND holder = $2`,
    [storeId, holder, ttlMs],
  );
  return rowCount === 1;
}
