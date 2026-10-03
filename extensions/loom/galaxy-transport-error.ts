// Mid-session, the MCP client can lose its stdio transport to the galaxy-mcp
// subprocess, and the failing call comes back with a transport error. pi
// reconnects on the next call, so the fix is to retry and re-bind the Galaxy
// session, not to re-authenticate Galaxy. mcp-recovery.ts supplies the
// agent-facing steps; this module classifies and notifies.
//
// Crucially this must NOT match galaxy-mcp's own "Not connected to Galaxy.
// Authenticate via OAuth or run connect()..." error, which is an auth problem
// that /mcp reconnect won't fix.

import { isGalaxyMcpTool } from "../../shared/galaxy-mcp-tools.js";

// A dropped transport: the server is gone and a new connection fixes it.
const DROPPED_ERROR_PATTERNS: RegExp[] = [
  /not connected(?!\s+to\s+galaxy)/i, // bare SDK "Not connected"; exclude the verbose auth error
  /connection closed/i, // -32000, and pi's "MCP connection closed"
  /MCP client is (?:closed|connecting)/i, // pi: a call on a client that already went away
  /-32000/,
];

// A timeout proves only that no response arrived within the request budget.
// Narrow reads first; reconnect can help a wedge but not an oversized query.
const TIMEOUT_ERROR_PATTERNS: RegExp[] = [
  /request timed out/i, // -32001
  /-32001/,
];

const TRANSPORT_ERROR_PATTERNS: RegExp[] = [...DROPPED_ERROR_PATTERNS, ...TIMEOUT_ERROR_PATTERNS];

export const GALAXY_RECONNECT_NUDGE =
  "Galaxy MCP connection dropped. The agent can reconnect it; if that fails, run /mcp reconnect galaxy (no restart needed).";

// Deliberately does not claim the server is healthy: a timeout only proves that
// no response arrived before the timer, so a wedged server looks identical to a
// slow one. It also doesn't send the user to mcp.json -- the brain registers the
// galaxy server itself on every load, so there's nothing there to edit.
// Agent-facing recovery instructions live in mcp-recovery.ts. The UI notice
// states the uncertainty, with /mcp reconnect as the user's fallback once the
// agent's single re-bind is spent.
export const GALAXY_TIMEOUT_NUDGE =
  "Galaxy MCP request timed out. Its result is unknown; this does not mean a Galaxy job failed.";

/** Which kind of failure this is, so callers can give advice that can work. */
export type GalaxyFailureKind = "dropped" | "timeout" | null;

export function classifyGalaxyFailure(
  toolName: string | undefined,
  text: string | undefined,
): GalaxyFailureKind {
  if (!isGalaxyMcpTool(toolName) || !text) return null;
  // Timeout first: a -32001 body can also mention "not connected" downstream,
  // and the timeout reading is the actionable one.
  if (TIMEOUT_ERROR_PATTERNS.some((p) => p.test(text))) return "timeout";
  if (DROPPED_ERROR_PATTERNS.some((p) => p.test(text))) return "dropped";
  return null;
}

/** The nudge matching a classification, or null when there is nothing useful to say. */
export function galaxyFailureNudge(kind: GalaxyFailureKind): string | null {
  if (kind === "dropped") return GALAXY_RECONNECT_NUDGE;
  if (kind === "timeout") return GALAXY_TIMEOUT_NUDGE;
  return null;
}

export function isGalaxyTransportError(
  toolName: string | undefined,
  text: string | undefined,
): boolean {
  if (!isGalaxyMcpTool(toolName)) return false;
  if (!text) return false;
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Which failure kinds may still nudge. Tracked per kind rather than as one bit,
 * because a timeout and a drop need opposite advice: letting a timeout disarm
 * the reconnect hint would swallow the more actionable message when a slow
 * server later dies outright.
 */
export interface TransportNudgeArmed {
  timeout: boolean;
  dropped: boolean;
}

export const ALL_NUDGES_ARMED: TransportNudgeArmed = { timeout: true, dropped: true };

export interface TransportNudgeDecision {
  /** What to show for this result, or null when there's nothing useful to say. */
  nudge: string | null;
  armed: TransportNudgeArmed;
}

// Decide what to surface for one galaxy tool result. Fire once per outage per
// kind, then disarm that kind so a retry loop doesn't spam it; re-arm after any
// healthy galaxy result so a later outage nudges again. Classifying in here
// rather than again at the call site keeps one source of truth for which
// failure is which.
export function transportNudgeDecision(
  armed: TransportNudgeArmed,
  toolName: string | undefined,
  text: string | undefined,
): TransportNudgeDecision {
  const kind = classifyGalaxyFailure(toolName, text);
  if (kind) {
    return {
      nudge: armed[kind] ? galaxyFailureNudge(kind) : null,
      armed: { ...armed, [kind]: false },
    };
  }
  if (isGalaxyMcpTool(toolName)) {
    // A galaxy result that isn't a transport error means the pipe is alive.
    return { nudge: null, armed: { ...ALL_NUDGES_ARMED } };
  }
  return { nudge: null, armed };
}
