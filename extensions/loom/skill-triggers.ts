/**
 * Tool-result hints, as one table.
 *
 * A hint appends a short note to a tool result when the result shows a
 * situation the model should handle a particular way -- usually with a
 * `skills_fetch` pointer to the bundled reference that covers it. This is how
 * skills that stay out of the prompt router reach the model: they cost nothing
 * until the situation comes up.
 *
 * Each trigger used to be its own module with its own `message_end` hook. New
 * ones are a row here instead. Every hint that fires is logged as a
 * `skill.hint` activity event, so evals can check it fired and whether the
 * model followed up.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity";
import { findConfusablesMatch } from "./confusables";
import { hasFailedTransition, INVOCATION_FAILED_HINT } from "./invocation-failure-hint";
import { getNotebookPath } from "./state";

export interface HintContext {
  toolName: string;
  /** One text block of the result. A trigger sees each block in order. */
  text: string;
  activeTools: () => string[];
}

export interface SkillTrigger {
  id: string;
  /** Tool names this trigger watches; omit to watch every tool. */
  tools?: ReadonlySet<string>;
  /** Which results to look at. Most hints only make sense on a success. */
  on: "success" | "error";
  /**
   * The hint to append after this text block, or null. The first block that
   * yields a hint gets it; a result that already contains the hint is skipped,
   * so re-delivery never stacks copies.
   */
  hint(ctx: HintContext): string | null;
}

// agent-loop.js wording when dispatch finds no tool by that exact name.
const NOT_FOUND_RE = /^Tool\s+(\S+)\s+not found\b/;

export const IWC_CANDIDATES_HINT =
  "[loom] These are ranked by word overlap, not relevance. Before offering one, call " +
  "`mcp__galaxy__get_iwc_workflow_details` on the plausible candidates and check their inputs " +
  "against the data the user actually has (reads vs count tables, paired vs single-end). " +
  "A workflow that needs another's outputs first is half of a chain, not a match. If none " +
  "fit, say so. If nothing came back, retry once with just the assay; if the query had no " +
  "searchable terms, ask the user what they want to find out.";

export const SKILL_TRIGGERS: readonly SkillTrigger[] = [
  {
    // STOPGAP for #100: the model emitted a Cyrillic/Greek lookalike in a tool
    // name. Only the first text block carries agent-loop's message.
    id: "tool-name-confusables",
    on: "error",
    hint: ({ toolName, text, activeTools }) => {
      if (!NOT_FOUND_RE.test(text)) return null;
      const match = findConfusablesMatch(toolName, activeTools());
      return match
        ? `Did you mean \`${match}\`? The tool name you called contains Unicode confusables (visually similar non-Latin characters).`
        : null;
    },
  },
  {
    // The background poller queues triage for a failed invocation, but a
    // manual check can see the transition first. See invocation-failure-hint.ts.
    id: "invocation-failed",
    tools: new Set(["galaxy_invocation_check_all", "galaxy_invocation_check_one"]),
    on: "success",
    hint: ({ text }) => (hasFailedTransition(text) ? INVOCATION_FAILED_HINT : null),
  },
  {
    // IWC ranking is BM25 with no relevance floor, so an off-topic question
    // still gets confident-looking hits. Fires on the tool name alone: the
    // adapter's output guard can truncate a big result into non-JSON, so the
    // body can't be relied on.
    id: "iwc-candidates",
    tools: new Set(["mcp__galaxy__recommend_iwc_workflows", "mcp__galaxy__search_iwc_workflows"]),
    on: "success",
    hint: () => IWC_CANDIDATES_HINT,
  },
];

type ContentBlock = { type: string; text?: string };

export interface FiredHint {
  id: string;
  hint: string;
}

/**
 * Apply every matching trigger to a tool result. Returns the new content and
 * the hints that fired, or null when nothing changed. Never mutates `content`.
 */
export function applySkillTriggers<T extends ContentBlock>(
  msg: { toolName: string; isError: boolean; content: T[] },
  activeTools: () => string[],
  triggers: readonly SkillTrigger[] = SKILL_TRIGGERS,
): { content: T[]; fired: FiredHint[] } | null {
  let content = msg.content;
  const fired: FiredHint[] = [];
  const kind = msg.isError ? "error" : "success";

  for (const trigger of triggers) {
    if (trigger.on !== kind) continue;
    if (trigger.tools && !trigger.tools.has(msg.toolName)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block.type !== "text" || typeof block.text !== "string") continue;
      const hint = trigger.hint({ toolName: msg.toolName, text: block.text, activeTools });
      if (!hint) continue;
      const already = content.some((c) => typeof c.text === "string" && c.text.includes(hint));
      if (!already) {
        content = content.slice();
        content[i] = { ...block, text: `${block.text}\n\n${hint}` };
        fired.push({ id: trigger.id, hint });
      }
      break;
    }
  }

  return fired.length > 0 ? { content, fired } : null;
}

export function registerSkillTriggers(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "toolResult" || !msg.toolName) return;

    const applied = applySkillTriggers(
      { toolName: msg.toolName, isError: !!msg.isError, content: msg.content },
      () => pi.getActiveTools(),
    );
    if (!applied) return;

    const notebook = getNotebookPath();
    if (notebook) {
      for (const { id } of applied.fired) {
        appendActivityEvent(path.dirname(notebook), {
          timestamp: new Date().toISOString(),
          kind: "skill.hint",
          source: "loom",
          payload: { trigger: id, toolName: msg.toolName, toolCallId: msg.toolCallId },
        });
      }
    }

    return { message: { ...msg, content: applied.content } };
  });
}
