/**
 * The host's access tokens, one per signed-in user (brief H5 and H6). A token is refreshed ahead of its
 * expiry, and concurrent requests during a refresh share that one refresh: Keycloak rotates refresh
 * tokens, so two refreshes racing with the same refresh token would end the session.
 */
import { TokenUnavailable } from "../worker/galaxy-fetch";

export interface AccessToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export interface TokenCacheOptions {
  /**
   * Get a new access token for the user. Throws TokenUnavailable (outage or auth) when it can't; H6's
   * Keycloak refresh stores the rotated refresh token before resolving.
   */
  readonly refresh: (sub: string) => Promise<AccessToken>;
  /** Refresh this long before expiry, so a token never runs out mid-request. */
  readonly skewMs?: number;
  readonly now?: () => number;
}

export interface TokenCache {
  token(sub: string): Promise<string>;
  /** Drop the user's token, as sign-out does. */
  forget(sub: string): void;
}

export function createTokenCache(options: TokenCacheOptions): TokenCache {
  const skew = options.skewMs ?? 30_000;
  const now = options.now ?? Date.now;
  const current = new Map<string, AccessToken>();
  const refreshing = new Map<string, Promise<AccessToken>>();
  // Bumped by forget, so a refresh that was in flight at sign-out can't put the token back.
  const epochs = new Map<string, number>();

  return {
    async token(sub) {
      const held = current.get(sub);
      if (held && held.expiresAt - skew > now()) return held.token;
      const asked = epochs.get(sub) ?? 0;
      let flight = refreshing.get(sub);
      if (!flight) {
        const epoch = epochs.get(sub) ?? 0;
        const started: Promise<AccessToken> = options.refresh(sub).finally(() => {
          if (refreshing.get(sub) === started) refreshing.delete(sub);
        });
        flight = started;
        refreshing.set(sub, flight);
        flight.then(
          (fresh) => {
            if ((epochs.get(sub) ?? 0) === epoch) current.set(sub, fresh);
          },
          () => current.delete(sub),
        );
      }
      const fresh = await flight;
      // Signed out while waiting: the token belongs to a session that has ended.
      if ((epochs.get(sub) ?? 0) !== asked) {
        throw new TokenUnavailable({ kind: "auth", message: "You're signed out. Sign in again to continue." });
      }
      return fresh.token;
    },
    forget(sub) {
      current.delete(sub);
      refreshing.delete(sub);
      epochs.set(sub, (epochs.get(sub) ?? 0) + 1);
    },
  };
}
