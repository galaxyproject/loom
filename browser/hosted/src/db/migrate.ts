/**
 * Every schema the host needs, migrated in one call at boot: pi-durable's storage tables, the host's own
 * and pg-boss's. Each is versioned separately, so the storage tables a spike database already has are
 * left alone and only the rest are added.
 */
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";

import { migratePostgresStorage } from "../storage/postgres-storage";
import { applyMigrations, MIGRATION_LOCK, type MigrationSet } from "./migrations";

// Prefixed like durable_*, so the host's tables can't collide with anything else in the database.
export const HOST_MIGRATIONS: MigrationSet = {
  name: "Orbit host",
  versionTable: "orbit_schema",
  steps: [
    [
      `CREATE TABLE orbit_users (
        sub TEXT PRIMARY KEY,
        galaxy_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE orbit_conversations (
        id TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL REFERENCES orbit_users (sub) ON DELETE CASCADE,
        title TEXT,
        store_id TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      "CREATE INDEX orbit_conversations_by_owner ON orbit_conversations (owner_sub, last_active_at DESC)",
      // id_hash is the SHA-256 of the cookie value, so a leaked row can't be replayed as a cookie; the
      // refresh token is encrypted with ORBIT_TOKEN_KEY.
      `CREATE TABLE orbit_sessions (
        id_hash TEXT PRIMARY KEY,
        user_sub TEXT NOT NULL REFERENCES orbit_users (sub) ON DELETE CASCADE,
        refresh_token BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`,
      "CREATE INDEX orbit_sessions_by_user ON orbit_sessions (user_sub)",
      "CREATE INDEX orbit_sessions_by_expiry ON orbit_sessions (expires_at)",
      // Who holds each store's lease and until when. The generation itself stays in
      // durable_stores.lease_gen, the one place commits are fenced on.
      `CREATE TABLE orbit_leases (
        store_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`,
    ],
    [
      // The conversation's Galaxy page (its record), the pi-durable conversation once a worker has
      // created it, and whether a turn was cut off (crash, restart) and should resume.
      `ALTER TABLE orbit_conversations
        ADD COLUMN page_id TEXT,
        ADD COLUMN durable_conversation_id TEXT,
        ADD COLUMN interrupted BOOLEAN NOT NULL DEFAULT false`,
      // Messages waiting for the conversation's next turn. A queued turn drains all of them, so
      // messages that arrive while one is queued are coalesced into it.
      `CREATE TABLE orbit_inbox (
        id BIGSERIAL PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES orbit_conversations (id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      "CREATE INDEX orbit_inbox_by_conversation ON orbit_inbox (conversation_id, id)",
      // One live loop per user (brief decision 6): the conversation whose turn is running or waiting
      // on the user. Expires at the turn cap, so a host that died mid-turn can't hold it forever.
      `CREATE TABLE orbit_live_loops (
        user_sub TEXT PRIMARY KEY REFERENCES orbit_users (sub) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`,
    ],
    [
      // The user's LiteLLM virtual key (H9), sealed with ORBIT_TOKEN_KEY.
      "ALTER TABLE orbit_users ADD COLUMN model_key BYTEA",
    ],
    [
      // Gone with per-user keys: the host calls LiteLLM on one service key and tags each request
      // with the user instead.
      "ALTER TABLE orbit_users DROP COLUMN model_key",
    ],
    [
      // Which of a user's sessions the refresh uses: the one in use, since each holds its own
      // Keycloak session and the others idle out on their own.
      "ALTER TABLE orbit_sessions ADD COLUMN last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    ],
    [
      // A run paused on a confirm nobody answered (README decision 17). It resumes when the user comes
      // back to the conversation, not from the sweeper: asking again with nobody there would only
      // take a worker for another wait.
      "ALTER TABLE orbit_conversations ADD COLUMN paused BOOLEAN NOT NULL DEFAULT false",
    ],
  ],
};

/** Create or upgrade every table the host uses. Safe to run from several hosts at once. */
export async function migrate(pool: Pool): Promise<void> {
  await migratePostgresStorage(pool);
  await applyMigrations(pool, HOST_MIGRATIONS);
  await migratePgBoss(pool);
}

/**
 * pg-boss only migrates its schema from start(), so start one with nothing else running and stop it.
 * On one connection holding the migration lock: pg-boss checks for its schema before creating it, so
 * two hosts booting at once would otherwise both try to create it.
 */
async function migratePgBoss(pool: Pool): Promise<void> {
  const client = await pool.connect();
  // pg-boss sends its DDL as one BEGIN...COMMIT batch, so a failure leaves the session in an aborted
  // transaction: roll it back so the unlock can run, and never return that connection to the pool.
  let broken: Error | undefined;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      const boss = new PgBoss({
        db: { executeSql: (text, values) => client.query(text, values) },
        migrate: true,
        supervise: false,
        schedule: false,
      });
      await boss.start();
      await boss.stop({ graceful: false });
    } catch (error) {
      broken = error as Error;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK])
        .catch((unlockError: Error) => {
          broken ??= unlockError;
        });
    }
  } finally {
    client.release(broken);
  }
}
