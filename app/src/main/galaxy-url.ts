/**
 * Galaxy URL hygiene for the main process. Mirrors the brain's
 * extensions/loom/profiles.ts validators: the brain guards the `/connect`
 * path, this guards Orbit's config:save and the current-user fetch so a
 * compromised renderer (or a hand-edited config) can't repoint the decrypted
 * API key at an attacker URL or downgrade it to cleartext http.
 */

/** Default a scheme-less URL to https:// (users type bare hostnames). */
export function normalizeGalaxyUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * A Galaxy URL is safe to send the API key to only over https, or over http
 * when the host is loopback (local installs). Everything else is rejected so
 * the key can't be exfiltrated to an attacker host or sent in cleartext.
 */
export function validateGalaxyUrl(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    // Match real loopback only. A bare startsWith("127.") would also accept a
    // resolvable hostname like "127.evil.example" -- a cleartext-exfil hole.
    // URL.hostname keeps the brackets on an IPv6 literal ("[::1]").
    const loopback =
      host === "localhost" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host === "::1" ||
      host === "[::1]";
    if (loopback) return { ok: true };
    return {
      ok: false,
      reason: "Galaxy URL must use https:// (the API key is sent on every request).",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  return { ok: true };
}
