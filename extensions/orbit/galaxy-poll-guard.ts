/** Keep a model from spending a turn repeatedly reading an unfinished dataset. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INVOCATION_SCHEDULING_DONE } from "./galaxy-api";
import { galaxyOutputStore } from "./galaxy-output-store";
import { galaxyCall } from "./galaxy-recovery";
import type { GalaxyToolFamily } from "../../shared/galaxy-tool-family.js";
import { capabilityProfile } from "../../shared/capability-profile.js";

// How long a repeated model-facing status read waits. This throttles token
// spend, not Galaxy load; the background poller runs on its own 15s timer.
export const GALAXY_POLL_INTERVAL_MS = 120_000;
const PENDING = new Set(["new", "upload", "queued", "running", "waiting", "setting_metadata"]);
const MARKER = "[Orbit background monitoring]";

/**
 * The browser worker refuses a repeated read outright instead of waiting it out: a wait there
 * would be a sleep in the brain, and its monitor runs on the worker's own durable clock.
 */
function underWorker(): boolean {
  return capabilityProfile().ui === "worker";
}

const WORKER_REFUSAL =
  "Not checked again: Galaxy is still working on this, and Orbit is already watching it in the background and will report back when it finishes. No Galaxy request was sent. Give the user a short progress update, continue other ready work, or end this turn if waiting is all that remains.";

const monitorCadence = () =>
  underWorker()
    ? "the background monitor checks it"
    : "the background monitor checks it every 15 seconds";

