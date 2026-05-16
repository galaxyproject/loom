import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getNotebookPath } from "./state.js";
import { checkPreconditions, renderFailures } from "./init-gate.js";

/**
 * Plan/execution commands. Plans live as markdown sections in `notebook.md`;
 * these commands send the agent an instruction to read the notebook and act.
 *
 * Before sending the agent off, run a precondition check (see init-gate.ts):
 * - hard failures (no notebook; plan needs Galaxy but disconnected) refuse
 *   to send the agent prompt at all
 * - soft failures (no plan; weak acceptance criteria; no history selected
 *   for a Galaxy plan) still prompt, but the prompt carries the failure
 *   list so the agent resolves with the user before invoking anything
 */

export function registerExecutionCommands(pi: ExtensionAPI): void {
  const executeHandler = async (_args: string | undefined, ctx: ExtensionContext) => {
    const nbPath = getNotebookPath();
    const gate = checkPreconditions();

    if (gate.hardFailed) {
      ctx.ui.notify(renderFailures(gate.failures), "warning");
      return;
    }

    if (!gate.ok) {
      ctx.ui.notify(renderFailures(gate.failures), "info");
      pi.sendUserMessage(
        `The user typed /execute (or /run) but the precondition check did not pass:\n\n${renderFailures(
          gate.failures,
        )}\n\nResolve these with the user first. Do NOT invoke Galaxy workflows or run local pipeline steps until the gate passes.`,
      );
      return;
    }

    pi.sendUserMessage(
      `The user typed /execute (or /run). Read \`${nbPath}\`, locate the most ` +
        `recent plan section that has unchecked steps (\`- [ ]\`), and execute ` +
        `the next pending step. For each step:\n` +
        `1. Decide local vs Galaxy per the plan's routing tag (see [local|hybrid|remote] in the section header).\n` +
        `2. For Galaxy steps: invoke via Galaxy MCP, then call galaxy_invocation_record(...).\n` +
        `3. For local steps: run via bash; capture results into the notebook.\n` +
        `4. After completion, edit the markdown checkbox to \`- [x]\` (or \`- [!]\` on failure).\n` +
        `5. Periodically call galaxy_invocation_check_all to advance in-flight Galaxy work.\n` +
        `Do NOT narrate progress in chat — the Notebook tab shows it. ` +
        `Stop on failure; do not auto-advance past errors.`,
    );
  };

  pi.registerCommand("execute", {
    description: "Execute the next pending step in the latest plan section",
    handler: executeHandler,
  });

  pi.registerCommand("run", {
    description: "Alias for /execute",
    handler: executeHandler,
  });
}
