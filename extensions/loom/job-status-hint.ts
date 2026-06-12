/**
 * Post-run job-status hint (#210).
 *
 * `galaxy_run_tool` / `galaxy_run_user_tool` return at job SUBMISSION -- the
 * "Started tool …" / HTTP 200 response means the job was queued, not that it
 * finished. A model (especially a low-capability one) reads that as success and
 * moves on, so a job that errors in Galaxy is never surfaced in chat until the
 * user explicitly asks. Unlike workflow invocations, single tool runs leave no
 * `loom-invocation` block, so the background poller never advances them either.
 *
 * Mirrors `confusables-hint.ts`: hook the tool-result message and append a
 * reminder that submission != success, so the agent verifies the job's terminal
 * state and reports failures in the same turn. This is a deterministic nudge --
 * it does not itself call Galaxy or resolve the job; it just keeps the model
 * from mistaking a 200 for a completed run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Galaxy MCP tools that return a SUBMITTED job rather than a finished run.
// Workflow invocations (galaxy_invoke_workflow) are deliberately excluded --
// they get their own loom-invocation block + background poller.
const JOB_RUN_TOOLS = new Set(["galaxy_run_tool", "galaxy_run_user_tool"]);

export const JOB_SUBMITTED_HINT =
  "[loom] This started a Galaxy job — it is submitted, not finished. A 200 / " +
  '"Started tool …" response only means the job was submitted. Before telling ' +
  "the user this step succeeded, confirm the job reached a terminal `ok` state. " +
  "Call `galaxy_get_job_details` with one of the run's output dataset ids (it " +
  "returns the job that produced that dataset, with its state), or check the " +
  "output dataset's state directly. If it ended in `error`/`failed`/`deleted`, " +
  "report the failure to the user now instead of waiting to be asked.";

// Distinctive opening of the hint, reused as the idempotency guard -- guaranteed
// present once appended, and unique enough that no Galaxy tool result contains it.
const HINT_MARKER = "[loom] This started a Galaxy job";

/** A submitted-job result worth nudging: a successful run_tool / run_user_tool. */
export function shouldHintJobRun(
  toolName: string | undefined,
  isError: boolean | undefined,
): boolean {
  if (isError) return false;
  return Boolean(toolName && JOB_RUN_TOOLS.has(toolName));
}

/**
 * Append the job-status hint to a tool-result's content. Returns a changed copy,
 * or `null` if the hint is already present (idempotent). The original array is
 * never mutated. Appends to the first text block, or adds a new text item when
 * the result carries none.
 */
export function appendJobHint<T extends { type: string; text?: string }>(content: T[]): T[] | null {
  const alreadyHinted = content.some(
    (c) => c.type === "text" && typeof c.text === "string" && c.text.includes(HINT_MARKER),
  );
  if (alreadyHinted) return null;

  const firstText = content.findIndex((c) => c.type === "text" && typeof c.text === "string");
  if (firstText === -1) {
    return [...content, { type: "text", text: JOB_SUBMITTED_HINT } as T];
  }
  return content.map((c, i) =>
    i === firstText ? { ...c, text: `${c.text}\n\n${JOB_SUBMITTED_HINT}` } : c,
  );
}

export function registerJobStatusHint(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "toolResult") return;
    if (!shouldHintJobRun(msg.toolName, msg.isError)) return;

    const content = appendJobHint(msg.content);
    if (content) return { message: { ...msg, content } };
  });
}
