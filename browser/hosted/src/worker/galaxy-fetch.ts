/**
 * The worker's Galaxy transport fetch (brief H5): every Galaxy request goes out as the signed-in user,
 * with their Keycloak access token in place of an API key, behind the lease fence and Orbit's redirect
 * guard.
 *
 * A custom transport fetch bypasses the guard galaxy-api.ts applies to its own requests, so this one
 * applies it itself. It hands the guard the unfenced network fetch: the request has already passed the
 * fence here, and going through the fenced global fetch would check the lease twice.
 */
import { fetchSameOriginOnly } from "../../../../shared/redirect-guard.js";
import { ServiceOutageError } from "../../../../shared/service-outage.js";
import type { LeaseFence } from "../lease/lease-fence";

/** Why the host couldn't hand over a token. */
export type TokenFailure =
  /** Keycloak is unreachable or the refresh failed for some other reason: the session waits. */
  | { readonly kind: "outage"; readonly message: string }
  /** The session was revoked or expired: the user has to sign in again. */
  | { readonly kind: "auth"; readonly message: string };

export class TokenUnavailable extends Error {
  readonly failure: TokenFailure;
  constructor(failure: TokenFailure) {
    super(failure.message);
    this.name = "TokenUnavailable";
    this.failure = failure;
  }
}

export interface GalaxyFetchOptions {
  readonly fence: LeaseFence;
  /** The user's current access token, from the host. Throws TokenUnavailable when there is none. */
  readonly token: () => Promise<string>;
  /** The network, unfenced. */
  readonly network: typeof fetch;
}

const LABELS = { serverLabel: "The Galaxy server", urlSettingLabel: "the hosted Galaxy URL" };

export function hostedGalaxyFetch(options: GalaxyFetchOptions): (url: string, init: RequestInit) => Promise<Response> {
  return options.fence.fetch(async (url, init) => {
    let token: string;
    try {
      token = await options.token();
    } catch (error) {
      if (!(error instanceof TokenUnavailable)) throw error;
      if (error.failure.kind === "outage") throw new ServiceOutageError(error.failure.message, { cause: error });
      // Read as Galaxy refusing the credential, so galaxy-ops and galaxyGet both report it as auth.
      return Response.json({ err_msg: error.failure.message }, { status: 401 });
    }
    // galaxy-ops hands over a Headers instance, galaxyGet and galaxyMutate a plain object.
    const headers = new Headers(init.headers);
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${token}`);
    return fetchSameOriginOnly(url, { ...init, headers }, { ...LABELS, fetchImpl: options.network });
  });
}
