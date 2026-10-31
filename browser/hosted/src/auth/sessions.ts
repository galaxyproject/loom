/**
 * Browser sessions (brief H6). The cookie carries a random id; orbit_sessions keeps its SHA-256, the
 * user, and the refresh token sealed with ORBIT_TOKEN_KEY. The refresh token never leaves the host.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../storage/postgres-storage";
import { TokenUnavailable } from "../worker/galaxy-fetch";
import type { AccessToken } from "../tokens/token-cache";
import type { Oidc, TokenSet } from "./oidc";
import { seal, unseal } from "./seal";

const PURPOSE = "orbit refresh token";

type Queryable = Pick<PoolClient, "query">;

export const hashSessionId = (id: string) => createHash("sha256").update(id).digest("hex");

export interface Session {
  readonly sub: string;
  readonly expiresAt: Date;
}

/** Record a signed-in user and start a session; the returned id goes in the cookie and nowhere else. */
export async function createSession(db: Queryable, key: Buffer, tokens: TokenSet): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO orbit_users (sub) VALUES ($1)
      ON CONFLICT (sub) DO UPDATE SET last_seen_at = now()`,
    [tokens.sub],
  );
  await db.query(
    "INSERT INTO orbit_sessions (id_hash, user_sub, refresh_token, expires_at) VALUES ($1, $2, $3, $4)",
    [hashSessionId(id), tokens.sub, seal(key, tokens.refreshToken, PURPOSE), new Date(tokens.refreshExpiresAt)],
  );
  return id;
}

/** The live session behind a cookie id, marked as used so the user's refreshes go through it. */
export async function findSession(db: Queryable, id: string): Promise<Session | undefined> {
  // A row locked by a refresh is already the one in use, and waiting on it would hold this request
  // for as long as Keycloak takes to answer: skip the mark and just read it.
  const { rows } = await db.query<{ user_sub: string; expires_at: Date }>(
    `WITH used AS (
       UPDATE orbit_sessions SET last_used_at = now()
        WHERE id_hash = (SELECT id_hash FROM orbit_sessions WHERE id_hash = $1 FOR UPDATE SKIP LOCKED)
          AND expires_at > now()
        RETURNING user_sub, expires_at)
     SELECT user_sub, expires_at FROM used
     UNION ALL
     SELECT user_sub, expires_at FROM orbit_sessions
      WHERE id_hash = $1 AND expires_at > now() AND NOT EXISTS (SELECT 1 FROM used)`,
    [hashSessionId(id)],
  );
  const row = rows[0];
  return row ? { sub: row.user_sub, expiresAt: row.expires_at } : undefined;
}

/** End the session: revoke its refresh token at Keycloak (best effort) and delete the row. */
export async function endSession(db: Queryable, key: Buffer, oidc: Oidc, id: string): Promise<Session | undefined> {
  const { rows } = await db.query<{ user_sub: string; expires_at: Date; refresh_token: Buffer }>(
    "DELETE FROM orbit_sessions WHERE id_hash = $1 RETURNING user_sub, expires_at, refresh_token",
    [hashSessionId(id)],
  );
  const row = rows[0];
  if (!row) return undefined;
  const refreshToken = unseal(key, row.refresh_token, PURPOSE);
  if (refreshToken) await oidc.revoke(refreshToken);
  return { sub: row.user_sub, expiresAt: row.expires_at };
}

/**
 * A fresh access token for the user, from their most recently used live session: the token cache's
 * `refresh`. The session row is locked for the refresh, and the rotated refresh token is stored before
 * the access token is handed out, because Keycloak accepts each refresh token once: losing the new one
 * would end the session.
 */
export function refreshForUser(pool: Pool, key: Buffer, oidc: Oidc): (sub: string) => Promise<AccessToken> {
  return async (sub) => {
    const outcome = await withTransaction(pool, async (client): Promise<AccessToken | Ended> => {
      const { rows } = await client.query<{ id_hash: string; refresh_token: Buffer }>(
        `SELECT id_hash, refresh_token FROM orbit_sessions
          WHERE user_sub = $1 AND expires_at > now()
          ORDER BY last_used_at DESC LIMIT 1 FOR UPDATE`,
        [sub],
      );
      const row = rows[0];
      if (!row) return { ended: undefined, message: "You're signed out. Sign in again to continue." };
      const refreshToken = unseal(key, row.refresh_token, PURPOSE);
      if (!refreshToken) return { ended: row.id_hash, message: ENDED };
      let fresh: TokenSet;
      try {
        fresh = await oidc.refresh(refreshToken);
      } catch (error) {
        // An ended session goes; an outage leaves it for when Keycloak is back.
        if (error instanceof TokenUnavailable && error.failure.kind === "auth") {
          return { ended: row.id_hash, message: error.failure.message };
        }
        throw error;
      }
      await client.query("UPDATE orbit_sessions SET refresh_token = $2, expires_at = $3 WHERE id_hash = $1", [
        row.id_hash,
        seal(key, fresh.refreshToken, PURPOSE),
        new Date(fresh.refreshExpiresAt),
      ]);
      return { token: fresh.accessToken, expiresAt: fresh.accessExpiresAt };
    });
    if (!("ended" in outcome)) return outcome;
    // Deleted outside the refresh's transaction, which throwing would roll back.
    if (outcome.ended) await pool.query("DELETE FROM orbit_sessions WHERE id_hash = $1", [outcome.ended]);
    throw new TokenUnavailable({ kind: "auth", message: outcome.message });
  };
}

const ENDED = "Your sign-in has ended. Sign in again to continue.";

/** A refresh that found the session over: which row to delete (if any) and what to tell the user. */
type Ended = { readonly ended: string | undefined; readonly message: string };
