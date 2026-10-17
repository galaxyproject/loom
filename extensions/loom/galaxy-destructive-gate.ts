/**
 * The destructive-operation confirm for in-process Galaxy tools.
 *
 * exec-guard confirms a history delete or purge (#338), but it is registered only where the brain
 * has a local file surface, so a shell without one never asked. This gate asks in exec-guard's
 * shape and words wherever the bare Galaxy tools run: for every tool whose definition galaxy-ops
 * marks `destructiveHint` (cancel_workflow_invocation, delete_user_tool), and -- where exec-guard
 * is not registered to own them -- for the calls `classifyGalaxyDestructive` reads from their
 * arguments (update_history deleted/purged). So a desktop with files asks once, never twice.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "path";
import {
  classifyGalaxyDestructive,
  describeGalaxyDestructive,
  GALAXY_ARGS_CLASSIFIED_OPS,
} from "../../shared/galaxy-destructive.js";
import type { GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";
import { appendActivityEvent } from "./activity";
import { redactArgs } from "./activity-hooks";
import { registeredGalaxyTools } from "./galaxy-tool-source";
import { getNotebookPath } from "./state";

type Decision = "ask" | "deny";

function audit(
  toolName: string,
  input: Record<string, unknown>,
  decision: Decision,
  reason: string,
  outcome: string,
): void {
  const nb = getNotebookPath();
  if (!nb) return;
  appendActivityEvent(path.dirname(nb), {
    timestamp: new Date().toISOString(),
    kind: "guard.decision",
    source: "galaxy-destructive-gate",
    payload: {
      toolName,
      decision,
      category: "galaxy:destructive",
      reason,
      outcome,
      args: redactArgs(toolName, input),
    },
  });
}

/** The ids a call names, so the user can see what it would act on. */
function idsOf(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(
      ([key, value]) =>
        (key.endsWith("_id") || key === "uuid") &&
        (typeof value === "string" || typeof value === "number"),
    )
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

/** A tool galaxy-ops marks destructive whose calls are not told apart by their arguments. */
function hinted(name: string): boolean {
  if (GALAXY_ARGS_CLASSIFIED_OPS.includes(name)) return false;
  return registeredGalaxyTools().some(
    (tool) => tool.name === name && tool.annotations?.destructiveHint === true,
  );
}

export function registerGalaxyDestructiveGate(
  pi: ExtensionAPI,
  family: GalaxyToolFamily,
  { classifyArgs }: { classifyArgs: boolean },
): void {
  pi.on("tool_call", async (event, ctx) => {
    const name = family.toolName(event.toolName);
    if (name === undefined) return;
    // pi has already run the tool's prepareArguments, so `deleted` is a boolean here.
    const input = (event.input ?? {}) as Record<string, unknown>;
    const op = classifyArgs ? classifyGalaxyDestructive(name, input) : null;
    if (!op && !hinted(name)) return;
    const ids = idsOf(input);
    const headline = op
      ? describeGalaxyDestructive(op).headline
      : `Run ${name}${ids ? ` (${ids})` : ""}, which Galaxy marks destructive.`;

    if (!ctx.hasUI) {
      const reason = `${headline} (denied: no interactive session to approve)`;
      audit(event.toolName, input, "deny", reason, "blocked:no-ui");
      return { block: true, reason };
    }
    const proceed = await ctx.ui.confirm(
      "Confirm destructive Galaxy operation",
      `${ctx.model?.id ?? "The model"} wants to: ${headline}\n\nContinue?`,
      {},
    );
    if (proceed) {
      audit(event.toolName, input, "ask", headline, "allowed:destructive-confirm");
      return;
    }
    audit(event.toolName, input, "ask", headline, "blocked:destructive-user");
    return { block: true, reason: "Destructive Galaxy operation cancelled by user." };
  });
}
