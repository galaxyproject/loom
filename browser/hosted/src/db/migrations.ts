import type { Pool } from "pg";

/** Tables that migrate together: the table holding their version, and their steps in order. */
export interface MigrationSet {
  /** For errors only. */
  readonly name: string;
  readonly versionTable: string;
  readonly steps: readonly (readonly string[])[];
}

// Any constant works; it only has to be the same in every process that migrates this database.
export const MIGRATION_LOCK = 0x6f726269;

/**
 * Bring one set of tables up to date. Safe to call concurrently from several hosts: the advisory lock
 * serializes them, and a set that is already current is a no-op.
 */
export async function applyMigrations(pool: Pool, set: MigrationSet): Promise<void> {
  const client = await pool.connect();
  // A connection whose ROLLBACK failed is destroyed rather than reused.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${set.versionTable} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
      );
      await client.query(`INSERT INTO ${set.versionTable} (singleton, version) VALUES (1, 0) ON CONFLICT DO NOTHING`);
      const { rows } = await client.query<{ version: number }>(
        `SELECT version FROM ${set.versionTable} WHERE singleton = 1`,
      );
      const current = rows[0]!.version;
      if (current > set.steps.length) {
        throw new Error(`The ${set.name} schema is at version ${current}, newer than supported version ${set.steps.length}`);
      }
      for (let version = current + 1; version <= set.steps.length; version++) {
        for (const statement of set.steps[version - 1]!) await client.query(statement);
        await client.query(`UPDATE ${set.versionTable} SET version = $1 WHERE singleton = 1`, [version]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: Error) => {
        broken = rollbackError;
      });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}
