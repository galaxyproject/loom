/**
 * Fetch the current Galaxy user for the configured API key.
 *
 * Lives in the main process because that's the only place the plaintext key
 * exists -- the renderer only ever sees the masked config. The renderer asks
 * for this via the `galaxy:current-user` IPC and uses it to show *who* the key
 * authenticates as in the status tooltip (not just the server URL).
 *
 * Returns a small discriminated result the tooltip formatter consumes directly:
 *   - { ok: true, username?, email? }  the key authenticated; identity (if any)
 *   - { ok: false, authFailed: true }  401/403 -- the key is wrong/expired
 *   - { ok: false, authFailed: false } offline / timeout / 5xx / no creds
 */
import { validateGalaxyUrl } from "./galaxy-url.js";

export type GalaxyUserStatus =
  | { ok: true; username?: string; email?: string }
  | { ok: false; authFailed: boolean };

/** A non-empty string, or undefined -- Galaxy returns "" for unset fields. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export async function fetchGalaxyCurrentUser(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<GalaxyUserStatus> {
  const base = url.trim().replace(/\/+$/, "");
  const key = apiKey.trim();
  if (!base || !key) return { ok: false, authFailed: false };
  // Never send the key to a non-https/non-loopback host, even if a legacy or
  // hand-edited config slipped one past config:save validation.
  if (!validateGalaxyUrl(base).ok) return { ok: false, authFailed: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/users/current`, {
      headers: { "x-api-key": key },
      signal: controller.signal,
    });
    // 401/403 is the one failure worth surfacing -- a wrong or expired key.
    // Everything else (offline, timeout, 5xx) stays silent so a transient blip
    // doesn't cry "sign-in failed" on a perfectly good key.
    if (res.status === 401 || res.status === 403) return { ok: false, authFailed: true };
    if (!res.ok) return { ok: false, authFailed: false };
    // Body isn't size-capped; the configured Galaxy server is semi-trusted and
    // the timeout bounds wall time, so a pathological huge body is low risk.
    const body = (await res.json()) as { username?: unknown; email?: unknown };
    return { ok: true, username: nonEmptyString(body.username), email: nonEmptyString(body.email) };
  } catch {
    return { ok: false, authFailed: false };
  } finally {
    clearTimeout(timer);
  }
}
