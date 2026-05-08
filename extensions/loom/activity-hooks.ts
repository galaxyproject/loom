/**
 * Activity hooks — stream user prompts and tool calls into activity.jsonl.
 *
 * Mirrors the conversation into the session's append-only activity log so the
 * Activity pane reflects every non-trivial interaction, not just plan
 * mutations. Guarded on `getNotebookPath()` so nothing writes before
 * `initSessionArtifacts()` has set up the session dir.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "path";
import { getNotebookPath } from "./state";
import { appendActivityEvent } from "./activity";

// Read-only / filesystem-traversal tools clutter the log without telling the
// user anything they'd want to re-read later. Omit them.
const NOISY_TOOLS = new Set(["read", "grep", "glob", "ls", "find"]);

// Tools whose argument shape is known to carry credentials. activity.jsonl
// lives in the project cwd and users may share the dir (commit it, send it
// over for help) — never persist secrets there.
const CREDENTIAL_TOOLS = new Set(["galaxy_connect", "galaxy_set_profile"]);

// Argument keys that universally indicate secrets, redacted on every tool.
const CREDENTIAL_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "password",
  "secret",
  "credentials",
]);

const REDACTED = "[redacted]";

/**
 * Walk an args object and replace any credential-looking values with a
 * placeholder. Mutates a deep clone so the live event still has the
 * original shape (the upstream tool runner needs it).
 */
export function redactArgs(toolName: string, args: unknown): unknown {
  if (CREDENTIAL_TOOLS.has(toolName)) {
    // Whole-object redact — opt-in for tools that exist solely to take a
    // credential. Only the tool name survives in the activity log.
    return { _redacted: true };
  }
  if (args === null || typeof args !== "object") return args;
  if (Array.isArray(args)) return args.map((v) => redactArgs(toolName, v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redactArgs(toolName, v);
    }
  }
  return out;
}

const RESULT_SUMMARY_MAX = 500;

function sessionDir(): string | null {
  const nb = getNotebookPath();
  return nb ? path.dirname(nb) : null;
}

function summarizeResult(result: unknown): string {
  if (result == null) return "";
  const str = typeof result === "string" ? result : JSON.stringify(result);
  if (str.length <= RESULT_SUMMARY_MAX) return str;
  return (
    str.slice(0, RESULT_SUMMARY_MAX) + `… [truncated ${str.length - RESULT_SUMMARY_MAX} chars]`
  );
}

export function registerActivityHooks(pi: ExtensionAPI): void {
  pi.on("input", async (event) => {
    const dir = sessionDir();
    if (!dir) return;
    appendActivityEvent(dir, {
      timestamp: new Date().toISOString(),
      kind: "user.prompt",
      source: event.source,
      payload: { text: event.text },
    });
    return { action: "continue" };
  });

  pi.on("tool_execution_start", async (event) => {
    if (NOISY_TOOLS.has(event.toolName)) return;
    const dir = sessionDir();
    if (!dir) return;
    appendActivityEvent(dir, {
      timestamp: new Date().toISOString(),
      kind: "tool.start",
      source: "agent",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: redactArgs(event.toolName, event.args),
      },
    });
  });

  pi.on("tool_execution_end", async (event) => {
    if (NOISY_TOOLS.has(event.toolName)) return;
    const dir = sessionDir();
    if (!dir) return;
    appendActivityEvent(dir, {
      timestamp: new Date().toISOString(),
      kind: "tool.end",
      source: "agent",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        resultSummary: summarizeResult(event.result),
      },
    });
  });
}
