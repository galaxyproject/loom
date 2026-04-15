/**
 * Context injection for Galaxy analysis plans
 *
 * Injects current plan state into the LLM context via the before_agent_start event.
 * Uses tiered injection: compact summary always, full details on demand via tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCurrentPlan, getState, formatPlanSummary, getWorkflowSteps, getBRCContext } from "./state";
import { loadConfig } from "./config";

/** Build the execution-mode block injected into every system prompt. */
function buildExecutionModeContext(): string {
  const cfg = loadConfig();
  const mode = cfg.executionMode || "remote";
  const galaxyUrl = process.env.GALAXY_URL || cfg.galaxy?.profiles?.[cfg.galaxy.active || ""]?.url;

  if (mode === "local") {
    return `
## Execution mode: Local (no Galaxy tools)

Galaxy tools are NOT available in this session. This is a planning and review
mode -- the agent can refine the plan, edit the notebook, and reason about
biology, but cannot execute anything until the user switches to Remote mode.

If the user asks you to run something, explain that Local mode is on and they
can switch to Remote in the masthead toggle.
`;
  }

  return `
## Execution mode: Remote (Galaxy: ${galaxyUrl || "configured"})

**Default execution is Galaxy user-defined tools.** Search Galaxy for existing
tools first; prefer \`galaxy_run_tool\` / \`galaxy_invoke_workflow\` for any
real computation. Reproducibility and provenance live in Galaxy -- the agent's
job is to pick the right Galaxy tool, not to re-implement it locally.

If the user explicitly asks for a custom step with no Galaxy equivalent, the
right answer is usually to wrap it as a Galaxy tool, not to run it on the
client. A "run it locally" path is not the default.
`;
}

