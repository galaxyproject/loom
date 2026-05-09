/**
 * Evaluate scenario assertions against a captured event stream.
 *
 * Tool calls live in `tool_execution_start` events. Chat text is the
 * concatenated `text_delta` from `message_update` events. We deliberately
 * keep the matchers simple (substring / ordered subsequence) -- if a
 * scenario needs more, it should be expressed as multiple assertions.
 */

import type { AnyEvent, Assertions, ScenarioFailure, ScenarioRun } from "./types.js";

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
  evaluateChatText(run.events, a, failures);

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

function evaluateChatText(events: AnyEvent[], a: Assertions, failures: ScenarioFailure[]): void {
  if (!a.chatText) return;
  const text = collectChatText(events);

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
