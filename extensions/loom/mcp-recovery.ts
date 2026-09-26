/** Agent-facing recovery, alongside the short human-facing transport notice. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyGalaxyFailure, type GalaxyFailureKind } from "./galaxy-transport-error";

type Args = Record<string, unknown>;
export function galaxyCall(name: string, input: Args): { name: string; args: Args } | undefined {
  if (name === "mcp") {
    if (input.server !== undefined && input.server !== "galaxy") return;
    name = typeof input.tool === "string" ? input.tool : "";
    if (input.server !== "galaxy" && !/^(galaxy_|mcp__galaxy__)/.test(name)) return;
    try {
      const args = typeof input.args === "string" ? JSON.parse(input.args) : (input.args ?? {});
      if (!args || typeof args !== "object" || Array.isArray(args)) return;
      return { name: `galaxy_${name.replace(/^(?:galaxy_|mcp__galaxy__)/, "")}`, args };
    } catch {
      return;
    }
  }
  if (!/^(galaxy_|mcp__galaxy__)/.test(name)) return;
  return { name: name.replace(/^mcp__galaxy__/, "galaxy_"), args: input };
}

const DISCOVERY_HINT =
  "Use galaxy_search_tools_by_name with a specific name, ID, or description term (one term per call), then inspect schemas only for matching candidates. If a full catalog is needed, fetch galaxy_get_tool_panel once and search its saved response with mcp_read_output. Name searches do not establish absence of tools matching only an input datatype; inspect candidate input schemas when that distinction matters.";
const MARKER = "[loom Galaxy MCP recovery]";
// Calls that never change Galaxy state, so a timeout can't leave an accepted
// operation behind.
const READ_ONLY = /^galaxy_(get_|list_|search_|download_)/;
export const MCP_RECOVERY_GUIDANCE = `### Oversized MCP output and slow Galaxy requests

Loom automatically previews oversized MCP results and provides mcp_read_output
for searching and paging their saved contents. Use its outputId (or the saved
path from an older truncation notice) and JSON Pointers to inspect relevant
records, including exact IDs, without a shell.
A partial preview is not proof that omitted records are absent. Never repeat
a submission merely because its response was truncated. Continue the user's
authorized work without asking them to inspect temporary files.
An oversized user-defined tool list is summarized automatically with names,
versions, IDs and containers. Search this saved catalog with mcp_read_output
query or page it with nextOffset; inspect only a selected definitionPointer.
The compact catalog is a successful read, not a timeout or model context failure.

For installed-tool discovery, prefer galaxy_search_tools_by_name: it matches
names, IDs and descriptions. Avoid search_tools_by_keywords: its implementation
fetches input schemas for potentially thousands of tools even for a narrow
keyword. Fetch schemas only for candidate tools. Search a saved tool catalog
locally with mcp_read_output rather than repeatedly fetching the entire panel.

A timeout is an unknown result, not proof that a job failed. Narrow/paginate
read-only requests before retrying. For a dropped transport or persistent
timeouts on small requests, call mcp({connect: "galaxy"}) yourself once to
reconnect the adapter, then galaxy_connect() to bind the Galaxy session.
Check that recovery succeeded before continuing. Do not tell the user to type
/mcp reconnect galaxy or restart Orbit as the first recovery step.
For a timed-out mutation (run, invoke, create, upload, update, delete, etc.),
inspect the destination history, jobs/invocations or affected resource first.
Reuse an accepted operation; retry only when non-acceptance or safe retry is
established. Never blindly replay a mutation, invent its ID, or infer success.
Limit recovery to one narrowed retry and one reconnect per incident. If those
fail, report the concrete blocker and preserve work instead of looping.
`;

export function galaxyRecoveryHint(name: string, kind: Exclude<GalaxyFailureKind, null>): string {
  const outcome =
    name === "galaxy_connect"
      ? "galaxy_connect only binds this session and changes nothing in Galaxy; it is safe to call again after reconnecting."
      : READ_ONLY.test(name)
        ? "This was a read-only lookup. Continue the authorized task using a smaller query or saved response."
        : "This operation may already have been accepted by Galaxy. Its result is UNKNOWN. Inspect the destination history, jobs/invocations or affected resource before considering any retry. Reuse accepted work. Do not blindly repeat a submission, upload, create, update or delete; do not invent IDs or claim success.";
  const action =
    kind === "dropped"
      ? 'Call mcp({"connect":"galaxy"}) yourself once, then galaxy_connect(). Check their results before continuing; do not ask the user to reconnect or restart Orbit.'
      : 'Narrow or paginate the request before one read-only retry; do not repeat the same expensive call. If even a small request times out, call mcp({"connect":"galaxy"}) once, then galaxy_connect(), and check the results.';
  return `${MARKER}\n${action}\n${outcome}\n${name.includes("search_tools") || name === "galaxy_get_tool_panel" ? DISCOVERY_HINT : ""}\nDo the recovery now without another permission question. After one narrowed retry and one reconnect fail, report a concrete blocker rather than looping. Respect Stop/pause.`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function registerMcpRecovery(pi: ExtensionAPI): void {
  const timedOutReads = new Set<string>();
  const retriedAfterReconnect = new Set<string>();
  const retryPermits = new Set<string>();
  let transportFailed = false;
  let reconnectAttempts = 0;
  const reset = () => {
    timedOutReads.clear();
    retriedAfterReconnect.clear();
    retryPermits.clear();
    transportFailed = false;
    reconnectAttempts = 0;
  };
  pi.on("input", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("tool_call", (event) => {
    if (
      event.toolName === "mcp" &&
      !event.input.tool &&
      event.input.connect === "galaxy" &&
      transportFailed
    ) {
      if (reconnectAttempts++ >= 1)
        return {
          block: true,
          reason:
            "Automatic Galaxy reconnect was already attempted for this incident. Inspect its result and report the concrete blocker; do not loop. The user can run /mcp reconnect galaxy (no restart needed).",
        };
    }
    const call = galaxyCall(event.toolName, event.input);
    if (!call) return;
    if (call.name === "galaxy_search_tools_by_keywords") {
      return {
        block: true,
        reason: `This Galaxy search expands into input-schema requests for the entire installed tool catalog and can exceed the five-minute MCP budget. ${DISCOVERY_HINT} Continue discovery now; no user approval is needed.`,
      };
    }
    const key = call.name + stable(call.args);
    if (retryPermits.delete(key)) {
      retriedAfterReconnect.add(key);
      return;
    }
    if (timedOutReads.has(key)) {
      return {
        block: true,
        reason: `This identical read-only request already timed out. ${galaxyRecoveryHint(call.name, "timeout")}`,
      };
    }
  });
  pi.on("tool_result", (event) => {
    const details = event.details as { error?: unknown; mode?: unknown } | undefined;
    if (
      event.toolName === "mcp" &&
      !event.input.tool &&
      event.input.connect === "galaxy" &&
      !event.isError &&
      !details?.error &&
      details?.mode === "list"
    ) {
      for (const key of timedOutReads) if (!retriedAfterReconnect.has(key)) retryPermits.add(key);
      return;
    }
    const call = galaxyCall(event.toolName, event.input);
    if (!call) return;
    if (!event.isError && !details?.error) {
      if (READ_ONLY.test(call.name)) {
        // A verified read ends this incident. Future polling of the same
        // dataset/history must remain possible after a successful retry.
        const key = call.name + stable(call.args);
        timedOutReads.delete(key);
        retryPermits.delete(key);
        retriedAfterReconnect.delete(key);
        transportFailed = false;
        reconnectAttempts = 0;
      }
      return;
    }
    const text = event.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.includes(MARKER)) return;
    const kind = classifyGalaxyFailure(call.name, text);
    if (!kind) return;
    transportFailed = true;
    if (kind === "timeout" && READ_ONLY.test(call.name))
      timedOutReads.add(call.name + stable(call.args));
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: galaxyRecoveryHint(call.name, kind) },
      ],
    };
  });
}
