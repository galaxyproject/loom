/**
 * gxypi - Galaxy co-scientist extension for Pi.dev
 *
 * Provides plan-based analysis orchestration for Galaxy bioinformatics workflows.
 * Manages analysis state, registers custom tools, and injects context.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { registerPlanTools } from "./tools";
import { setupContextInjection } from "./context";
import { setupUIBridge } from "./ui-bridge";
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
  // UI bridge: structured plan events for shell consumers
  // ─────────────────────────────────────────────────────────────────────────────
  setupUIBridge(pi);

  // ─────────────────────────────────────────────────────────────────────────────
  // Session initialization
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Collapse tool output by default so the user sees compact summaries
    // instead of raw MCP calls and full JSON responses
    ctx.ui.setToolsExpanded(false);

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

    // Populate sidebar tabs immediately
    await refreshSidebar(ctx);

    // Skip the initial LLM greeting on --continue restarts (model switch,
    // preferences save, mode toggle): chat history is already restored and
    // the user already saw the previous greeting; a new one would be redundant.
    if (process.argv.includes("--continue")) {
      return;
    }

    // Kick off an initial LLM turn with a proper greeting
    const plan = getCurrentPlan();
    const hasCredentials = process.env.GALAXY_URL && process.env.GALAXY_API_KEY;

    const connectInstr = hasCredentials
      ? ` Call galaxy_connect(url="${process.env.GALAXY_URL}", api_key="${process.env.GALAXY_API_KEY}") in this response.` +
        ` ONLY call galaxy_connect — do NOT call any other Galaxy tools (no get_tool_panel, no get_server_info, no search_tools, etc.).`
      : "";

    if (plan) {
      // Existing analysis — recap it with richer context
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      const current = plan.steps.find(s => s.status === 'in_progress');
      const lastDecision = plan.decisions.length > 0
        ? plan.decisions[plan.decisions.length - 1]
        : null;
      const pendingReviews = plan.checkpoints.filter(c => c.status === 'needs_review');
      const nextPending = plan.steps.find(s => s.status === 'pending');

      let recapExtra = '';
      if (lastDecision) {
        recapExtra += ` Last decision: "${lastDecision.description}" (${lastDecision.type.replace(/_/g, ' ')}).`;
      }
      if (pendingReviews.length > 0) {
        recapExtra += ` There are ${pendingReviews.length} QC checkpoint(s) awaiting review.`;
      }
      if (nextPending && !current) {
        recapExtra += ` Suggested next action: start step "${nextPending.name}".`;
      }

      pi.sendUserMessage(
        `Session started with an existing analysis plan loaded: "${plan.title}" (${completed}/${plan.steps.length} steps complete` +
        `${current ? `, currently on: ${current.name}` : ""}).${recapExtra}` +
        ` Give a brief welcome, then recap where we left off — what's been done, what's next, and any open questions. ` +
        `Keep it concise (a short paragraph, not a bulleted list).${connectInstr}`
      );
    } else if (hasCredentials) {
      // Fresh session with Galaxy credentials
      pi.sendUserMessage(
        `Session started, no existing analysis in this directory. ` +
        `Give a brief welcome to gxypi, then ask what I'd like to work on — what research question or data do I have? ` +
        `Keep the greeting to 2-3 sentences.${connectInstr}`
      );
    } else {
      // Fresh session, no credentials
      pi.sendUserMessage(
        `Session started, no existing analysis in this directory and no Galaxy server configured. ` +
        `Give a brief welcome to gxypi, mention I can use /connect to set up a Galaxy server, ` +
        `and ask what I'd like to work on. Keep it to 2-3 sentences.`
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Sidebar refresh: push current state to all widget tabs
  // ─────────────────────────────────────────────────────────────────────────────
  async function refreshSidebar(ctx: ExtensionContext) {
    const plan = getCurrentPlan();
    const state = getState();

    // -- Status tab --
    const statusLines: string[] = ["🔬 gxypi Status", ""];
    if (state.galaxyConnected) {
      statusLines.push("✅ Connected to Galaxy");
      if (process.env.GALAXY_URL) statusLines.push(`   Server: ${process.env.GALAXY_URL}`);
      if (state.currentHistoryId) statusLines.push(`   History: ${state.currentHistoryId}`);
    } else {
      statusLines.push("⚪ Not connected to Galaxy");
      statusLines.push("   Use /connect or ask to connect");
    }
    statusLines.push("");
    if (plan) {
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      const current = plan.steps.find(s => s.status === 'in_progress');
      statusLines.push(`📋 Plan: ${plan.title}`);
      statusLines.push(`   Status: ${plan.status}`);
      statusLines.push(`   Progress: ${completed}/${plan.steps.length} steps`);
      if (current) statusLines.push(`   Current: ${current.name}`);
    } else {
      statusLines.push("📋 No active plan");
      statusLines.push("   Start by describing your analysis");
    }
    statusLines.push("");
    const notebookPath = getNotebookPath();
    if (notebookPath) {
      statusLines.push(`📓 Notebook: ${notebookPath}`);
    } else {
      statusLines.push("📓 No notebook (in-memory only)");
    }
    ctx.ui.setWidget("status-view", statusLines);

    // -- Plan tab --
    if (plan) {
      const phaseLabels: Record<string, string> = {
        problem_definition: 'Problem Definition',
        data_acquisition: 'Data Acquisition',
        analysis: 'Analysis',
        interpretation: 'Interpretation',
        publication: 'Publication',
      };
      const phaseOrder = ['problem_definition', 'data_acquisition', 'analysis', 'interpretation', 'publication'];
      const phaseIdx = phaseOrder.indexOf(plan.phase);
      const planLines: string[] = [];
      planLines.push(`📋 ${plan.title} [${plan.status}]`);
      planLines.push(`   ${plan.context.researchQuestion.slice(0, 60)}${plan.context.researchQuestion.length > 60 ? '...' : ''}`);
      planLines.push('');
      const phaseBar = phaseOrder.map((p, i) => {
        if (i < phaseIdx) return '●';
        if (i === phaseIdx) return '◉';
        return '○';
      }).join('─');
      planLines.push(`   Phase: ${phaseBar}  ${phaseLabels[plan.phase] || plan.phase}`);
      planLines.push('');
      for (const step of plan.steps) {
        const icon = { pending: '⬜', in_progress: '🔄', completed: '✅', skipped: '⏭️', failed: '❌' }[step.status];
        let extra = '';
        if (step.result?.completedAt) {
          extra = ` (${timeSince(step.result.completedAt)} ago)`;
        }
        planLines.push(`   ${icon} ${step.id}. ${step.name}${extra}`);
      }
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      planLines.push('');
      planLines.push(`   Progress: ${completed}/${plan.steps.length} steps completed`);
      planLines.push(`   Decisions: ${plan.decisions.length} logged`);
      planLines.push(`   Checkpoints: ${plan.checkpoints.length}`);
      ctx.ui.setWidget("plan-view", planLines);
    } else {
      ctx.ui.setWidget("plan-view", ["No active plan.", "", "Describe your analysis to get started."]);
    }

    // -- Decisions tab --
    if (plan && plan.decisions.length > 0) {
      const decLines: string[] = ["📝 Decision Log", ""];
      const recent = plan.decisions.slice(-10);
      for (const d of recent) {
        const date = new Date(d.timestamp).toLocaleString();
        const stepInfo = d.stepId ? ` (Step ${d.stepId})` : '';
        const approved = d.researcherApproved ? '✓' : '?';
        decLines.push(`[${d.type}]${stepInfo} ${approved}`);
        decLines.push(`  ${d.description.slice(0, 70)}${d.description.length > 70 ? '...' : ''}`);
        decLines.push(`  ${date}`);
        decLines.push('');
      }
      ctx.ui.setWidget("decisions-view", decLines);
    } else {
      ctx.ui.setWidget("decisions-view", ["No decisions logged yet."]);
    }

    // -- Notebook tab --
    if (notebookPath && plan) {
      const nbLines: string[] = [];
      nbLines.push(`📓 ${plan.title}`);
      nbLines.push(`   Path: ${notebookPath}`);
      nbLines.push(`   Status: ${plan.status}`);
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      nbLines.push(`   Progress: ${completed}/${plan.steps.length} steps`);
      nbLines.push("");
      nbLines.push("Sections:");
      nbLines.push("  - Research Context");
      if (plan.dataProvenance) nbLines.push("  - Data Provenance");
      nbLines.push("  - Analysis Plan");
      if (plan.interpretation) nbLines.push("  - Interpretation");
      nbLines.push("  - Execution Log");
      nbLines.push("  - Galaxy References");
      if (plan.publication) nbLines.push("  - Publication Materials");
      ctx.ui.setWidget("notebook-view", nbLines);
    } else {
      const nbLines: string[] = ["No notebook loaded."];
      try {
        const cwd = process.cwd();
        const notebooks = await findNotebooks(cwd);
        if (notebooks.length > 0) {
          nbLines.push("");
          nbLines.push(`Found ${notebooks.length} notebook(s):`);
          for (const nb of notebooks) {
            nbLines.push(`  📄 ${nb.title} (${nb.completedSteps}/${nb.stepCount}, ${nb.status})`);
          }
        }
      } catch {}
      ctx.ui.setWidget("notebook-view", nbLines);
    }

    // -- Profiles tab --
    const { profiles, active } = loadProfiles();
    const names = Object.keys(profiles);
    if (names.length > 0) {
      const profLines: string[] = ["Galaxy Server Profiles", ""];
      for (const name of names) {
        const marker = name === active ? "*" : " ";
        profLines.push(`  ${marker} ${name} (${profiles[name].url})`);
      }
      ctx.ui.setWidget("profiles-view", profLines);
    } else {
      ctx.ui.setWidget("profiles-view", ["No saved profiles.", "", "Use /connect to add a Galaxy server."]);
    }
  }

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

      const phaseLabels: Record<string, string> = {
        problem_definition: 'Problem Definition',
        data_acquisition: 'Data Acquisition',
        analysis: 'Analysis',
        interpretation: 'Interpretation',
        publication: 'Publication',
      };

      const phaseOrder = ['problem_definition', 'data_acquisition', 'analysis', 'interpretation', 'publication'];
      const phaseIdx = phaseOrder.indexOf(plan.phase);

      // Build summary display
      const lines: string[] = [];
      lines.push(`📋 ${plan.title} [${plan.status}]`);
      lines.push(`   ${plan.context.researchQuestion.slice(0, 60)}${plan.context.researchQuestion.length > 60 ? '...' : ''}`);
      lines.push('');

      // Phase progress
      const phaseBar = phaseOrder.map((p, i) => {
        if (i < phaseIdx) return '●';
        if (i === phaseIdx) return '◉';
        return '○';
      }).join('─');
      lines.push(`   Phase: ${phaseBar}  ${phaseLabels[plan.phase] || plan.phase}`);
      lines.push('');

      // Steps with completion info
      for (const step of plan.steps) {
        const icon = {
          'pending': '⬜',
          'in_progress': '🔄',
          'completed': '✅',
          'skipped': '⏭️',
          'failed': '❌',
        }[step.status];
        let extra = '';
        if (step.result?.completedAt) {
          const elapsed = timeSince(step.result.completedAt);
          extra = ` (${elapsed} ago)`;
        }
        lines.push(`   ${icon} ${step.id}. ${step.name}${extra}`);
      }

      // Stats
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      lines.push('');
      lines.push(`   Progress: ${completed}/${plan.steps.length} steps completed`);
      lines.push(`   Decisions: ${plan.decisions.length} logged`);
      lines.push(`   Checkpoints: ${plan.checkpoints.length}`);

      // Last QC checkpoint
      const lastCp = [...plan.checkpoints].reverse().find(c => c.status !== 'pending');
      if (lastCp) {
        const cpIcon = lastCp.status === 'passed' ? '✅' : lastCp.status === 'failed' ? '❌' : '⚠️';
        lines.push(`   Last QC: ${cpIcon} ${lastCp.name} (${lastCp.status.replace('_', ' ')})`);
      }

      // Pending decisions (not yet approved)
      const pendingDecisions = plan.decisions.filter(d => !d.researcherApproved);
      if (pendingDecisions.length > 0) {
        lines.push(`   ⚠️  ${pendingDecisions.length} decision(s) pending approval`);
      }

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

      // After switching profiles, reload extensions so the session_start
      // handler auto-connects with the new credentials. Falls back to
      // sendUserMessage if reload() isn't available.
      async function reloadOrMessage(url: string) {
        if (typeof ctx.reload === 'function') {
          await ctx.reload();
        } else {
          pi.sendUserMessage(
            `Please connect to Galaxy at ${url} using the API key from environment variables.`
          );
        }
      }

      // /connect <name> — switch to a named profile
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
          await reloadOrMessage(profiles[name].url);
          return;
        }
        // Fall through to "add new server" flow below
      } else if (profileNames.length === 1 && active && process.env.GALAXY_URL && process.env.GALAXY_API_KEY) {
        // One profile, already active — just connect
        ctx.ui.notify(`Connecting to ${profiles[active].url}...`, "info");
        await reloadOrMessage(profiles[active].url);
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
      await reloadOrMessage(galaxyUrl);
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
        // Clear after a brief display
        setTimeout(() => ctx.ui.setStatus("galaxy-tool", ""), 3000);
      } else {
        ctx.ui.setStatus("galaxy-tool", "");
      }
    }

    // Track galaxy_connect success
    if (event.toolName === "galaxy_connect" && !event.isError) {
      try {
        const resultText = typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result);
        if (resultText.includes('"success": true') || resultText.includes('success')) {
          const state = getState();
          state.galaxyConnected = true;
        }
      } catch {
        // Ignore parsing errors
      }
    }

    // Track history creation
    if (event.toolName === "galaxy_create_history" && !event.isError) {
      try {
        const resultText = typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result);
        const match = resultText.match(/"id":\s*"([^"]+)"/);
        if (match) {
          const state = getState();
          state.currentHistoryId = match[1];
          const plan = getCurrentPlan();
          if (plan) {
            plan.galaxy.historyId = match[1];
          }
        }
      } catch {
        // Ignore parsing errors
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitor tool calls for Galaxy connection state (fallback for tool_result)
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    // Watch for galaxy connect results to update our state
    if (event.toolName === "galaxy_connect") {
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
    if (event.toolName === "galaxy_create_history") {
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Refresh sidebar after every turn so widgets stay current
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("turn_end", async (_event, ctx) => {
    await refreshSidebar(ctx);
  });
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
