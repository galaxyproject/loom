/**
 * Enforce the IWC-first rule for plan drafts.
 *
 * The prompt tells the model to check the IWC registry before drafting a plan,
 * and on a weaker model that holds about half the time: the rest draft from
 * memory, often as a hand-assembled [local] pipeline, when a maintained
 * workflow would have covered it. So when a turn ends with a plan draft and
 * nothing in the session has consulted IWC, send one follow-up asking the
 * model to check and revise. Once per session: if the model checks and still
 * prefers its draft, that's its call.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity";
import { deliverAutoFollowUp } from "./auto-resume";
import { activeGalaxyStatus } from "./profiles";
import { getNotebookPath } from "./state";

const RECOMMEND_TOOL = "mcp__galaxy__recommend_iwc_workflows";

export const IWC_TOOLS: ReadonlySet<string> = new Set([
  RECOMMEND_TOOL,
  "mcp__galaxy__search_iwc_workflows",
  "mcp__galaxy__get_iwc_workflow_details",
  "mcp__galaxy__get_iwc_workflows",
]);

export const IWC_PLAN_NUDGE =
  "[Loom check] That plan was drafted without checking the IWC workflow registry. Call " +
  "`mcp__galaxy__recommend_iwc_workflows` with the analysis goal now. If a workflow (or a short " +
  "chain of them) covers it and fits the user's data, revise the draft to run it on Galaxy; " +
  "if nothing fits, or the user asked for something else, keep the draft and say you " +
  "checked. It is still a draft: don't write it to the notebook or run anything.";

// A ```plan fence or a bare plan heading, the two shapes the plan gate accepts.
const PLAN_DRAFT_RE = /^\s*(?:```plan\b|##\s+Plan\s+[A-Za-z0-9]+\s*[:-])/m;

type Message = { role: string; content?: unknown };

/** Did any assistant message in this run draft a plan? */
export function draftsPlan(messages: readonly Message[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some(
        (c: { type?: string; text?: unknown }) =>
          c?.type === "text" && typeof c.text === "string" && PLAN_DRAFT_RE.test(c.text),
      ),
  );
}

export function isIwcLookup(toolName: string): boolean {
  return IWC_TOOLS.has(toolName);
}

export function registerIwcPlanCheck(pi: ExtensionAPI): void {
  let consulted = false;
  let nudged = false;

  pi.on("session_start", async () => {
    consulted = false;
    nudged = false;
  });

  pi.on("tool_execution_start", async (event) => {
    if (isIwcLookup(event.toolName)) consulted = true;
  });

  pi.on("agent_end", async (event) => {
    if (consulted || nudged) return;
    const last = [...event.messages].reverse().find((m) => m.role === "assistant");
    if (last && "stopReason" in last && last.stopReason === "aborted") return;
    if (activeGalaxyStatus() !== "usable") return;
    // A restricted tool set (e.g. --tools read,write,edit) can't act on it.
    if (!pi.getActiveTools().includes(RECOMMEND_TOOL)) return;
    if (!draftsPlan(event.messages as Message[])) return;

    nudged = true;
    if (!deliverAutoFollowUp(IWC_PLAN_NUDGE, { dropOnStop: true })) return;
    const notebook = getNotebookPath();
    if (notebook) {
      appendActivityEvent(path.dirname(notebook), {
        timestamp: new Date().toISOString(),
        kind: "plan.iwc_check",
        source: "loom",
        payload: {},
      });
    }
  });
}
