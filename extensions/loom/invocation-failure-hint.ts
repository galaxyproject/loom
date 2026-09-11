/**
 * Failed-invocation triage hint.
 *
 * The background poller already toasts the user when an invocation transitions
 * to `failed` ("ask me to investigate"), but that toast is shell-side -- the
 * agent never sees it. The agent-facing moment is the tool result from
 * `galaxy_invocation_check_all` / `_check_one`, which carries `autoAction:
 * "failed"` for anything that just transitioned. Hook it the same way
 * `confusables-hint.ts` does and append a triage nudge.
 *
 * Shape follows the lesson from #210/#249: a deterministic nudge cannot depend
 * on a pull for the part that makes it actionable. So the *imperative* is
 * inline and complete -- report it now, read invocation messages and job detail
 * separately, don't infer the cause from job counts. Only the interpretation
 * *depth* is a pull: the reason-code table and the API-surface map are
 * reference material that can't be inlined into a hint, and they are bundled
 * with Loom rather than fetched, so the pointer resolves offline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VENDOR_REPO_NAME } from "./vendor-skills";

const INVOCATION_CHECK_TOOLS = new Set([
  "galaxy_invocation_check_all",
  "galaxy_invocation_check_one",
]);

export const INVOCATION_FAILURE_REFERENCE = "galaxy-workflow-invocation-failure-reference.md";
export const JOB_FAILURE_REFERENCE = "galaxy-tool-job-failure-reference.md";

// Distinctive opening, reused as the idempotency guard -- guaranteed present
// once appended and unique enough that no Galaxy tool result contains it.
const HINT_MARKER = "[loom] A Galaxy workflow invocation just failed";

export const INVOCATION_FAILED_HINT =
  `${HINT_MARKER} — report it to the user now rather than waiting to be asked, ` +
  "and establish the cause before proposing a fix. Invocation state and job state " +
  "are different questions: the invocation says whether Galaxy could schedule and " +
  "drive the workflow, the jobs say whether the tools succeeded. Job error counts " +
  "alone do not identify the failure — read the invocation's structured messages " +
  "and the failing job's detail. Do not mark the plan step complete, and do not " +
  "guess a repair from the summary above.\n" +
  `For what the invocation message reasons and states mean: ` +
  `\`skills_fetch({ repo: "${VENDOR_REPO_NAME}", path: "${INVOCATION_FAILURE_REFERENCE}" })\`. ` +
  `For job-level evidence (exit codes, job_messages, tool vs job streams): ` +
  `\`skills_fetch({ repo: "${VENDOR_REPO_NAME}", path: "${JOB_FAILURE_REFERENCE}" })\`.`;

/** True when a check-invocations result reports at least one fresh `failed` transition. */
export function hasFailedTransition(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the JSON summary (an error string, a truncated result) — stay quiet
    // rather than regex-matching "failed" out of arbitrary prose.
    return false;
  }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return false;
  return results.some((r) => (r as { autoAction?: unknown })?.autoAction === "failed");
}

/**
 * Append the triage hint to a tool-result's content. Returns a changed copy, or
 * `null` if there is nothing to add (already hinted, or no failed transition).
 * The original array is never mutated.
 */
export function appendInvocationFailureHint<T extends { type: string; text?: string }>(
  content: T[],
): T[] | null {
  const alreadyHinted = content.some(
    (c) => c.type === "text" && typeof c.text === "string" && c.text.includes(HINT_MARKER),
  );
  if (alreadyHinted) return null;

  const idx = content.findIndex(
    (c) => c.type === "text" && typeof c.text === "string" && hasFailedTransition(c.text),
  );
  if (idx === -1) return null;

  const target = content[idx];
  const next = content.slice();
  next[idx] = { ...target, text: `${target.text}\n\n${INVOCATION_FAILED_HINT}` };
  return next;
}

export function registerInvocationFailureHint(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "toolResult" || msg.isError) return;
    if (!msg.toolName || !INVOCATION_CHECK_TOOLS.has(msg.toolName)) return;

    const updated = appendInvocationFailureHint(msg.content);
    if (!updated) return;

    return { message: { ...msg, content: updated } };
  });
}
