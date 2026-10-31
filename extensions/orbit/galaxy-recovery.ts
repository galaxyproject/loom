/** Agent-facing recovery for failed Galaxy calls. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { galaxyFailureKind, type GalaxyFailureKind } from "./galaxy-failure";
import type { GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";

type Args = Record<string, unknown>;
export function galaxyCall(
  name: string,
  input: Args,
  family: GalaxyToolFamily,
): { name: string; args: Args } | undefined {
  if (family.toolName(name) === undefined) return;
  return { name, args: input };
}

// The saved-output reader, galaxy_read_output, is a companion that a shell's own tool source need
// not register, so the wording leaves the saved-response advice out.
const discoveryHint = (family: GalaxyToolFamily) =>
  `Use ${family.tool("search_tools_by_name")} with a specific name, ID, or description term (one term per call), then inspect schemas only for matching candidates. If a full catalog is needed, fetch ${family.tool("get_tool_panel")} once. Name searches do not establish absence of tools matching only an input datatype; inspect candidate input schemas when that distinction matters.`;
const MARKER = "[loom Galaxy recovery]";
// Calls that never change Galaxy state, so a timeout can't leave an accepted
// operation behind.
const READ_ONLY = /^(get_|list_|search_|download_)/;
const isReadOnly = (name: string, family: GalaxyToolFamily) =>
  READ_ONLY.test(family.toolName(name) ?? "");
/** The prompt's recovery section, naming the family's discovery tool. */
export function galaxyRecoveryGuidance(family: GalaxyToolFamily): string {
  return `### Slow Galaxy requests

For installed-tool discovery, prefer ${family.tool("search_tools_by_name")}: it matches
names, IDs and descriptions. Avoid search_tools_by_keywords: its implementation
fetches input schemas for potentially thousands of tools even for a narrow
keyword. Fetch schemas only for candidate tools.

A timeout is an unknown result, not proof that a job failed. Narrow/paginate
read-only requests before retrying.
For a timed-out mutation (run, invoke, create, upload, update, delete, etc.),
inspect the destination history, jobs/invocations or affected resource first.
Reuse an accepted operation; retry only when non-acceptance or safe retry is
established. Never blindly replay a mutation, invent its ID, or infer success.
Limit recovery to one narrowed retry per incident. If it fails, report the
concrete blocker and preserve work instead of looping.
`;
}

const GALAXY_AUTH_HINT =
  "Galaxy refused the request's credentials, or none are configured. Ask the user to run /connect; do not retry until they have.";

const SERVICE_OUTAGE_HINT =
  "The Galaxy server or sign-in service is down. Don't investigate or retry; the session resumes when it's back.";

const MUTATION_OUTCOME =
  "This operation may already have been accepted by Galaxy. Its result is UNKNOWN. Inspect the destination history, jobs/invocations or affected resource before considering any retry. Reuse accepted work, and if you find the accepted job or invocation, record it with galaxy_job_record or galaxy_invocation_record -- Orbit cannot capture a submission whose call failed. Do not blindly repeat a submission, upload, create, update or delete; do not invent IDs or claim success.";

