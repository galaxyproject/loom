/**
 * Activity hooks — stream user prompts and tool calls into activity.jsonl.
 *
 * Mirrors the conversation into the session's append-only activity log so the
 * Activity pane reflects every non-trivial interaction, not just plan
 * mutations. Guarded on `getNotebookPath()` so nothing writes before
 * `initSessionArtifacts()` has set up the session dir.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";
import { getNotebookPath } from "./state";
import { appendActivityEvent } from "./activity";
import { currentSecretValues, redactSecrets } from "./secret-redaction";
import { withoutAppendedLessonHints } from "./lessons/pi-event-contract";

// Read-only / filesystem-traversal tools clutter the log without telling the
// user anything they'd want to re-read later. Omit them. lessons_search is
// here for a different reason: its query says what the user is stuck on and
// its result is lesson prose, and the lesson.surfaced row already records
// which lesson surfaced.
const NOISY_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "lessons_search"]);

// Tools whose argument shape is known to carry credentials. activity.jsonl
// lives in the project cwd and users may share the dir (commit it, send it
// over for help) — never persist secrets there.
const CREDENTIAL_TOOLS = new Set(["mcp__galaxy__connect", "galaxy_set_profile"]);

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

// Redact BEFORE truncating so a secret can't survive by being split across the
// truncation boundary. Tool RESULTS (unlike args) carry whatever a command
// printed -- a `cat`-style leak lands here, and this log also feeds /feedback.
export function summarizeResult(result: unknown, secrets: string[] = []): string {
  if (result == null) return "";
  const raw = typeof result === "string" ? result : JSON.stringify(result);
  const str = redactSecrets(raw, secrets);
  if (str.length <= RESULT_SUMMARY_MAX) return str;
  return (
    str.slice(0, RESULT_SUMMARY_MAX) + `… [truncated ${str.length - RESULT_SUMMARY_MAX} chars]`
  );
}

// The end event carries the result after the tool_result hooks, so a lesson
// hint rides along. It is Loom's prose, not the tool's output, and this log
// ships with /feedback; the lesson.surfaced row already says which one fired.
function withoutHintBlocks(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result;
  return { ...(result as object), content: withoutAppendedLessonHints(content) };
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
    const secrets = currentSecretValues({ auth: false });
    appendActivityEvent(dir, {
      timestamp: new Date().toISOString(),
      kind: "tool.end",
      source: "agent",
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        resultSummary: summarizeResult(withoutHintBlocks(event.result), secrets),
      },
    });
  });
}
