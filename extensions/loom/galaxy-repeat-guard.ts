/**
 * Refuse a Galaxy MCP call the model has already sent, unchanged, three times
 * and seen fail each time. Resending it cannot succeed, and each retry spends
 * a turn. Ported from the browser shell's repeated-failure guard, refusal text
 * and all.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isGalaxyMcpTool } from "../../shared/galaxy-mcp-tools.js";
import { stable } from "../../shared/sra-import.js";

const FAILED_REPEAT_LIMIT = 3;

const key = (name: string, args: unknown) => `${name} ${stable(args)}`;

export function registerGalaxyRepeatGuard(pi: ExtensionAPI): void {
  const failures = new Map<string, number>();
  // A call's key as it was checked, so its result is counted against the
  // arguments that ran even if a later handler rewrites the input.
  const checked = new Map<string, string>();
  const reset = () => {
    failures.clear();
    checked.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.on("tool_call", (event) => {
    if (!isGalaxyMcpTool(event.toolName)) return;
    const k = key(event.toolName, event.input);
    const count = failures.get(k) ?? 0;
    if (count >= FAILED_REPEAT_LIMIT) {
      // One refusal per streak: a changed situation (a fixed history, a new
      // dataset) may make the same call good again.
      failures.delete(k);
      return {
        block: true,
        reason:
          `Refused: '${event.toolName}' was already called with these exact arguments ${count} times and failed each time. ` +
          "Change the arguments or the approach; resending the same call cannot succeed.",
      };
    }
    checked.set(event.toolCallId, k);
  });

  // A blocked call never reaches tool_result, so only calls that ran count.
  pi.on("tool_result", (event, ctx) => {
    const k = checked.get(event.toolCallId);
    if (k === undefined) return;
    checked.delete(event.toolCallId);
    // A user Stop rejects the call with isError set, but the call didn't fail.
    if (ctx?.signal?.aborted) return;
    if (event.isError) failures.set(k, (failures.get(k) ?? 0) + 1);
  });
}
