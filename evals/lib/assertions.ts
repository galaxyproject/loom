/**
 * Evaluate scenario assertions against a captured event stream.
 *
 * Tool calls live in `tool_execution_start` events. Chat text is the
 * concatenated `text_delta` from `message_update` events. We deliberately
 * keep the matchers simple (substring / ordered subsequence) -- if a
 * scenario needs more, it should be expressed as multiple assertions.
 */

import { parseLatestPlan } from "./notebook-parser.js";
import type {
  AnyEvent,
  Assertions,
  NotebookAssertions,
  PlanAssertions,
  ScenarioFailure,
  ScenarioRun,
} from "./types.js";

export function evaluate(run: ScenarioRun): ScenarioFailure[] {
  const failures: ScenarioFailure[] = [];
  const a = run.scenario.assertions;

  if (a.exitCode !== undefined && run.exitCode !== a.exitCode) {
    failures.push({
      assertion: "exitCode",
      detail: `expected ${a.exitCode}, got ${run.exitCode}`,
    });
  }

  evaluateToolCalls(run.events, a, failures);
  evaluateEvents(run.events, a, failures);
  evaluateChatText(run.events, a, run.model?.stripThinkingTags ?? false, failures);
  evaluateNotebook(run.notebookContent, a.notebook, failures);

  return failures;
}

function evaluateToolCalls(events: AnyEvent[], a: Assertions, failures: ScenarioFailure[]): void {
  if (!a.toolCalls) return;
  const toolCalls = events.filter((e) => e.type === "tool_execution_start");
  const toolNames = toolCalls.map((e) => String(e.toolName));

  for (const banned of a.toolCalls.mustNotInclude ?? []) {
    if (toolNames.includes(banned)) {
      failures.push({
        assertion: "toolCalls.mustNotInclude",
        detail: `banned tool '${banned}' was called`,
      });
    }
  }

  if (a.toolCalls.mustInclude && a.toolCalls.mustInclude.length > 0) {
    let cursor = 0;
    for (const expected of a.toolCalls.mustInclude) {
      const idx = findToolCall(toolCalls, expected.name, expected.argsContains, cursor);
      if (idx === -1) {
        failures.push({
          assertion: "toolCalls.mustInclude",
          detail: `expected tool '${expected.name}' not found in remaining sequence`,
        });
        break;
      }
      cursor = idx + 1;
    }
  }
}

function findToolCall(
  toolCalls: AnyEvent[],
  name: string,
  argsContains: Record<string, string> | undefined,
  startIdx: number,
): number {
  for (let i = startIdx; i < toolCalls.length; i++) {
    if (toolCalls[i].toolName !== name) continue;
    if (!argsContains) return i;
    const args = toolCalls[i].args as Record<string, unknown> | undefined;
    if (!args) continue;
    const ok = Object.entries(argsContains).every(([k, v]) => {
      const actual = args[k];
      return typeof actual === "string" && actual.includes(v);
    });
    if (ok) return i;
  }
  return -1;
}

function evaluateEvents(events: AnyEvent[], a: Assertions, failures: ScenarioFailure[]): void {
  if (!a.events) return;
  const types = new Set(events.map((e) => e.type));

  for (const required of a.events.mustInclude ?? []) {
    if (!types.has(required)) {
      failures.push({
        assertion: "events.mustInclude",
        detail: `expected event type '${required}' was not emitted`,
      });
    }
  }
  for (const banned of a.events.mustNotInclude ?? []) {
    if (types.has(banned)) {
      failures.push({
        assertion: "events.mustNotInclude",
        detail: `banned event type '${banned}' was emitted`,
      });
    }
  }
}

function evaluateChatText(
  events: AnyEvent[],
  a: Assertions,
  stripThinkingTags: boolean,
  failures: ScenarioFailure[],
): void {
  if (!a.chatText) return;
  let text = collectChatText(events);
  if (stripThinkingTags) text = stripThinking(text);

  for (const needle of a.chatText.mustInclude ?? []) {
    if (!text.includes(needle)) {
      failures.push({
        assertion: "chatText.mustInclude",
        detail: `chat text did not include '${needle}'`,
      });
    }
  }
  for (const needle of a.chatText.mustNotInclude ?? []) {
    if (text.includes(needle)) {
      failures.push({
        assertion: "chatText.mustNotInclude",
        detail: `chat text included banned '${needle}'`,
      });
    }
  }
}

function collectChatText(events: AnyEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type !== "message_update") continue;
    const inner = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (inner?.type === "text_delta" && typeof inner.delta === "string") {
      parts.push(inner.delta);
    }
  }
  return parts.join("");
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function evaluateNotebook(
  content: string | null,
  a: NotebookAssertions | undefined,
  failures: ScenarioFailure[],
): void {
  if (!a) return;

  if (a.exists !== undefined) {
    const present = content !== null;
    if (present !== a.exists) {
      failures.push({
        assertion: "notebook.exists",
        detail: `expected exists=${a.exists}, got ${present}`,
      });
    }
  }

  if (content === null) {
    // remaining checks need content; bail with a clear failure if any were asked for
    if (a.contains?.length || a.mustNotContain?.length || a.plan) {
      failures.push({
        assertion: "notebook",
        detail: "notebook.md was not present at end of run",
      });
    }
    return;
  }

  for (const needle of a.contains ?? []) {
    if (!content.includes(needle)) {
      failures.push({
        assertion: "notebook.contains",
        detail: `notebook did not contain '${needle}'`,
      });
    }
  }
  for (const needle of a.mustNotContain ?? []) {
    if (content.includes(needle)) {
      failures.push({
        assertion: "notebook.mustNotContain",
        detail: `notebook contained banned '${needle}'`,
      });
    }
  }

  if (a.plan) evaluatePlan(content, a.plan, failures);
}

function evaluatePlan(content: string, a: PlanAssertions, failures: ScenarioFailure[]): void {
  const plan = parseLatestPlan(content);
  if (!plan) {
    if (a.exists || a.routingIn || a.minPendingSteps !== undefined || a.eachStepHasDescription) {
      failures.push({
        assertion: "notebook.plan.exists",
        detail: "no `## Plan X: <title> [routing]` heading found in notebook",
      });
    }
    return;
  }

  if (a.routingIn && !a.routingIn.includes(plan.routing as (typeof a.routingIn)[number])) {
    failures.push({
      assertion: "notebook.plan.routingIn",
      detail: `plan routing '${plan.routing}' not in [${a.routingIn.join(", ")}]`,
    });
  }

  if (a.minPendingSteps !== undefined && plan.pendingSteps.length < a.minPendingSteps) {
    failures.push({
      assertion: "notebook.plan.minPendingSteps",
      detail: `expected >= ${a.minPendingSteps} pending steps, got ${plan.pendingSteps.length}`,
    });
  }

  if (a.eachStepHasDescription) {
    const skinny = plan.pendingSteps.filter((s) => s.descriptionLength < 8);
    if (skinny.length > 0) {
      failures.push({
        assertion: "notebook.plan.eachStepHasDescription",
        detail: `${skinny.length} step(s) lack a description >= 8 chars (lines ${skinny
          .map((s) => s.line + 1)
          .join(", ")})`,
      });
    }
  }
}