export const galaxyPollGuidance = (family: GalaxyToolFamily): string => {
  const worker = underWorker();
  return `### Waiting for Galaxy and reporting progress

Give a short progress update before starting a long sequence of tools, at each
meaningful milestone, and about once a minute while actively working. Explain
what you verified, what is running, and what comes next. Do not claim scientific
success from a successful tool response alone.

Orbit records every Galaxy submission itself, so a queued/running run is already
being watched: ${worker ? "the background monitor checks it" : "the background monitor checks every 15 seconds"} without model
calls and queues completion verification. Bind the run to its plan step with
galaxy_job_record or galaxy_invocation_record and a real notebook anchor; don't
record a job that belongs to a workflow invocation that is already recorded. If no other authorized work is ready, report the wait
and end the turn so the researcher can talk to you. Do not repeatedly call
${family.tool("get_dataset_details")}, launch a shell polling loop, or use sleep to wait.
A successful metadata request does not mean the dataset has finished.
${worker ? "A repeated status read of an unfinished resource soon after the last one is refused; the monitor reports when it finishes." : "Repeated status reads of an unfinished resource have a two-minute cooldown."}
`;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The envelopes a result carries. An in-process result over the spill size shows the model a prose
 * preview, so its envelope is read from structuredContent, or from the saved output when a handler
 * that rewrote the content made pi drop structuredContent. Only the in-process wrapper sets
 * `details.galaxy`; everything else is read from its text as it always was.
 */
function envelopes(event: {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
  structuredContent?: unknown;
}): Record<string, unknown>[] {
  const galaxy = object(object(event.details)?.galaxy);
  if (galaxy) {
    const structured = object(event.structuredContent);
    if (structured && "success" in structured) return [structured];
    const saved =
      typeof galaxy.outputId === "string" ? galaxyOutputStore().get(galaxy.outputId) : undefined;
    const envelope = saved === undefined ? undefined : parsed(saved);
    if (envelope) return [envelope];
  }
  return event.content.flatMap((item) => {
    const result =
      item.type === "text" && typeof item.text === "string" ? parsed(item.text) : undefined;
    return result ? [result] : [];
  });
}

const INVOCATION = "invocation:";

function resource(
  name: string,
  args: Record<string, unknown>,
  family: GalaxyToolFamily,
): string | undefined {
  const tool = family.toolName(name);
  if (tool === "get_invocations") {
    return typeof args.invocation_id === "string"
      ? `${INVOCATION}${args.invocation_id}`
      : undefined;
  }
  if (tool !== "get_dataset_details" && tool !== "get_job_details") return;
  if (typeof args.dataset_id === "string") return `dataset:${args.dataset_id}`;
  if (tool === "get_job_details" && typeof args.job_id === "string") return `job:${args.job_id}`;
}

function waitForCheck(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new Error("Status wait interrupted."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export function registerGalaxyPollGuard(pi: ExtensionAPI, family: GalaxyToolFamily): void {
  const pending = new Map<string, { checkedAt: number; jobId?: string }>();
  let generation = 0;
  let sessionAbort = new AbortController();
  const reset = () => {
    generation++;
    sessionAbort.abort();
    sessionAbort = new AbortController();
    pending.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  // A user's explicit status question may request one fresh check immediately.
  pi.on("input", (event) => {
    if (event.source !== "extension") reset();
  });

  pi.on("tool_call", async (event, ctx) => {
    const call = galaxyCall(event.toolName, event.input, family);
    const key = call && resource(call.name, call.args, family);
    if (!key) return;
    const observation = pending.get(key);
    if (!observation) return;
    const remaining = GALAXY_POLL_INTERVAL_MS - (Date.now() - observation.checkedAt);
    if (remaining <= 0) return;
    if (underWorker()) return { block: true, reason: WORKER_REFUSAL };
    const currentGeneration = generation;
    // Await in the extension, not in the model loop: neither another provider
    // request nor a Galaxy GET occurs during the cooldown. Stop remains usable.
    try {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Galaxy is still working. The next repeated status check is delayed by ${Math.ceil(remaining / 1000)} seconds to avoid spending tokens on polling.`,
          "info",
        );
    } catch {
      // Notification failure must not remove the polling limit.
    }
    try {
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, sessionAbort.signal])
        : sessionAbort.signal;
      await waitForCheck(remaining, signal);
    } catch {
      return { block: true, reason: "Status wait interrupted; no Galaxy request was sent." };
    }
    if (generation !== currentGeneration || ctx.signal?.aborted)
      return { block: true, reason: "Status wait interrupted; no Galaxy request was sent." };
  });

  pi.on("tool_result", (event) => {
    const call = galaxyCall(event.toolName, event.input, family);
    const key = call && resource(call.name, call.args, family);
    if (!key || event.isError || object(event.details)?.error) return;
    for (const result of envelopes(event)) {
      if (result.success === false) continue;
      const data = object(result.data) ?? result;
      const invocation = key.startsWith(INVOCATION);
      const details = invocation ? data : (object(data.dataset) ?? object(data.job) ?? data);
      const state = details.state;
      if (typeof state !== "string") continue;
      // An invocation is unfinished until Galaxy stops scheduling its steps; `ready` and `new`
      // are not dataset states, so PENDING would never hold one back.
      if (invocation ? INVOCATION_SCHEDULING_DONE.has(state) : !PENDING.has(state)) {
        pending.delete(key);
        return;
      }
      const jobId = typeof details.creating_job === "string" ? details.creating_job : undefined;
      pending.set(key, { checkedAt: Date.now(), jobId });
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `${MARKER}\nThe metadata request succeeded, but this resource is still ${state}. ${jobId ? `Its creating job ID is ${JSON.stringify(jobId)}. ` : "Use the job/invocation ID from the submission response. "}Orbit already recorded that run when it was submitted and ${monitorCadence()} without model calls; if it isn't bound to a plan step yet, bind it with galaxy_job_record or galaxy_invocation_record using an existing notebook anchor (skip a job that belongs to an invocation already recorded). Give the user a short progress update, continue other ready work, or end this turn if waiting is all that remains. Do not repeat metadata calls or sleep in a loop. Verify the outputs when completion wakes you. If automatic follow-up is disabled, disclose that instead of promising a wake-up.`,
          },
        ],
      };
    }
  });
}
