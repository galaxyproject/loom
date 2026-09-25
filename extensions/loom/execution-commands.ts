import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNotebookPath, setCurrentStepAnchor } from "./state.js";
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
 *
 * A passing gate also points `state.currentStepAnchor` at the step it found,
 * so any Galaxy submission the agent makes in the run that follows is
 * attributed to that step without the agent having to say so. The pointer is
 * cleared when the run settles.
 */

export function registerExecutionCommands(pi: ExtensionAPI): void {
  // The anchor is ARMED by /execute and only goes live when a run actually
  // starts. Setting it directly was wrong in two reachable ways.
  //
  // pi dispatches a slash command while a previous run is still streaming, but
  // then rejects the `sendUserMessage` /execute makes (it passes no
  // deliverAs), and that rejection is swallowed. So /execute during an active
  // run repointed the anchor at a step whose run never began, and the RUNNING
  // run's next Galaxy submission was filed under it. Separately, a send that
  // fails for any other reason -- no model configured, auth -- left an anchor
  // set with no agent_end coming to clear it.
  //
  // Arming means an anchor is only ever consumed by a run that really started,
  // and every anchor that goes live has an agent_end to clear it.
  let pendingAnchor: string | null = null;
  let runActive = false;

  const executeHandler = async (_args: string | undefined, ctx: ExtensionContext) => {
    const nbPath = getNotebookPath();
    const gate = checkPreconditions();

    if (gate.hardFailed) {
      ctx.ui.notify(renderFailures(gate.failures), "warning");
      return;
    }

    if (!gate.ok) {
      // A soft-failed gate still sends the agent off, but it has no step worth
      // binding to -- most soft failures ARE "there is no usable next step".
      // Only the armed anchor is dropped; a live one belongs to a run that is
      // already going and is not ours to clear.
      pendingAnchor = null;
      ctx.ui.notify(renderFailures(gate.failures), "info");
      pi.sendUserMessage(
        `The user typed /execute (or /run) but the precondition check did not pass:\n\n${renderFailures(
          gate.failures,
        )}\n\nResolve these with the user first. Do NOT invoke Galaxy workflows or run local pipeline steps until the gate passes.`,
      );
      return;
    }

    // While a run is streaming pi rejects the message below, so there is no run
    // to attribute and arming would only strand the anchor.
    pendingAnchor = runActive ? null : (gate.plan?.nextStep?.anchor ?? null);

    pi.sendUserMessage(
      `The user typed /execute (or /run). Read \`${nbPath}\`, locate the most ` +
        `recent plan section that has unchecked steps (\`- [ ]\`), and execute ` +
        `the next pending step, then continue the authorized plan as prerequisites are verified. ` +
        `This is an execution request, not a request for another proposal or status-only response. For each step:\n` +
        `1. Decide local vs Galaxy per the plan's routing tag (see [local|hybrid|remote] in the section header).\n` +
        `2. **Galaxy steps run in the BACKGROUND — this is the default.** Invoke via Galaxy MCP, call ` +
        `galaxy_invocation_record({ invocationId, notebookAnchor, label }) — or, for a single tool run, ` +
        `galaxy_job_record({ jobId, notebookAnchor, label }). Continue other ready, authorized work. ` +
        `If no work is ready because a prerequisite is still running, report that and yield; ` +
        `the background poller queues automatic follow-up by default. Do NOT sit in this turn polling the invocation to completion. ` +
        `Leave unverified steps unchecked. Respect an explicit automatic-follow-up opt-out and report it honestly.\n` +
        `3. For local steps: run via bash synchronously; capture results into the notebook.\n` +
        `4. **Verify before claiming done — but only for work that has actually finished.** A *local* result: verify now ` +
        `(read/parse/lint/smoke-test; use the step's \`Verification:\` sub-bullet). For a Galaxy run, ` +
        `verification happens automatically once it is terminal: inspect current job/invocation state and the output datasets, ` +
        `record evidence, then flip the checkbox. If the run already finished, verify it in this turn, including immediately after submission. ` +
        `Do not wait for the user to ask again.\n` +
        `5. Write the verification evidence into the notebook before changing status.\n` +
        `6. Only after verification succeeds, edit the markdown checkbox to \`- [x]\` (or \`- [!]\` on failure). ` +
        `If verification is blocked or inconclusive, leave the step pending and record the actual blocker; ` +
        `say "created but not verified" for created artifacts. Resolve it within existing authorization, ` +
        `and ask only when a necessary decision, information or authorization is missing.\n` +
        `Give concise progress updates while executing; status questions do not revoke authorization to continue. ` +
        `Do NOT claim the artifact or step is done in chat unless verification evidence is recorded. ` +
        `On failure, stop dependent work and investigate; do not advance past errors or unverified results. ` +
        `Respect explicit pause/stop requests.`,
    );
  };

  // Promote the armed anchor when a run actually starts.
  pi.on("agent_start", async () => {
    runActive = true;
    if (pendingAnchor !== null) {
      setCurrentStepAnchor(pendingAnchor);
      pendingAnchor = null;
    }
  });

  // Clear the pointer when the agent run settles, not on `turn_end`.
  // pi's agentic loop emits turn_end after every model round trip inside one
  // run (agent-loop.js emits turn_end at :131 and loops back to turn_start at
  // :90), so clearing there would drop the anchor between the turn that reads
  // the notebook and the turn that actually submits -- which is the normal
  // shape of an /execute. `agent_end` fires once, when the run is over.
  pi.on("agent_end", async () => {
    runActive = false;
    setCurrentStepAnchor(null);
  });

  pi.registerCommand("execute", {
    description: "Execute authorized work in the latest plan section",
    handler: executeHandler,
  });

  pi.registerCommand("run", {
    description: "Alias for /execute",
    handler: executeHandler,
  });
}
