/**
 * Decision logic for the OpenAI-compatible endpoint probe -- the `/models`
 * call behind live API-key validation and `models:discover`.
 *
 * Split out from ipc-handlers so the parts that decide *what to tell the user*
 * are reachable from tests without an Electron main process or a live server.
 * The I/O stays in the caller.
 */

export type ProbeOutcome = { valid: boolean; error?: string; models?: string[] };

/**
 * Undici reports every transport failure as `TypeError: fetch failed`. The
 * reason is on `err.cause`, and dropping it is why a reachability problem and
 * a typo'd hostname read identically in the UI (loom#441).
 */
const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: "Host not found -- check the base URL",
  EAI_AGAIN: "DNS lookup failed -- check the base URL or your connection",
  ECONNREFUSED: "Connection refused -- nothing is listening there",
  ECONNRESET: "Connection reset by the server or something in between",
  ETIMEDOUT: "Connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  EPROTO: "TLS handshake failed",
};

/**
 * Certificate rejections deserve their own sentence: they are what a
 * TLS-inspecting corporate proxy or a private CA looks like from here, and
 * Loom verifies against Node's bundled CA list rather than the OS trust store,
 * so a certificate the browser accepts can still fail this probe.
 */
const CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** First `code` on the error or anywhere down its cause chain. */
function firstCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Deepest non-empty message on the cause chain, which is the specific one. */
function deepestMessage(err: unknown): string {
  let cur: unknown = err;
  let best = "";
  for (let depth = 0; cur && depth < 6; depth++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) best = msg.trim();
    cur = (cur as { cause?: unknown }).cause;
  }
  return best;
}

/**
 * Turn a thrown fetch error into something a bug report can act on.
 *
 * `proxyConfigured` is passed in rather than read from env so this stays
 * pure. It matters because Node's fetch ignores HTTP(S)_PROXY: when one is
 * set, "cannot reach it" almost certainly means "cannot reach it without the
 * proxy", and saying so beats letting the user re-check a URL that is fine.
 */
export function describeNetworkError(
  err: unknown,
  opts: { proxyConfigured?: boolean } = {},
): string {
  const name = (err as { name?: unknown }).name;
  const message = deepestMessage(err);
  if (name === "AbortError" || message.toLowerCase().includes("abort")) {
    return "Validation timed out";
  }
  const code = firstCode(err);
  let head: string;
  if (code && CERT_CODES.has(code)) {
    head = `TLS certificate not trusted (${code}) -- Loom checks Node's CA list, not the system store`;
  } else if (code && NETWORK_HINTS[code]) {
    head = `${NETWORK_HINTS[code]} (${code})`;
  } else if (code && code.startsWith("ERR_SSL")) {
    head = `TLS handshake failed (${code})`;
  } else if (code) {
    head = `Network error: ${message || "request failed"} (${code})`;
  } else {
    head = `Network error: ${message || "request failed"}`;
  }
  // Only worth saying once we already know the request failed.
  if (opts.proxyConfigured) head += ". A proxy is set in your environment; Loom does not use it";
  return head;
}

/**
 * Normalize and sanity-check a user-typed base URL.
 *
 * The non-ASCII check exists because a URL copied out of rendered text can
 * carry a look-alike -- a non-breaking hyphen, an en dash, a Cyrillic letter.
 * It punycodes into a hostname that resolves nowhere, so the only symptom is
 * a DNS failure against a URL that looks correct on screen.
 */
export function checkBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: false, error: "Base URL is empty" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "Base URL must start with http(s)://" };
  }
  const authority = trimmed.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
  for (const ch of authority) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 127) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      return {
        ok: false,
        error: `Base URL host has a non-ASCII character (U+${hex}) -- retype it rather than pasting`,
      };
    }
  }
  try {
    new URL(trimmed);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL" };
  }
  return { ok: true, url: trimmed };
}

/** One line of server text, safe to drop into a status label. */
function snippet(body: string): string {
  const flat = body
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function extractModelIds(parsed: unknown): string[] {
  const raw = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown })?.data;
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : m))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

/**
 * Decide what a `/models` reply means.
 *
 * The non-JSON case is not pedantry. Blablador answers an unauthenticated
 * `/v1/models` with `200 OK` and the plain-text line "You must provide a valid
 * API key", so treating any 2xx as proof of a working key would tell someone
 * their setup is fine while it serves no models. A body we cannot parse means
 * we verified nothing, and the server's own sentence is usually the most
 * useful thing we can put on screen.
 */
export function interpretModelsResponse(status: number, body: string): ProbeOutcome {
  if (status === 401) return { valid: false, error: "Invalid API key (401)" };
  if (status === 403) return { valid: false, error: "Endpoint rejected the key (403)" };
  if (status < 200 || status >= 300) {
    return { valid: false, error: `Unexpected response: HTTP ${status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const text = snippet(body);
    if (!text) {
      return {
        valid: false,
        error: `Endpoint returned an empty reply to /models (HTTP ${status})`,
      };
    }
    if (text.startsWith("<")) {
      return {
        valid: false,
        error: "Endpoint returned a web page, not a model list -- check the base URL",
      };
    }
    return { valid: false, error: `Endpoint did not return a model list: ${text}` };
  }
  // Parseable but not an OpenAI-shaped list: the key got through, so stay out
  // of the way and let the saved model stand.
  return { valid: true, models: extractModelIds(parsed) };
}
