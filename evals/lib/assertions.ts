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
  BehaviorAssertions,
  Dimension,
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
      dimension: "other",
    });
  }

  const stripThink = run.model?.stripThinkingTags ?? false;
  evaluateToolCalls(run.events, a, failures);
  evaluateEvents(run.events, a, failures);
  evaluateChatText(run.events, a, stripThink, failures);
  evaluateChatPlan(run.events, a.chatPlan, stripThink, failures);
  evaluateUnifiedPlan(run, a.plan, stripThink, failures);
  evaluateBehavior(run, a.behavior, stripThink, failures);
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
        dimension: "other",
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
          dimension: "other",
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
        dimension: "other",
      });
    }
  }
  for (const banned of a.events.mustNotInclude ?? []) {
    if (types.has(banned)) {
      failures.push({
        assertion: "events.mustNotInclude",
        detail: `banned event type '${banned}' was emitted`,
        dimension: "other",
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
  const text = getChatText(events, stripThinkingTags);

  for (const needle of a.chatText.mustInclude ?? []) {
    if (!text.includes(needle)) {
      failures.push({
        assertion: "chatText.mustInclude",
        detail: `chat text did not include '${needle}'`,
        dimension: "other",
      });
    }
  }
  for (const needle of a.chatText.mustNotInclude ?? []) {
    if (text.includes(needle)) {
      failures.push({
        assertion: "chatText.mustNotInclude",
        detail: `chat text included banned '${needle}'`,
        dimension: "other",
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

function getChatText(events: AnyEvent[], stripThinkingTags: boolean): string {
  const text = collectChatText(events);
  return stripThinkingTags ? stripThinking(text) : text;
}

function evaluateBehavior(
  run: ScenarioRun,
  a: BehaviorAssertions | undefined,
  stripThinkingTags: boolean,
  failures: ScenarioFailure[],
): void {
  if (!a) return;
  if (a.asksClarifyingQuestion) {
    const chat = getChatText(run.events, stripThinkingTags);
    const askedQuestion = chat.includes("?");
    const chatPlan = parseLatestPlan(chat);
    const notebookPlan = run.notebookContent ? parseLatestPlan(run.notebookContent) : null;
    const fabricatedPlan = chatPlan !== null || notebookPlan !== null;

    if (!askedQuestion) {
      failures.push({
        assertion: "behavior.asksClarifyingQuestion",
        detail: "agent did not ask a clarifying question (no '?' in chat)",
        dimension: "behavior",
      });
    }
    if (fabricatedPlan) {
      failures.push({
        assertion: "behavior.asksClarifyingQuestion",
        detail: "agent fabricated a plan instead of asking for clarification",
        dimension: "behavior",
      });
    }
  }
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
        dimension: "other",
      });
    }
  }

  if (content === null) {
    // remaining checks need content; bail with a clear failure if any were asked for
    if (a.contains?.length || a.mustNotContain?.length) {
      failures.push({
        assertion: "notebook",
        detail: "notebook.md was not present at end of run",
        dimension: "other",
      });
    }
    // Run evaluatePlan against empty content so every declared plan dimension
    // (validity, routing, tools) gets a failure -- not just a generic 'other'.
    // Without this, a model that emits no notebook looks green on routing/tools.
    if (a.plan) {
      evaluatePlan("", a.plan, failures, "notebook.plan", "notebook");
    }
    return;
  }

  for (const needle of a.contains ?? []) {
    if (!content.includes(needle)) {
      failures.push({
        assertion: "notebook.contains",
        detail: `notebook did not contain '${needle}'`,
        dimension: "other",
      });
    }
  }
  for (const needle of a.mustNotContain ?? []) {
    if (content.includes(needle)) {
      failures.push({
        assertion: "notebook.mustNotContain",
        detail: `notebook contained banned '${needle}'`,
        dimension: "other",
      });
    }
  }

  if (a.plan) evaluatePlan(content, a.plan, failures, "notebook.plan", "notebook");
}

function evaluateChatPlan(
  events: AnyEvent[],
  a: PlanAssertions | undefined,
  stripThinkingTags: boolean,
  failures: ScenarioFailure[],
): void {
  if (!a) return;
  const text = getChatText(events, stripThinkingTags);
  evaluatePlan(text, a, failures, "chatPlan", "chat text");
}

function evaluateUnifiedPlan(
  run: ScenarioRun,
  a: PlanAssertions | undefined,
  stripThinkingTags: boolean,
  failures: ScenarioFailure[],
): void {
  if (!a) return;
  const source = a.source ?? "any";
  const chat = getChatText(run.events, stripThinkingTags);
  const notebook = run.notebookContent ?? "";

  let content: string;
  let label: string;
  if (source === "notebook") {
    content = notebook;
    label = "notebook";
  } else if (source === "chat") {
    content = chat;
    label = "chat text";
  } else {
    const notebookHasPlan = notebook.length > 0 && parseLatestPlan(notebook) !== null;
    content = notebookHasPlan ? notebook : chat;
    label = notebookHasPlan ? "notebook" : "chat text";
  }

  evaluatePlan(content, a, failures, "plan", label);
}

/**
 * Apply PlanAssertions to a content string. `prefix` is the assertion-name
 * prefix used in failure detail (e.g. "notebook.plan", "chatPlan");
 * `surfaceLabel` names the source for human-readable failure text
 * ("notebook", "chat text").
 */
function evaluatePlan(
  content: string,
  a: PlanAssertions,
  failures: ScenarioFailure[],
  prefix: string,
  surfaceLabel: string,
): void {
  const plan = parseLatestPlan(content);

  if (!plan) {
    if (
      a.exists ||
      a.routingIn ||
      a.minPendingSteps !== undefined ||
      a.eachStepHasDescription ||
      a.mentionsOneOf ||
      a.mentionsNoneOf
    ) {
      // Validity is the gate -- emit the primary existence failure first.
      failures.push({
        assertion: `${prefix}.exists`,
        detail: `no \`## Plan X: <title> [routing]\` heading found in ${surfaceLabel}`,
        dimension: "validity",
      });
      // Also fail every other declared dimension so the leaderboard doesn't
      // show false-green scores for a model that emitted no plan at all.
      if (a.routingIn) {
        failures.push({
          assertion: `${prefix}.routingIn`,
          detail: `no plan in ${surfaceLabel}, so routing could not be graded`,
          dimension: "routing",
        });
      }
      if (a.mentionsOneOf?.length || a.mentionsNoneOf?.length) {
        failures.push({
          assertion: `${prefix}.mentions`,
          detail: `no plan in ${surfaceLabel}, so tools could not be graded`,
          dimension: "tools",
        });
      }
    }
    return;
  }

  if (a.exists === false) {
    failures.push({
      assertion: `${prefix}.exists`,
      detail: `expected no plan heading in ${surfaceLabel} but found "${plan.title}"`,
      dimension: "validity",
    });
    return;
  }

  if (a.routingIn && !a.routingIn.includes(plan.routing as (typeof a.routingIn)[number])) {
    failures.push({
      assertion: `${prefix}.routingIn`,
      detail: `plan routing '${plan.routing}' not in [${a.routingIn.join(", ")}]`,
      dimension: "routing",
    });
  }

  if (a.minPendingSteps !== undefined && plan.pendingSteps.length < a.minPendingSteps) {
    failures.push({
      assertion: `${prefix}.minPendingSteps`,
      detail: `expected >= ${a.minPendingSteps} pending steps, got ${plan.pendingSteps.length}`,
      dimension: "validity",
    });
  }

  if (a.eachStepHasDescription) {
    const skinny = plan.pendingSteps.filter((s) => s.descriptionLength < 8);
    if (skinny.length > 0) {
      failures.push({
        assertion: `${prefix}.eachStepHasDescription`,
        detail: `${skinny.length} step(s) lack a description >= 8 chars (lines ${skinny
          .map((s) => s.line + 1)
          .join(", ")})`,
        dimension: "validity",
      });
    }
  }

  // Mention checks scan the whole surface (`content`), not just the parsed
  // plan section, by design: tool names legitimately land in sub-bullets and
  // param tables the parser doesn't capture, so scoping to step lines would
  // cause false negatives. The trade-off is a coarse heuristic -- a tool named
  // in surrounding prose can pass mentionsOneOf -- which the suite accepts;
  // nuance is the (deferred) judge layer's job.
  const lower = content.toLowerCase();
  if (a.mentionsOneOf && a.mentionsOneOf.length > 0) {
    const hit = a.mentionsOneOf.some((t) => lower.includes(t.toLowerCase()));
    if (!hit) {
      failures.push({
        assertion: `${prefix}.mentionsOneOf`,
        detail: `${surfaceLabel} mentions none of [${a.mentionsOneOf.join(", ")}]`,
        dimension: "tools",
      });
    }
  }
  for (const banned of a.mentionsNoneOf ?? []) {
    if (lower.includes(banned.toLowerCase())) {
      failures.push({
        assertion: `${prefix}.mentionsNoneOf`,
        detail: `${surfaceLabel} mentions banned '${banned}'`,
        dimension: "tools",
      });
    }
  }
}
