import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { submitFeedback, buildBrainSysinfo, appendToOutbox, readLoomVersion } from "./feedback.js";
import { getRecentActivityEvents } from "./activity.js";
import { loadConfig } from "./config.js";
import {
  SCHEMA_VERSION,
  formatActivityTail,
  capFeedbackPayload,
} from "../../shared/feedback-contract.js";
import type { FeedbackPayload } from "../../shared/feedback-contract.js";

/**
 * /feedback -- gather feedback inline via ctx.ui and POST it to the capture
 * worker. Cross-shell: ctx.ui renders in Orbit and the Loom CLI alike. The
 * brain cannot open Orbit's HTML modal (no plumbing), so this is the brain's
 * own capture path. Guards on ctx.hasUI so it never POSTs an empty payload in
 * non-interactive/RPC mode.
 */
export function registerFeedbackCommand(pi: ExtensionAPI): void {
  pi.registerCommand("feedback", {
    description: "Send feedback about Loom to the team (captures optional diagnostics).",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/feedback needs interactive mode. Re-run it in Orbit or an interactive CLI session.",
          "warning",
        );
        return;
      }

      const title =
        (args && args.trim()) || (await ctx.ui.input("Feedback -- short title", "Summarize it"));
      if (!title || !title.trim()) return;

      const body = (await ctx.ui.editor("What's the feedback?", "")) ?? "";

      const includeDiagnostics = await ctx.ui.confirm(
        "Include diagnostics?",
        "Attach system info + a summary of recent activity (tool names, arguments, and truncated results), sent to the Loom team's private feedback store. Credentials and API keys are redacted.",
      );

      // Opaque tester code (config, env override) -- non-secret; lets the team
      // attribute the report. Omitted from the payload when unset.
      const testerId = loadConfig().testerId || process.env.LOOM_TESTER_ID;

      // The app version always rides along (non-sensitive build metadata) so every
      // loom-cli row is filterable by release in triage, even without diagnostics.
      const payload: FeedbackPayload = {
        schemaVersion: SCHEMA_VERSION,
        source: "loom-cli",
        title: title.trim(),
        body: body.trim(),
        clientTs: new Date().toISOString(),
        ...(testerId ? { testerId } : {}),
        ...(includeDiagnostics
          ? {
              sysinfo: buildBrainSysinfo(),
              activityTail: formatActivityTail(getRecentActivityEvents(60)),
            }
          : { sysinfo: { appVersion: readLoomVersion() } }),
      };

      const capped = capFeedbackPayload(payload);
      const res = await submitFeedback(capped);
      if (res.ok) {
        ctx.ui.notify("Thanks -- your feedback was sent.", "info");
        return;
      }
      // Durability: never lose the user's note if the store is unreachable.
      const saved = appendToOutbox(capped);
      ctx.ui.notify(
        saved
          ? `Couldn't reach the feedback service (${res.error ?? "unknown error"}) -- saved locally, we'll pick it up later.`
          : `Couldn't reach the feedback service (${res.error ?? "unknown error"}). Please try again later.`,
        saved ? "warning" : "error",
      );
    },
  });
}
