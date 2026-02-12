/**
 * gxypi - Galaxy co-scientist extension for Pi.dev
 *
 * Provides plan-based analysis orchestration for Galaxy bioinformatics workflows.
 * Manages analysis state, registers custom tools, and injects context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPlanTools } from "./tools";
import { setupContextInjection } from "./context";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getState,
  getCurrentPlan,
  restorePlan,
  resetState,
  findNotebooks,
  loadNotebook,
  getNotebookPath,
  saveNotebook,
} from "./state";
import type { AnalysisPlan } from "./types";
import {
  loadProfiles,
  saveProfile,
  switchProfile,
  profileNameFromUrl,
} from "./profiles";

export default function galaxyAnalystExtension(pi: ExtensionAPI): void {

  // ─────────────────────────────────────────────────────────────────────────────
  // Session initialization
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Reset state on new session
    resetState();

    // First, check for notebooks in the current working directory
    const cwd = process.cwd();
    try {
      const notebooks = await findNotebooks(cwd);

      if (notebooks.length === 1) {
        // Auto-load single notebook
        const plan = await loadNotebook(notebooks[0].path);
        if (plan) {
          const completed = plan.steps.filter(s => s.status === 'completed').length;
          ctx.ui.notify(
            `Loaded notebook: ${plan.title} (${completed}/${plan.steps.length} steps)`,
            "info"
          );
        }
      } else if (notebooks.length > 1) {
        // Multiple notebooks found - notify user
        ctx.ui.notify(
          `Found ${notebooks.length} notebooks. Use analysis_notebook_open to select one.`,
          "info"
        );
      }
    } catch {
      // Notebook loading failed, fall back to session entries
    }

    // Fall back to restoring from session entries
    try {
      const entries = ctx.sessionManager?.getEntries?.() || [];
      const planEntries = entries.filter(
        (e) => e.type === "custom" && (e as { customType?: string }).customType === "galaxy_analyst_plan"
      );

      if (planEntries.length > 0) {
        const latestEntry = planEntries[planEntries.length - 1] as { type: "custom"; data?: unknown };
        if (latestEntry.data) {
          restorePlan(latestEntry.data as AnalysisPlan);
          ctx.ui.notify(`Restored plan: ${(latestEntry.data as AnalysisPlan).title}`, "info");
        }
      }
    } catch {
      // Session manager may not be available in all contexts
    }

    // Kick off an initial LLM turn: greet and auto-connect if credentials are present
    const hasCredentials = process.env.GALAXY_URL && process.env.GALAXY_API_KEY;
    if (hasCredentials) {
      pi.sendUserMessage(
        "Session started. Connect to Galaxy and introduce yourself briefly."
      );
    } else {
      pi.sendUserMessage(
        "Session started. Introduce yourself briefly and let me know I can use /connect to set up a Galaxy server."
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register custom tools for plan management
  // ─────────────────────────────────────────────────────────────────────────────
  registerPlanTools(pi);

  // ─────────────────────────────────────────────────────────────────────────────
  // Set up context injection
  // ─────────────────────────────────────────────────────────────────────────────
  setupContextInjection(pi);

  // ─────────────────────────────────────────────────────────────────────────────
  // Persist state before compaction
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("session_before_compact", async (_event, _ctx) => {
    const plan = getCurrentPlan();
    if (plan) {
      pi.appendEntry("galaxy_analyst_plan", plan);
    }
    return {};
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Handle session shutdown
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    const plan = getCurrentPlan();
    if (plan) {
      pi.appendEntry("galaxy_analyst_plan", plan);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /plan command for quick plan access
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("plan", {
    description: "View current analysis plan summary",
    handler: async (_args, ctx) => {
      const plan = getCurrentPlan();

      if (!plan) {
        ctx.ui.notify("No active analysis plan", "warning");
        return;
      }

      // Build summary display
      const lines: string[] = [];
      lines.push(`📋 ${plan.title} [${plan.status}]`);
      lines.push(`   ${plan.context.researchQuestion.slice(0, 60)}...`);
      lines.push('');

      // Steps
      for (const step of plan.steps) {
        const icon = {
          'pending': '⬜',
          'in_progress': '🔄',
          'completed': '✅',
          'skipped': '⏭️',
          'failed': '❌',
        }[step.status];
        lines.push(`   ${icon} ${step.id}. ${step.name}`);
      }

      // Stats
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      lines.push('');
      lines.push(`   Progress: ${completed}/${plan.steps.length} steps completed`);
      lines.push(`   Decisions: ${plan.decisions.length} logged`);
      lines.push(`   Checkpoints: ${plan.checkpoints.length}`);

      ctx.ui.setWidget("plan-view", lines);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /plan-decisions command to view decision log
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("plan-decisions", {
    description: "View recent decisions in the analysis plan",
    handler: async (_args, ctx) => {
      const plan = getCurrentPlan();

      if (!plan) {
        ctx.ui.notify("No active analysis plan", "warning");
        return;
      }

      if (plan.decisions.length === 0) {
        ctx.ui.notify("No decisions logged yet", "info");
        return;
      }

      const lines: string[] = ["📝 Decision Log", ""];

      // Show last 10 decisions
      const recent = plan.decisions.slice(-10);
      for (const d of recent) {
        const date = new Date(d.timestamp).toLocaleString();
        const stepInfo = d.stepId ? ` (Step ${d.stepId})` : '';
        const approved = d.researcherApproved ? '✓' : '?';

        lines.push(`[${d.type}]${stepInfo} ${approved}`);
        lines.push(`  ${d.description.slice(0, 70)}${d.description.length > 70 ? '...' : ''}`);
        lines.push(`  ${date}`);
        lines.push('');
      }

      ctx.ui.setWidget("decisions-view", lines);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /connect command for Galaxy connection with profile support
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("connect", {
    description: "Connect to Galaxy server. Use /connect to pick a profile or add a new one, /connect <name> to switch.",
    handler: async (args, ctx) => {
      const { profiles, active } = loadProfiles();
      const profileNames = Object.keys(profiles);

      // /connect <name> — switch to a named profile
      const requestedName = args?.trim();
      if (requestedName) {
        if (switchProfile(requestedName)) {
          ctx.ui.notify(`Switched to ${requestedName} (${profiles[requestedName].url})`, "info");
          pi.sendUserMessage(
            `Please connect to Galaxy at ${profiles[requestedName].url} using the API key from environment variables.`
          );
        } else {
          ctx.ui.notify(`Unknown profile "${requestedName}". Use /profiles to see available profiles.`, "warning");
        }
        return;
      }

      // /connect (no args) — depends on how many profiles exist
      if (profileNames.length > 1) {
        // Multiple profiles: let user pick or add a new server
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
          // Picked an existing profile
          const name = profileNames[selectedIndex];
          switchProfile(name);
          ctx.ui.notify(`Switched to ${name} (${profiles[name].url})`, "info");
          pi.sendUserMessage(
            `Please connect to Galaxy at ${profiles[name].url} using the API key from environment variables.`
          );
          return;
        }
        // Fall through to "add new server" flow below
      } else if (profileNames.length === 1 && active && process.env.GALAXY_URL && process.env.GALAXY_API_KEY) {
        // One profile, already active — just connect
        ctx.ui.notify(`Connecting to ${profiles[active].url}...`, "info");
        pi.sendUserMessage(
          `Please connect to Galaxy at ${profiles[active].url} using the API key from environment variables.`
        );
        return;
      }

      // No profiles, or user chose "Add new server" — prompt for credentials
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

      // Save as a new profile
      const name = profileNameFromUrl(galaxyUrl);
      saveProfile(name, galaxyUrl, apiKey);

      process.env.GALAXY_URL = galaxyUrl;
      process.env.GALAXY_API_KEY = apiKey;

      ctx.ui.notify(`Saved profile "${name}" and connecting to ${galaxyUrl}...`, "info");

      pi.sendUserMessage(
        `Please connect to Galaxy at ${galaxyUrl} using the API key from environment variables.`
      );
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /profiles command to list saved Galaxy server profiles
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

      ctx.ui.setWidget("profiles-view", lines);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /status command for quick Galaxy status check
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("status", {
    description: "Show Galaxy connection and plan status",
    handler: async (_args, ctx) => {
      const state = getState();
      const plan = getCurrentPlan();

      const lines: string[] = [];
      lines.push("🔬 gxypi Status");
      lines.push("");

      // Connection status
      if (state.galaxyConnected) {
        lines.push(`✅ Connected to Galaxy`);
        if (process.env.GALAXY_URL) {
          lines.push(`   Server: ${process.env.GALAXY_URL}`);
        }
        if (state.currentHistoryId) {
          lines.push(`   History: ${state.currentHistoryId}`);
        }
      } else {
        lines.push("⚪ Not connected to Galaxy");
        lines.push("   Use /connect or ask to connect");
      }

      lines.push("");

      // Plan status
      if (plan) {
        const completed = plan.steps.filter(s => s.status === 'completed').length;
        const current = plan.steps.find(s => s.status === 'in_progress');
        lines.push(`📋 Plan: ${plan.title}`);
        lines.push(`   Status: ${plan.status}`);
        lines.push(`   Progress: ${completed}/${plan.steps.length} steps`);
        if (current) {
          lines.push(`   Current: ${current.name}`);
        }
      } else {
        lines.push("📋 No active plan");
        lines.push("   Start by describing your analysis");
      }

      // Notebook status
      lines.push("");
      const notebookPath = getNotebookPath();
      if (notebookPath) {
        lines.push(`📓 Notebook: ${notebookPath}`);
      } else {
        lines.push("📓 No notebook (in-memory only)");
        lines.push("   Use analysis_notebook_create to persist");
      }

      ctx.ui.setWidget("status-view", lines);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Register /notebook command for quick notebook access
  // ─────────────────────────────────────────────────────────────────────────────
  pi.registerCommand("notebook", {
    description: "View current notebook info or list available notebooks",
    handler: async (_args, ctx) => {
      const notebookPath = getNotebookPath();
      const plan = getCurrentPlan();

      const lines: string[] = [];
      lines.push("📓 Analysis Notebook");
      lines.push("");

      if (notebookPath && plan) {
        lines.push(`Path: ${notebookPath}`);
        lines.push(`Title: ${plan.title}`);
        lines.push(`Status: ${plan.status}`);

        const completed = plan.steps.filter(s => s.status === 'completed').length;
        lines.push(`Progress: ${completed}/${plan.steps.length} steps`);

        lines.push("");
        lines.push("Sections:");
        lines.push("  - Research Context");
        lines.push("  - Analysis Plan (steps with YAML blocks)");
        lines.push("  - Execution Log (append-only audit trail)");
        lines.push("  - Galaxy References (dataset links)");
      } else {
        lines.push("No notebook loaded.");
        lines.push("");

        // List available notebooks
        const cwd = process.cwd();
        const notebooks = await findNotebooks(cwd);

        if (notebooks.length > 0) {
          lines.push(`Found ${notebooks.length} notebook(s) in ${cwd}:`);
          lines.push("");
          for (const nb of notebooks) {
            lines.push(`  📄 ${nb.title}`);
            lines.push(`     ${nb.path}`);
            lines.push(`     ${nb.completedSteps}/${nb.stepCount} steps, ${nb.status}`);
            lines.push("");
          }
          lines.push("Use analysis_notebook_open to load one.");
        } else {
          lines.push("No notebooks found in current directory.");
          lines.push("Create a plan, then use analysis_notebook_create.");
        }
      }

      ctx.ui.setWidget("notebook-view", lines);
    },
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitor tool calls for Galaxy connection state
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    // Watch for galaxy connect results to update our state
    if (event.toolName === "mcp__galaxy__connect" || event.toolName === "galaxy__connect") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && 'text' in firstContent ? firstContent.text : undefined;
        if (resultText && resultText.includes('"success": true')) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch {
        // Ignore parsing errors
      }
    }

    // Watch for history creation
    if (event.toolName === "mcp__galaxy__create_history" || event.toolName === "galaxy__create_history") {
      try {
        const firstContent = event.content?.[0];
        const resultText = firstContent && 'text' in firstContent ? firstContent.text : undefined;
        if (resultText) {
          const match = resultText.match(/"id":\s*"([^"]+)"/);
          if (match) {
            const state = getState();
            state.currentHistoryId = match[1];
            const plan = getCurrentPlan();
            if (plan) {
              plan.galaxy.historyId = match[1];
            }
          }
        }
      } catch {
        // Ignore parsing errors
      }
    }
  });
}
