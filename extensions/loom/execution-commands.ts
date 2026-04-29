import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getNotebookPath } from "./state.js";

/**
 * Plan/execution commands. Plans live as markdown sections in `notebook.md`;
 * these commands send the agent an instruction to read the notebook and act.
 */

export function registerExecutionCommands(pi: ExtensionAPI): void {
  const executeHandler = async (_args: string | undefined, ctx: ExtensionContext) => {
    const nbPath = getNotebookPath();
    if (!nbPath) {
      ctx.ui.notify("No notebook open in this directory.", "warning");
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
