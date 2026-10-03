/** User-visible heartbeats from observed events; never invoke the model. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { galaxyCall } from "./mcp-recovery";

export const PROGRESS_INTERVAL_MS = 60_000;

function describeTool(name: string, input: Record<string, unknown>): string {
  // Loom's own galaxy_* tools (upload, job/invocation records) count as Galaxy work too.
  const galaxy = galaxyCall(name, input)?.name ?? (name.startsWith("galaxy_") ? name : undefined);
  if (galaxy) {
    if (/get_(dataset|job|history|invocation)/.test(galaxy))
      return "checking Galaxy data and job status";
    if (/search_|get_tool/.test(galaxy)) return "inspecting available Galaxy tools";
    if (/run_|invoke_/.test(galaxy)) return "submitting work to Galaxy";
    if (/upload_/.test(galaxy)) return "uploading analysis inputs to Galaxy";
    return "working with Galaxy";
  }
  if (name === "bash") return "executing a local command";
  if (/^(read|grep|glob|ls|find)$/.test(name)) return "examining project files";
  if (/^(write|edit)$/.test(name)) return "updating project files";
  if (name === "mcp_read_output") return "inspecting saved tool output";
  return "executing an analysis tool";
}

export function registerProgressUpdates(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let lastVisibleAt = 0;
  let completed = 0;
  let errors = 0;
  const active = new Map<string, string>();

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx = undefined;
    active.clear();
  };
  const notify = (text: string) => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, "info");
    } catch {
      stop(); // A stale session must not emit into a replacement conversation.
    }
    lastVisibleAt = Date.now();
  };
  pi.on("agent_start", (_event, context) => {
    stop();
    ctx = context;
    startedAt = lastVisibleAt = Date.now();
    completed = errors = 0;
    timer = setInterval(() => {
      if (Date.now() - lastVisibleAt < PROGRESS_INTERVAL_MS) return;
      const minutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60_000));
      const current = active.values().next().value;
      const state = current
        ? `Currently ${current}.`
        : "Waiting for the assistant's next response.";
      notify(
        `Progress (${minutes} min): ${state} ${completed} tool call${completed === 1 ? " has" : "s have"} returned${errors ? `, including ${errors} error${errors === 1 ? "" : "s"}` : ""}. Analysis results still require verification.`,
      );
    }, PROGRESS_INTERVAL_MS);
    timer.unref?.();
  });
  pi.on("tool_execution_start", (event) => {
    if (!timer) return;
    const description = describeTool(event.toolName, event.args);
    if (!active.size && completed === 0) notify(`Progress: ${description}.`);
    active.set(event.toolCallId, description);
  });
  pi.on("tool_execution_end", (event) => {
    if (!timer) return;
    active.delete(event.toolCallId);
    completed++;
    if (event.isError) errors++;
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (
      message.role === "assistant" &&
      message.content.some((c) => c.type === "text" && c.text.trim())
    )
      lastVisibleAt = Date.now();
  });
  pi.on("agent_end", stop);
  pi.on("session_start", stop);
  pi.on("session_shutdown", stop);
}
