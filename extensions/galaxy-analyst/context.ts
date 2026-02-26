/**
 * Context injection for Galaxy analysis plans
 *
 * Injects current plan state into the LLM context via the before_agent_start event.
 * Uses tiered injection: compact summary always, full details on demand via tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCurrentPlan, getState, formatPlanSummary } from "./state";

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

    if (!plan) {
      // No active plan - provide minimal guidance
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

${galaxyContext}
`
      };
    }

    // Active plan - inject summary
    const planSummary = formatPlanSummary(plan);

    return {
      systemPrompt: `
## Current Analysis Plan

${planSummary}

## Analysis Protocol Reminders
- Get researcher approval before each step
- Log decisions with \`analysis_step_log\`
- Update step status with \`analysis_plan_update_step\`
- Create QC checkpoints with \`analysis_checkpoint\`
- Record biological findings with \`interpretation_add_finding\`
- Use \`analysis_plan_get\` for full plan details

${galaxyContext}
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