export function setupContextInjection(pi: ExtensionAPI): void {

  // ─────────────────────────────────────────────────────────────────────────────
  // Inject plan context before agent starts processing
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    const plan = getCurrentPlan();
    const state = getState();

    // Build Galaxy connection context
    const hasCredentials = process.env.GALAXY_URL && process.env.GALAXY_API_KEY;
    let galaxyContext: string;
    if (state.galaxyConnected) {
      galaxyContext = `Galaxy: Connected to ${process.env.GALAXY_URL || 'unknown'}`;
      if (state.currentHistoryId) {
        galaxyContext += `\nCurrent history: ${state.currentHistoryId}`;
      }
    } else if (hasCredentials) {
      galaxyContext = `Galaxy: Credentials available but not yet connected. Call galaxy_connect(url="${process.env.GALAXY_URL}", api_key="${process.env.GALAXY_API_KEY}") NOW — do this on your very first response, before anything else.`;
    } else {
      galaxyContext = 'Galaxy: Not connected. The researcher can use /connect to set up credentials.';
    }

    // Detect BRC MCP server availability
    const brcMcpAvailable = hasBRCMcp(pi);

    if (!plan) {
      // No active plan - provide minimal guidance
      let brcSection = '';
      if (brcMcpAvailable) {
        brcSection = `
## BRC Catalog

A BRC Analytics MCP server is connected with organism, assembly, and workflow
catalog data. Use \`search_organisms\` to find organisms, \`get_compatible_workflows\`
to discover analysis workflows, and \`resolve_workflow_inputs\` to pre-fill
parameters. When the researcher makes selections, record them with \`brc_set_context\`.
`;
      }

      return {
        systemPrompt: `
## gxypi Status
No active analysis plan.

**Start a plan immediately.** As soon as the researcher describes their question or data,
use \`analysis_plan_create\` to create a structured plan. This also creates a persistent
markdown notebook on disk that tracks the full analysis. Don't wait for multiple rounds
of discussion — capture what you know now and refine the plan as you go.

Your first response should gather enough context to create the plan (research question,
data description, expected outcomes), then call \`analysis_plan_create\` in the same turn.
If the researcher's opening message already contains this information, create the plan
right away without asking clarifying questions first.
${brcSection}
${galaxyContext}
${buildExecutionModeContext()}
`
      };
    }

    // Active plan - inject summary
    const planSummary = formatPlanSummary(plan);

    // Workflow guidance if plan has workflow steps
    const workflowSteps = plan.steps.filter(s => s.execution.type === 'workflow');
    const activeInvocations = getWorkflowSteps();
    let workflowContext = '';
    if (workflowSteps.length > 0 || activeInvocations.length > 0) {
      workflowContext = '\n## Workflow Integration\n';
      workflowContext += '- Use `workflow_to_plan` to add Galaxy workflows as plan steps\n';
      workflowContext += '- Use `workflow_invocation_link` after invoking a workflow via Galaxy MCP\n';
      workflowContext += '- Use `workflow_invocation_check` to poll invocation status\n';
      if (activeInvocations.length > 0) {
        workflowContext += `\n**${activeInvocations.length} active workflow invocation(s)** — check status with \`workflow_invocation_check\`\n`;
      }
    }

    // BRC context section
    let brcSection = '';
    if (brcMcpAvailable) {
      const brcCtx = getBRCContext();
      if (brcCtx && (brcCtx.organism || brcCtx.assembly || brcCtx.workflowIwcId)) {
        const parts: string[] = [];
        if (brcCtx.organism) parts.push(`Organism: ${brcCtx.organism.species} (${brcCtx.organism.taxonomyId})`);
        if (brcCtx.assembly) parts.push(`Assembly: ${brcCtx.assembly.accession}`);
        if (brcCtx.workflowName) parts.push(`Workflow: ${brcCtx.workflowName}`);
        brcSection = `\n## BRC Context\n\n${parts.join('\n')}\nUse \`brc_set_context\` to update if selections change.\n`;
      } else {
        brcSection = `\n## BRC Catalog\n\nBRC catalog tools are available. If the researcher is working with a cataloged\norganism, use BRC tools to find compatible workflows and resolve inputs.\n`;
      }
    }

    return {
      systemPrompt: `
## Current Analysis Plan

${planSummary}

## Analysis Protocol
- Get researcher approval before each step
- Log decisions with \`analysis_step_log\`
- Update step status with \`analysis_plan_update_step\`
- Create QC checkpoints with \`analysis_checkpoint\`
- Record biological findings with \`interpretation_add_finding\`
- Use \`analysis_plan_get\` for full plan details
- Use \`report_result\` for tables, plots, files, and markdown summaries
- Use \`analyze_plan_parameters\` when the user requests parameter review

## Execution Rules
- Default tool execution is Galaxy user-defined tools. Search Galaxy for existing tools first.
- DO NOT narrate plan execution in chat. The shell renders progress from structured events.
- Use tools — NOT chat prose — to communicate during execution:
  - \`analysis_plan_update_step\` → step progress (visible in the DAG)
  - \`report_result\` → output tables, plots, files (visible in Results tab)
- Chat is for questions, conclusions, and user-visible reasoning only.
- After calling \`analysis_plan_create\`, do NOT write a plan summary in chat — the Plan tab already shows it.

## Response Style
- Be extremely concise. No filler, no chatter, no pleasantries.
- Lead with the answer or action. Skip preamble and transitions.
- One sentence when one sentence suffices. Never repeat what the user said.
- Do NOT use exclamation marks, "Great!", "Excellent!", "Sure!", or similar.
- Minimize emoji usage. Plain text is preferred.
${workflowContext}${brcSection}
${galaxyContext}
${buildExecutionModeContext()}
`
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Update status bar after each turn
  // ─────────────────────────────────────────────────────────────────────────────
  pi.on("turn_end", async (_event, ctx) => {
    const plan = getCurrentPlan();

    if (plan) {
      const currentStep = plan.steps.find(s => s.status === 'in_progress');
      const completed = plan.steps.filter(s => s.status === 'completed').length;
      const total = plan.steps.length;

      const statusText = [
        `📋 ${plan.title}`,
        `[${completed}/${total}]`,
        currentStep ? `→ ${currentStep.name}` : plan.status === 'draft' ? '(draft)' : '',
      ].filter(Boolean).join(' ');

      ctx.ui.setStatus("galaxy-plan", statusText);
    } else {
      ctx.ui.setStatus("galaxy-plan", "🔬 gxypi ready");
    }
  });
}

/**
 * Check if the BRC Analytics MCP server is available.
 * Looks for the search_organisms tool in the active tool list,
 * falling back to the BRC_MCP_AVAILABLE env var.
 */
function hasBRCMcp(pi: ExtensionAPI): boolean {
  try {
    const tools = pi.getAllTools();
    if (Array.isArray(tools) && tools.some((t: any) => t.name === 'search_organisms' || t === 'search_organisms')) {
      return true;
    }
  } catch {
    // getAllTools may not be available in all contexts
  }
  return process.env.BRC_MCP_AVAILABLE === '1';
}

/**
 * Format connection status for display
 */
export function formatConnectionStatus(ctx: ExtensionContext): string[] {
  const state = getState();
  const lines: string[] = [];

  if (state.galaxyConnected) {
    lines.push("🟢 Connected to Galaxy");
    if (state.currentHistoryId) {
      lines.push(`   History: ${state.currentHistoryId}`);
    }
  } else {
    lines.push("⚪ Not connected to Galaxy");
    lines.push("   Use galaxy_connect to connect");
  }

  return lines;
}
