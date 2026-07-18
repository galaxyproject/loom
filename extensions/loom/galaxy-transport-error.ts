// Mid-session, the MCP client SDK can lose its stdio transport to the
// galaxy-mcp subprocess. After that every galaxy_* call comes back as
// "Failed to call tool: <transport error>", and the adapter never self-heals
// because it still thinks the connection is up. The fix on the user's side is
// to reconnect the MCP server (/mcp reconnect galaxy), not to re-authenticate
// Galaxy -- so we detect that specific failure and surface an actionable hint.
//
// Crucially this must NOT match galaxy-mcp's own "Not connected to Galaxy.
// Authenticate via OAuth or run connect()..." error, which is an auth problem
// that /mcp reconnect won't fix.

const TRANSPORT_ERROR_PATTERNS: RegExp[] = [
  /not connected(?!\s+to\s+galaxy)/i, // bare SDK "Not connected"; exclude the verbose auth error
  /connection closed/i, // -32000
  /-32000/,
  /request timed out/i, // -32001
  /-32001/,
];

export const GALAXY_RECONNECT_NUDGE =
  "Galaxy MCP connection dropped mid-session. Run /mcp reconnect galaxy to restore it (no restart needed).";

export function isGalaxyTransportError(
  toolName: string | undefined,
  text: string | undefined,
): boolean {
  if (!toolName || !toolName.startsWith("galaxy_")) return false;
  if (!text) return false;
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export interface TransportNudgeDecision {
  showNudge: boolean;
  armed: boolean;
}

// Decide whether to surface the reconnect nudge for one galaxy tool result,
// given whether we're currently "armed". Fire once per outage, then disarm so a
// retry loop doesn't spam; re-arm after any healthy galaxy result so a later
// outage nudges again.
export function transportNudgeDecision(
  armed: boolean,
  toolName: string | undefined,
  text: string | undefined,
): TransportNudgeDecision {
  if (isGalaxyTransportError(toolName, text)) {
    return { showNudge: armed, armed: false };
  }
  if (toolName?.startsWith("galaxy_")) {
    // A galaxy result that isn't a transport error means the pipe is alive.
    return { showNudge: false, armed: true };
  }
  return { showNudge: false, armed };
}
