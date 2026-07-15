/**
 * Bind-safety + WebSocket auth for the Orbit Web server.
 *
 * The WebSocket drives a real Loom agent against env-injected Galaxy/LLM
 * credentials, so an exposed, unauthenticated port is an open agent. These
 * pure helpers keep the server loopback-only unless the operator both binds a
 * public host AND sets a shared token -- or explicitly accepts the risk for a
 * trusted private network / reverse proxy.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export interface BindDecision {
  ok: boolean;
  error?: string;
}

/**
 * Decide whether the server may start given its bind host + token config. A
 * non-loopback bind with no token and no explicit opt-out is refused: that's
 * the "anyone who reaches the port gets an authenticated agent" case.
 */
export function evaluateBind(
  host: string,
  token: string | undefined,
  allowInsecure: boolean,
): BindDecision {
  if (isLoopbackHost(host)) return { ok: true };
  if (token && token.length > 0) return { ok: true };
  if (allowInsecure) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to bind ${host} without auth -- the WebSocket drives a live agent ` +
      `against your injected credentials. Set LOOM_WEB_TOKEN=<secret> (clients pass ` +
      `it as ?token=<secret>), keep the default loopback bind, or set ` +
      `LOOM_WEB_ALLOW_INSECURE=1 if this sits behind a trusted reverse proxy.`,
  };
}

export interface WsUpgradeInfo {
  origin?: string;
  host?: string;
  url?: string;
}

export interface WsAuthResult {
  ok: boolean;
  reason?: string;
}

function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get("token") ?? undefined;
}

export interface WsAuthPolicy {
  /**
   * Reject upgrades that carry no Origin header at all.
   *
   * Set when the server has no token to check -- remote/GxIT mode, where the
   * entry-point URL can't carry one. Without it, "no Origin" skipped the only
   * check standing between the control socket and any process that can reach
   * the port (a neighbouring container on the Docker bridge, say), which is a
   * live credentialed agent for the taking.
   *
   * Browsers always send Origin on a WebSocket upgrade, so this only narrows
   * the accepted set by the non-browser clients that have no business here: any
   * upgrade that passes the origin match today still passes.
   */
  requireOrigin?: boolean;
}

/**
 * Authorize a WebSocket upgrade: reject cross-origin sockets (blocks a drive-by
 * page in the user's browser from opening one), then require the shared token
 * when one is configured. A request with no Origin (non-browser client) skips
 * the origin check but still needs the token -- unless policy.requireOrigin is
 * set, which rejects it outright.
 */
export function authorizeWsUpgrade(
  info: WsUpgradeInfo,
  expectedToken: string | undefined,
  policy: WsAuthPolicy = {},
): WsAuthResult {
  if (policy.requireOrigin && !info.origin) {
    return { ok: false, reason: "missing Origin header" };
  }
  if (info.origin && info.host) {
    let originHost: string;
    try {
      originHost = new URL(info.origin).host;
    } catch {
      return { ok: false, reason: "malformed Origin header" };
    }
    if (originHost !== info.host) return { ok: false, reason: "cross-origin WebSocket" };
  } else if (policy.requireOrigin) {
    // Origin present but no Host to compare it against: nothing to verify, and
    // this policy exists precisely because there's no token to fall back on.
    return { ok: false, reason: "missing Host header" };
  }
  if (expectedToken) {
    if (tokenFromUrl(info.url) !== expectedToken) {
      return { ok: false, reason: "missing or invalid token" };
    }
  }
  return { ok: true };
}
