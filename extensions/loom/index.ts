/**
 * Loom — Galaxy co-scientist extension for Pi.dev.
 *
 * Brain-side runtime that supports markdown-driven Galaxy bioinformatics
 * analyses. The notebook (`notebook.md`) is the durable record; plans live
 * inside it as markdown sections; Galaxy invocations are tracked via
 * `loom-invocation` YAML blocks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "./tools";
import { registerNotebookSyncTools } from "./tools-sync";
import { registerSyncCommand } from "./sync-command";
import { setupContextInjection, formatConnectionStatus } from "./context";
import { setupUIBridge } from "./ui-bridge";
import { registerSessionLifecycle } from "./session-lifecycle";
import { registerActivityHooks } from "./activity-hooks";
import { registerExecutionCommands } from "./execution-commands";
import { registerFeedbackCommand } from "./feedback-command";
import { registerTeamTools } from "./teams/tool";
import { isTeamDispatchEnabled } from "./teams/is-enabled";
import { registerSessionIndexTools } from "./session-index/tools";
import { isSessionIndexEnabled } from "./session-index/is-enabled";
import { registerConfusablesHint } from "./confusables-hint";
import { registerJobStatusHint } from "./job-status-hint";
import { registerExecGuard } from "./exec-guard";
import { registerSandbox } from "./sandbox";
import { registerSecretRedaction } from "./secret-redaction";
import * as fs from "fs";
import { getState, getNotebookPath, getNotebookWidgetMode, setNotebookWidgetMode } from "./state";
import {
  loadProfiles,
  saveProfile,
  switchProfile,
  profileNameFromUrl,
  normalizeGalaxyUrl,
} from "./profiles";
import { LoomWidgetKey, encodeMarkdownWidget } from "../../shared/loom-shell-contract.js";

export default function galaxyAnalystExtension(pi: ExtensionAPI): void {
  // Register the local-execution safety gate first so its tool_call decision is
  // the authoritative boundary before anything else runs.
  registerExecGuard(pi);
  // The opt-in bash sandbox layers an OS sandbox UNDER the gate (the gate still
  // decides allow/ask/deny; the sandbox only contains an allowed command's blast
  // radius). Default-on file-write confinement lives in the gate itself.
  registerSandbox(pi);
  // Data-shaped backstop to the path-shaped gate: scrub known secret VALUES out
  // of tool OUTPUT before it returns to the model, so an approved/slipped read
  // (or an `env` dump) can't push API keys into the provider's logs (#183).
  registerSecretRedaction(pi);

  setupUIBridge(pi);
  registerSessionLifecycle(pi);
  registerActivityHooks(pi);

  registerPlanTools(pi);
  registerNotebookSyncTools(pi);
  registerSyncCommand(pi);
  registerExecutionCommands(pi);
  registerFeedbackCommand(pi);
  registerConfusablesHint(pi);
  // After a single tool run, remind the agent that a submitted job isn't a
  // finished one so it verifies terminal state and surfaces failures (#210).
  registerJobStatusHint(pi);
  if (isTeamDispatchEnabled()) {
    registerTeamTools(pi);
  }
  if (isSessionIndexEnabled()) {
    registerSessionIndexTools(pi);
  }

  setupContextInjection(pi);

  // ─────────────────────────────────────────────────────────────────────────────
  // /connect — Galaxy connection with profile support
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("connect", {
    description:
      "Connect to Galaxy server. Use /connect to pick a profile or add a new one, /connect <name> to switch.",
    handler: async (args, ctx) => {
      const { profiles, active } = loadProfiles();
      const profileNames = Object.keys(profiles);

      async function reloadOrMessage(url: string) {
        if (typeof ctx.reload === "function") {
          await ctx.reload();
        } else {
          pi.sendUserMessage(
            `Please connect to Galaxy at ${url} using the API key from environment variables.`,
          );
        }
      }

      const requestedName = args?.trim();
      if (requestedName) {
        if (switchProfile(requestedName)) {
          ctx.ui.notify(`Switched to ${requestedName} (${profiles[requestedName].url})`, "info");
          await reloadOrMessage(profiles[requestedName].url);
        } else {
          ctx.ui.notify(
            `Unknown profile "${requestedName}". Use /profiles to see available profiles.`,
            "warning",
          );
        }
        return;
      }

      if (profileNames.length > 1) {
        const choices = profileNames.map((name) => {
          const marker = name === active ? "* " : "  ";
          return `${marker}${name} (${profiles[name].url})`;
        });
        choices.push("  Add new server...");

        const selection = await ctx.ui.select("Select Galaxy server", choices);
        if (selection === undefined || selection === null) {
          ctx.ui.notify("Connection cancelled", "warning");
          return;
        }

        const selectedIndex =
          typeof selection === "number" ? selection : choices.indexOf(selection);

        if (selectedIndex >= 0 && selectedIndex < profileNames.length) {
          const name = profileNames[selectedIndex];
          switchProfile(name);
          ctx.ui.notify(`Switched to ${name} (${profiles[name].url})`, "info");
          await reloadOrMessage(profiles[name].url);
          return;
        }
      } else if (
        profileNames.length === 1 &&
        active &&
        process.env.GALAXY_URL &&
        process.env.GALAXY_API_KEY
      ) {
        ctx.ui.notify(`Connecting to ${profiles[active].url}...`, "info");
        await reloadOrMessage(profiles[active].url);
        return;
      }

      const galaxyUrlInput = await ctx.ui.input("Galaxy Server URL", "https://usegalaxy.org");
      if (!galaxyUrlInput) {
        ctx.ui.notify("Connection cancelled", "warning");
        return;
      }
      // Accept a bare host ("test.galaxyproject.org") by defaulting to https://
      // instead of rejecting it as an invalid URL.
      const galaxyUrl = normalizeGalaxyUrl(galaxyUrlInput);

      ctx.ui.notify(
        "To get your API key: Log into Galaxy → User → Preferences → Manage API Key",
        "info",
      );
      const apiKey = await ctx.ui.input("Galaxy API Key");
      if (!apiKey) {
        ctx.ui.notify("Connection cancelled - API key required", "warning");
        return;
      }

      const name = profileNameFromUrl(galaxyUrl);
      saveProfile(name, galaxyUrl, apiKey);

      process.env.GALAXY_URL = galaxyUrl;
      process.env.GALAXY_API_KEY = apiKey;

      ctx.ui.notify(`Saved profile "${name}" and connecting to ${galaxyUrl}...`, "info");
      await reloadOrMessage(galaxyUrl);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /profiles — list saved Galaxy server profiles
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("profiles", {
    description: "List saved Galaxy server profiles",
    handler: async (_args, ctx) => {
      const { profiles, active } = loadProfiles();
      const names = Object.keys(profiles);

      if (names.length === 0) {
        ctx.ui.notify("No saved profiles. Use /connect to add one.", "info");
        return;
      }

      const lines: string[] = ["Galaxy Server Profiles", ""];
      for (const name of names) {
        const marker = name === active ? "*" : " ";
        lines.push(`  ${marker} ${name} (${profiles[name].url})`);
      }
      lines.push("");
      lines.push("Use /connect <name> to switch, or /connect to add a new server.");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /status — Galaxy connection + notebook path
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("status", {
    description: "Show Galaxy connection and notebook status",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push("🔬 Loom Status");
      lines.push("");
      for (const line of formatConnectionStatus(ctx)) {
        lines.push(line);
      }

      lines.push("");
      const notebookPath = getNotebookPath();
      if (notebookPath) {
        lines.push(`📓 Notebook: ${notebookPath}`);
      } else {
        lines.push("📓 No notebook (cwd has no notebook.md)");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /notebook — view current notebook content
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("notebook", {
    description: "Toggle the notebook panel",
    handler: async (_args, ctx) => {
      // Open → close. Marks "hidden" so the panel doesn't auto-reopen on the
      // next notebook write (see ui-bridge); a second /notebook reopens it.
      if (getNotebookWidgetMode() === "open") {
        ctx.ui.setWidget(LoomWidgetKey.Notebook, undefined);
        setNotebookWidgetMode("hidden");
        return;
      }
      const notebookPath = getNotebookPath();
      if (notebookPath && fs.existsSync(notebookPath)) {
        try {
          const content = fs.readFileSync(notebookPath, "utf-8");
          const header = `> \`${notebookPath}\`\n\n`;
          ctx.ui.setWidget(LoomWidgetKey.Notebook, encodeMarkdownWidget(header + content));
          setNotebookWidgetMode("open");
        } catch (err) {
          ctx.ui.notify(`Failed to read notebook: ${err}`, "error");
        }
        return;
      }
      ctx.ui.notify(
        "No notebook in cwd. A new notebook.md is created automatically on session start.",
        "info",
      );
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /compact — manually compact the conversation to reclaim context
  // ─────────────────────────────────────────────────────────────────────────────
  // Guards a second Loom /compact from racing the first: pi's compact() has no
  // internal concurrency guard (it just resets its abort controller), so a
  // concurrent call orphans the in-flight run. This only covers Loom-initiated
  // compactions -- pi's own auto-compaction isn't observable from an extension
  // (ExtensionContext exposes no isCompacting), so that race is left to pi.
  // Cleared in both completion callbacks and on a synchronous compact() throw.
  let compactionInFlight = false;
  pi.registerCommand("compact", {
    description:
      "Compact the conversation to free up context. Optional: /compact <instructions> to steer the summary.",
    handler: async (args, ctx) => {
      // No UI (e.g. headless RPC consumers) -> skip notifications; still compact.
      // Wrapped because ctx.ui/hasUI assert an active context and can throw if the
      // session was swapped while a compaction was in flight; a dropped toast is fine.
      const notify = (msg: string, level: "info" | "warning" | "error") => {
        try {
          if (ctx.hasUI) ctx.ui.notify(msg, level);
        } catch {
          /* stale context after a session swap -- nothing to show */
        }
      };

      if (compactionInFlight) {
        notify("A compaction is already running.", "warning");
        return;
      }

      const before = ctx.getContextUsage();
      const beforeStr = before?.tokens != null ? `${before.tokens.toLocaleString()} tokens` : "?";
      // The notebook is the durable record (snapshotted on session_before_compact),
      // so the summary can drop verbose tool chatter without losing project state.
      const customInstructions =
        args.trim() ||
        "Preserve the current analysis plan, decisions, and Galaxy invocation state. " +
          "Verbose tool outputs and dataset previews can be dropped — the notebook holds the durable record.";

      compactionInFlight = true;
      notify(`Compacting (was ${beforeStr})…`, "info");
      try {
        ctx.compact({
          customInstructions,
          onComplete: (result) => {
            compactionInFlight = false;
            // getContextUsage() reads null right after compaction (pi only learns the
            // new size on the next model response), so report the authoritative
            // before-count from the result; the footer shows the new size next turn.
            notify(
              `✅ Compacted (was ${result.tokensBefore.toLocaleString()} tokens). New size shows after the next turn.`,
              "info",
            );
          },
          onError: (err) => {
            compactionInFlight = false;
            notify(`Compaction failed: ${err.message}`, "error");
          },
        });
      } catch (err) {
        // ctx.compact() asserts an active context synchronously and can throw
        // before either callback runs; reset the guard so /compact isn't wedged.
        compactionInFlight = false;
        notify(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool execution lifecycle: show status when Galaxy tools run
  // ─────────────────────────────────────────────────────────────────────────────
  const toolStartTimes = new Map<string, number>();

  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName?.startsWith("galaxy_")) {
      const label = event.toolName.replace(/^galaxy_/, "").replace(/_/g, " ");
      toolStartTimes.set(event.toolName, Date.now());
      ctx.ui.setStatus("galaxy-tool", `🔧 Running ${label}...`);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName?.startsWith("galaxy_")) {
      const startTime = toolStartTimes.get(event.toolName);
      if (startTime) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const label = event.toolName.replace(/^galaxy_/, "").replace(/_/g, " ");
        ctx.ui.setStatus("galaxy-tool", `✓ ${label} (${elapsed}s)`);
        toolStartTimes.delete(event.toolName);
        setTimeout(() => ctx.ui.setStatus("galaxy-tool", ""), 3000);
      } else {
        ctx.ui.setStatus("galaxy-tool", "");
      }
    }

    if (event.toolName === "galaxy_connect" && !event.isError) {
      try {
        const resultText =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        if (resultText.includes('"success": true') || resultText.includes("success")) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch {
        /* ignore */
      }
    }

    if (event.toolName === "galaxy_create_history" && !event.isError) {
      try {
        const resultText =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        const match = resultText.match(/"id":\s*"([^"]+)"/);
        if (match) {
          const state = getState();
          state.currentHistoryId = match[1];
        }
      } catch {
        /* ignore */
      }
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "galaxy_connect") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && "text" in firstContent ? firstContent.text : undefined;
        if (resultText && resultText.includes('"success": true')) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch {
        /* ignore */
      }
    }

    if (event.toolName === "galaxy_create_history") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && "text" in firstContent ? firstContent.text : undefined;
        if (resultText) {
          const match = resultText.match(/"id":\s*"([^"]+)"/);
          if (match) {
            const state = getState();
            state.currentHistoryId = match[1];
          }
        }
      } catch {
        /* ignore */
      }
    }
  });
}