// galaxy-ops reports any HTTP status but 401/403/404 as a connection failure, so a "dropped"
// call is often a rejected argument (a 400 or 422): the advice sends the model to the message. A
// 502/504 is "connection" too and the request may have run, so nothing claims no reply arrived.
export function galaxyRecoveryHint(
  name: string,
  kind: Exclude<GalaxyFailureKind, null>,
  family: GalaxyToolFamily,
): string {
  // Galaxy refused the request outright, so nothing was accepted and no retry can help until the
  // credentials change.
  if (kind === "auth") {
    return `${MARKER}\n${GALAXY_AUTH_HINT}\nRespect Stop/pause.`;
  }
  // Nothing the model does can bring the service back, so there is no recovery to attempt.
  if (kind === "service_outage") {
    return `${MARKER}\n${SERVICE_OUTAGE_HINT}\nRespect Stop/pause.`;
  }
  const tool = family.toolName(name);
  const readOnly = isReadOnly(name, family);
  const outcome = readOnly ? "This was a read-only lookup." : MUTATION_OUTCOME;
  const action =
    kind === "timeout"
      ? "Narrow or paginate the request before one read-only retry; do not repeat the same expensive call. A lookup with nothing to narrow can be repeated once, after another Galaxy request has succeeded."
      : readOnly
        ? "Galaxy did not complete the request. Retrying the identical call once is safe; if it fails the same way, read the error -- a rejected argument needs different input, otherwise report Galaxy as unreachable."
        : "Before any retry, check once with a cheap read of the destination history, jobs or invocations.";
  // Name search and a single panel fetch are the way around a slow catalog, not a failed one.
  const discovery =
    kind === "timeout" && (name.includes("search_tools") || tool === "get_tool_panel")
      ? discoveryHint(family)
      : "";
  const closing =
    kind === "timeout"
      ? "After one narrowed retry fails, report a concrete blocker rather than looping."
      : "After one retry fails, report a concrete blocker rather than looping.";
  return `${MARKER}\n${action}\n${outcome}\n${discovery}\nDo the recovery now without another permission question. ${closing} Respect Stop/pause.`;
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

export function registerGalaxyRecovery(pi: ExtensionAPI, family: GalaxyToolFamily): void {
  const timedOutReads = new Set<string>();
  const retried = new Set<string>();
  const retryPermits = new Set<string>();
  let transportFailed = false;
  const reset = () => {
    timedOutReads.clear();
    retried.clear();
    retryPermits.clear();
    transportFailed = false;
  };
  // A user's next message starts a new incident; an extension's follow-up (a poller auto-resume)
  // does not, or it would re-arm the reads this incident already spent.
  pi.on("input", (event) => {
    if (event?.source !== "extension") reset();
  });
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("tool_call", (event) => {
    const call = galaxyCall(event.toolName, event.input, family);
    if (!call) return;
    if (family.toolName(call.name) === "search_tools_by_keywords") {
      return {
        block: true,
        reason: `This Galaxy search expands into input-schema requests for the entire installed tool catalog, one request per tool, and can run for minutes. ${discoveryHint(family)} Continue discovery now; no user approval is needed.`,
      };
    }
    const key = call.name + stable(call.args);
    if (retryPermits.delete(key)) {
      retried.add(key);
      return;
    }
    if (timedOutReads.has(key)) {
      return {
        block: true,
        reason: `This identical read-only request already timed out. ${galaxyRecoveryHint(call.name, "timeout", family)}`,
      };
    }
  });
  pi.on("tool_result", (event) => {
    const details = event.details as { error?: unknown } | undefined;
    const call = galaxyCall(event.toolName, event.input, family);
    if (!call) return;
    if (!event.isError && !details?.error) {
      // Galaxy answering some other call is the sign it is back: each timed-out read gets one
      // more try.
      if (transportFailed) {
        const key = call.name + stable(call.args);
        for (const read of timedOutReads)
          if (read !== key && !retried.has(read)) retryPermits.add(read);
      }
      if (isReadOnly(call.name, family)) {
        // A verified read ends this incident. Future polling of the same
        // dataset/history must remain possible after a successful retry.
        const key = call.name + stable(call.args);
        timedOutReads.delete(key);
        retryPermits.delete(key);
        retried.delete(key);
        transportFailed = false;
      }
      return;
    }
    const text = event.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.includes(MARKER)) return;
    const kind = galaxyFailureKind(event.details, text, call.name, family);
    if (!kind) return;
    // A refused credential or a service outage is not a transport incident: no narrowed retry
    // follows either.
    if (kind !== "auth" && kind !== "service_outage") transportFailed = true;
    if (kind === "timeout" && isReadOnly(call.name, family))
      timedOutReads.add(call.name + stable(call.args));
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: galaxyRecoveryHint(call.name, kind, family) },
      ],
    };
  });
}
