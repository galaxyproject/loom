import { loadConfig } from "./config";

/**
 * Whether a finished Galaxy run should wake the agent instead of only toasting
 * the user.
 *
 * Off by default, and deliberately so. Auto-resume changes what the product
 * does while nobody is watching: the agent takes a turn on its own, calls
 * tools, and spends tokens against the user's account with no one at the
 * keyboard. That is exactly what someone running a long analysis wants, and
 * exactly what someone who stepped away for the weekend does not. Opt in.
 *
 * Resolution order (env wins so a session can flip it without editing config):
 *   1. LOOM_AUTO_RESUME -- "1" on, "0" off.
 *   2. config.experiments.autoResume -- boolean.
 *   3. Default: off.
 */
export function isAutoResumeEnabled(): boolean {
  const env = process.env.LOOM_AUTO_RESUME;
  if (env === "1") return true;
  if (env === "0") return false;
  return loadConfig().experiments?.autoResume === true;
}

/**
 * The follow-up handed to the agent when a run finishes. Written as an
 * instruction rather than a notification, because it arrives as a user turn.
 *
 * It names the run, says what to do, and -- importantly -- tells the agent to
 * stop again afterwards. Without that last clause an auto-resumed turn can
 * chain into "and now let me start the next step", which is a very expensive
 * way to discover that unattended agents keep going.
 */
export function buildResumePrompt(
  label: string,
  outcome: "completed" | "failed",
  detail?: string,
): string {
  const what =
    outcome === "completed"
      ? `The Galaxy run "${label}" finished successfully.`
      : `The Galaxy run "${label}" failed${detail ? ` (${detail})` : ""}.`;
  const task =
    outcome === "completed"
      ? `Verify its outputs now: inspect the output datasets, record the evidence in the notebook, ` +
        `and flip the step's checkbox if it passes.`
      : `Investigate: read the failing job's stderr/exit state, record what you find in the notebook, ` +
        `and say plainly whether this is retryable or needs a human decision.`;
  return (
    `${what} ${task} ` +
    `This message was generated automatically when the run reached a terminal state — no human is ` +
    `necessarily watching. Report what you found and STOP; do not start the next step of the plan ` +
    `unless the plan says it runs unattended.`
  );
}
