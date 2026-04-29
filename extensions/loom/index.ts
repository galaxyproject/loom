/**
 * Loom — Galaxy co-scientist extension for Pi.dev.
 *
 * Brain-side runtime that supports markdown-driven Galaxy bioinformatics
 * analyses. The notebook (`notebook.md`) is the durable record; plans live
 * inside it as markdown sections; Galaxy invocations are tracked via
 * `loom-invocation` YAML blocks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPlanTools } from "./tools";
import { setupContextInjection, formatConnectionStatus } from "./context";
import { setupUIBridge } from "./ui-bridge";
import { registerSessionLifecycle } from "./session-bootstrap";
import { registerActivityHooks } from "./activity-hooks";
import { registerExecutionCommands } from "./execution-commands";
import { registerTeamTools } from "./teams/tool";
import { isTeamDispatchEnabled } from "./teams/is-enabled";
import { registerSessionIndexTools } from "./session-index/tools";
import { isSessionIndexEnabled } from "./session-index/is-enabled";
import * as fs from "fs";
import {
  getState,
  getNotebookPath,
} from "./state";
import {
  loadProfiles,
  saveProfile,
  switchProfile,
  profileNameFromUrl,
  warnOnUnusableActiveProfile,
} from "./profiles";
import { LoomWidgetKey, encodeMarkdownWidget } from "../../shared/loom-shell-contract.js";

export default function galaxyAnalystExtension(pi: ExtensionAPI): void {

  warnOnUnusableActiveProfile();

  setupUIBridge(pi);
  registerSessionLifecycle(pi);
  registerActivityHooks(pi);

  registerPlanTools(pi);
  registerExecutionCommands(pi);
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
    description: "Connect to Galaxy server. Use /connect to pick a profile or add a new one, /connect <name> to switch.",
    handler: async (args, ctx) => {
      const { profiles, active } = loadProfiles();
      const profileNames = Object.keys(profiles);

      async function reloadOrMessage(url: string) {
        if (typeof ctx.reload === 'function') {
          await ctx.reload();
        } else {
          pi.sendUserMessage(
            `Please connect to Galaxy at ${url} using the API key from environment variables.`
          );
        }
      }

      const requestedName = args?.trim();
      if (requestedName) {
        if (switchProfile(requestedName)) {
          ctx.ui.notify(`Switched to ${requestedName} (${profiles[requestedName].url})`, "info");
          await reloadOrMessage(profiles[requestedName].url);
        } else {
          ctx.ui.notify(`Unknown profile "${requestedName}". Use /profiles to see available profiles.`, "warning");
        }
        return;
      }

      if (profileNames.length > 1) {
        const choices = profileNames.map(name => {
          const marker = name === active ? "* " : "  ";
          return `${marker}${name} (${profiles[name].url})`;
        });
        choices.push("  Add new server...");

        const selection = await ctx.ui.select("Select Galaxy server", choices);
        if (selection === undefined || selection === null) {
          ctx.ui.notify("Connection cancelled", "warning");
          return;
        }

        const selectedIndex = typeof selection === 'number' ? selection : choices.indexOf(selection);

        if (selectedIndex >= 0 && selectedIndex < profileNames.length) {
          const name = profileNames[selectedIndex];
          switchProfile(name);
          ctx.ui.notify(`Switched to ${name} (${profiles[name].url})`, "info");
          await reloadOrMessage(profiles[name].url);
          return;
        }
      } else if (profileNames.length === 1 && active && process.env.GALAXY_URL && process.env.GALAXY_API_KEY) {
        ctx.ui.notify(`Connecting to ${profiles[active].url}...`, "info");
        await reloadOrMessage(profiles[active].url);
        return;
      }

      const galaxyUrl = await ctx.ui.input(
        "Galaxy Server URL",
        "https://usegalaxy.org"
      );
      if (!galaxyUrl) {
        ctx.ui.notify("Connection cancelled", "warning");
        return;
      }

      ctx.ui.notify(
        "To get your API key: Log into Galaxy → User → Preferences → Manage API Key",
        "info"
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
    description: "View current notebook content",
    handler: async (_args, ctx) => {
      const notebookPath = getNotebookPath();
      if (notebookPath && fs.existsSync(notebookPath)) {
        try {
          const content = fs.readFileSync(notebookPath, "utf-8");
          const header = `> \`${notebookPath}\`\n\n`;
          ctx.ui.setWidget(LoomWidgetKey.Notebook, encodeMarkdownWidget(header + content));
        } catch (err) {
          ctx.ui.notify(`Failed to read notebook: ${err}`, "error");
        }
        return;
      }
      ctx.ui.notify("No notebook in cwd. A new notebook.md is created automatically on session start.", "info");
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
        const resultText = typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result);
        if (resultText.includes('"success": true') || resultText.includes('success')) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch { /* ignore */ }
    }

    if (event.toolName === "galaxy_create_history" && !event.isError) {
      try {
        const resultText = typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result);
        const match = resultText.match(/"id":\s*"([^"]+)"/);
        if (match) {
          const state = getState();
          state.currentHistoryId = match[1];
        }
      } catch { /* ignore */ }
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "galaxy_connect") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && 'text' in firstContent ? firstContent.text : undefined;
        if (resultText && resultText.includes('"success": true')) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch { /* ignore */ }
    }

    if (event.toolName === "galaxy_create_history") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && 'text' in firstContent ? firstContent.text : undefined;
        if (resultText) {
          const match = resultText.match(/"id":\s*"([^"]+)"/);
          if (match) {
            const state = getState();
            state.currentHistoryId = match[1];
          }
        }
      } catch { /* ignore */ }
    }
  });
}
