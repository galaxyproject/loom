/**
 * Does the page embedding us actually contain a frame that tries to leave?
 *
 * This is the one part of the sandbox the widget cannot enforce itself. A
 * document may navigate itself; the embedding page's `frame-src` is what stops
 * it. So rather than assume, read the policy the page is actually running
 * under and refuse to draw anything if it would not hold. Fail closed: a
 * feature that is off by default and has not shipped should not be the thing
 * that discovers a widened directive in production.
 */

import { SANDBOX_INERT_FRAME_SOURCES } from "./policy.js";

export interface HostFramePolicy {
  /** True when at least one policy pins frames to sources that cannot reach the network. */
  contained: boolean;
  /** The effective frame-src that made the decision, for the explanatory card. */
  effective: string | null;
  /** Sources that are not inert, when it is not contained. */
  offending: string[];
}

/** Split a policy string into `directive -> sources`. */
function parsePolicy(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of text.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!out.has(name)) out.set(name, tokens.slice(1));
  }
  return out;
}

/** `frame-src`, then `child-src`, then `default-src` -- the CSP fallback chain. */
function effectiveFrameSrc(policy: Map<string, string[]>): string[] | null {
  return policy.get("frame-src") ?? policy.get("child-src") ?? policy.get("default-src") ?? null;
}

function isInert(source: string): boolean {
  return SANDBOX_INERT_FRAME_SOURCES.includes(source.toLowerCase());
}

/**
 * Several policies may apply at once and all of them are enforced, so the
 * frame is contained if **any one** of them pins it to inert sources.
 */
export function checkHostFramePolicy(doc: Document = document): HostFramePolicy {
  // `doc.head` only. A CSP meta in the body is ignored by the browser, so
  // scanning the whole document let a policy that is not being enforced satisfy
  // the precondition -- and the agent can get markup into the body. The check
  // has to look where the browser looks.
  const metas = Array.from(doc.head?.querySelectorAll("meta") ?? []).filter(
    (m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy",
  );

  let bestOffending: string[] | null = null;
  let bestEffective: string | null = null;

  for (const meta of metas) {
    const sources = effectiveFrameSrc(parsePolicy(meta.getAttribute("content") ?? ""));
    if (!sources) continue;
    const offending = sources.filter((s) => !isInert(s));
    if (offending.length === 0) {
      return { contained: true, effective: sources.join(" "), offending: [] };
    }
    if (bestOffending === null || offending.length < bestOffending.length) {
      bestOffending = offending;
      bestEffective = sources.join(" ");
    }
  }

  return { contained: false, effective: bestEffective, offending: bestOffending ?? [] };
}
