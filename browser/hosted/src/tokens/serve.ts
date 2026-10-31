/**
 * The host's side of a worker's token requests (brief H5): one access token per request, never to a
 * worker whose lease generation is no longer current.
 */
import type { PoolClient } from "pg";

import { currentLeaseGen } from "../storage/postgres-storage";
import { TokenUnavailable } from "../worker/galaxy-fetch";
import type { TokenAnswer } from "../worker/protocol";
import type { TokenCache } from "./token-cache";

export interface TokenRequestContext {
  /** The Keycloak subject the conversation belongs to. */
  readonly sub: string;
  readonly storeId: string;
  readonly leaseGen: number;
  readonly db: Pick<PoolClient, "query">;
  readonly tokens: TokenCache;
}

export async function answerTokenRequest(context: TokenRequestContext): Promise<TokenAnswer> {
  let current: number | undefined;
  try {
    current = await currentLeaseGen(context.db, context.storeId);
  } catch {
    return { failure: { kind: "outage", message: "Orbit couldn't reach its database." } };
  }
  if (current !== context.leaseGen) {
    return { failure: { kind: "lease", message: "This conversation moved to another worker." } };
  }
  try {
    return { token: await context.tokens.token(context.sub) };
  } catch (error) {
    if (error instanceof TokenUnavailable) return { failure: error.failure };
    // Anything else is the sign-in service misbehaving, not the user's session ending.
    return { failure: { kind: "outage", message: "The sign-in service couldn't be reached." } };
  }
}
