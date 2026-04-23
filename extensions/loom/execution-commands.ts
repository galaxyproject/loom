import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatPlanSummary, getCurrentPlan, getState } from "./state.js";
import { loadConfig } from "./config.js";

interface ExecutionCommandArgs {
  savedParameters?: Record<string, string | number | boolean>;
}

/**
 * Return an agent instruction when the user tries to execute but Galaxy is
 * required and not connected. Returns null if execution can proceed.
 */
function galaxyGateMessage(): string | null {
  const cfg = loadConfig();
  const mode = cfg.executionMode || "remote";
  if (mode !== "remote") return null;
  if (getState().galaxyConnected) return null;
  return (
    `Galaxy is not connected but execution mode is Remote. ` +
    `Before doing anything else, ask the user exactly one short question: ` +
    `"Galaxy is not connected. Do you want to connect via /connect, ` +
    `switch to Local mode in the masthead, or cancel?" ` +
    `Do NOT call any tools until the user chooses.`
  );
}

export function registerExecutionCommands(pi: ExtensionAPI): void {
  pi.registerCommand("review", {
    description: "Review the current plan's critical parameters before execution",
    handler: async (_args, ctx) => {
      const plan = getCurrentPlan();
      if (!plan) {
        ctx.ui.notify("No active analysis plan", "warning");
        return;
      }

      pi.sendUserMessage(
        `The user typed /review. Analyze every tool in the current plan, ` +
        `identify the CRITICAL biological parameters (hide thread counts, paths, flags, verbose), ` +
        `and call analyze_plan_parameters with a consolidated form spec grouped by biology concept ` +
        `(not by tool). Include biologist-friendly help text for every parameter. ` +
        `Use defaults appropriate for the organism/analysis type. ` +
        `Plan:\n${formatPlanSummary(plan)}`
      );
    },
  });

  pi.registerCommand("test", {
    description: "Run the current plan in test mode using reduced inputs",
    handler: async (args, ctx) => {
      const plan = getCurrentPlan();
      if (!plan) {
        ctx.ui.notify("No active analysis plan", "warning");
        return;
      }

      const gate = galaxyGateMessage();
      if (gate) {
        pi.sendUserMessage(gate);
        return;
      }

      const parsed = parseExecutionArgs(args);
      pi.sendUserMessage(
        `The user typed /test. Configured parameters:\n` +
        `${JSON.stringify(parsed.savedParameters || {}, null, 2)}\n\n` +
        `Sequence of calls (in order):\n` +
        `1. reset_plan_steps  — clear stale state\n` +
        `2. generate_test_data  — subsample real files if they exist, otherwise synthesize\n` +
        `3. For each step: update_step(in_progress, with description reflecting test mode) → ` +
        `run_command → update_step(completed, with result) → report_result\n\n` +
        `In test mode, update each step's description to reflect the smaller scope ` +
        `(e.g., 'Downloading 1 test sample' not '270 samples'). ` +
        `Tag results as 'TEST RUN' in the markdown. ` +
        `Do NOT call clear_test_mode — leave test mode on so the user can review. ` +
        `NO chat narration — let the DAG and Notebook tab show progress.\n\nPlan:\n${formatPlanSummary(plan)}`
      );
    },
  });

  const executeHandler = async (args: string | undefined, ctx: ExtensionContext) => {
    const plan = getCurrentPlan();
    if (!plan) {
      ctx.ui.notify("No active analysis plan", "warning");
      return;
    }

    const gate = galaxyGateMessage();
    if (gate) {
      pi.sendUserMessage(gate);
      return;
    }

    const parsed = parseExecutionArgs(args);
    pi.sendUserMessage(
      `The user typed /execute. Configured parameters:\n` +
      `${JSON.stringify(parsed.savedParameters || {}, null, 2)}\n\n` +
      `Sequence of calls (in order):\n` +
      `1. If test mode is active, clear_test_mode  — restore real paths\n` +
      `2. reset_plan_steps  — clear stale state from any previous run\n` +
      `3. For each step: update_step(in_progress) → run_command → update_step(completed)\n\n` +
      `NO chat narration — let the DAG and Notebook tab show progress.\n\nPlan:\n${formatPlanSummary(plan)}`
    );
  };

  pi.registerCommand("execute", {
    description: "Execute the current plan on real inputs",
    handler: executeHandler,
  });

  pi.registerCommand("run", {
    description: "Alias for /execute",
    handler: executeHandler,
  });
}

function parseExecutionArgs(args: string | undefined): ExecutionCommandArgs {
  if (!args?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed ? parsed as ExecutionCommandArgs : {};
  } catch {
    return {};
  }
}
