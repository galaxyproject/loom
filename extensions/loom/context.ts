/**
 * Context injection for Galaxy analysis plans
 *
 * Injects current plan state into the LLM context via the before_agent_start event.
 * Uses tiered injection: compact summary always, full details on demand via tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import {
  getCurrentPlan,
  getState,
  formatPlanSummary,
  getWorkflowSteps,
  getBRCContext,
  getNotebookPath,
} from "./state";
import { loadConfig } from "./config";
import {
  loadSketchCorpus,
  matchSketchesForPlan,
  renderSketchForPrompt,
} from "./sketches";
import { isTeamDispatchEnabled } from "./teams/is-enabled";
import { getRecentActivityEvents } from "./activity";

/**
 * System-prompt block describing team_dispatch usage. Empty string when the
 * experimental flag is off, so default sessions never see the guidance for a
 * tool that isn't registered.
 */
function buildTeamDispatchContext(): string {
  if (!isTeamDispatchEnabled()) return "";
  return `
## Team dispatch (for specialist sub-tasks)

When the user asks for a short-lived specialist team (e.g. "start a team
for literature review — one finds papers, one validates"), call the
\`team_dispatch\` tool. It runs a two-role critic loop (proposer → critic)
and returns the converged output. You — not the team — write to the
plan/notebook; after the tool returns, persist anything useful via the
appropriate existing tool (e.g. \`interpretation_add_finding\`,
\`analysis_plan_log_decision\`).

MVP limitation: team roles have NO tool access. Any external data the
team needs (search results, file contents, notebook excerpts) MUST be
gathered by you first with your own tools, then included verbatim in
the TeamSpec.description before dispatching.

Composing the TeamSpec:
- Exactly two roles. The first proposes; the second critiques.
- The critic must end its turn with a JSON line:
  {"approved": boolean, "critique": string}. The team_dispatch tool
  already injects this instruction into the critic's system preamble —
  you can leave the critic's \`system_prompt\` focused on domain criteria.
- \`max_rounds\` defaults to 5 if omitted.
- \`model\` (per-role or team-wide) is optional; default is the session model.

Confirmation heuristic: if the user's request gives concrete roles, task
framing, and success criteria, dispatch without asking. If the request
is vague (e.g. "use a team"), propose the TeamSpec in chat and ask the
user to approve or edit it first.
`;
}

/**
 * Shared guidance telling the agent how to propose a plan for researcher
 * review. Both the no-active-plan and active-plan system prompts include this
 * block so plan drafts always render consistently in the chat pane.
 */
function planDraftFormatBlock(): string {
  return `## Plan draft format

When proposing a new plan OR a major revision to an existing plan, wrap the
draft in a \`\`\`plan fenced code block. The shell renders fenced plan drafts
as a distinct card so the researcher can review before approving.

Structure inside the fence:
- First line: \`# <plan title>\`
- Optional second paragraph: one- or two-sentence rationale.
- Then a numbered checkbox list of steps, one per line:
  \`- [ ] 1. <step name> — <one-line purpose>\`

After emitting the fenced draft, ask the researcher to approve, edit, or
reject. Do NOT call \`analysis_plan_create\` (or update an existing plan)
until the researcher approves the draft.`;
}

/**
 * Execution-lifecycle guidance shared across system prompts. Covers the
 * mechanics the agent must follow when moving a step through pending →
 * in_progress → completed, including the notebook-checkbox flip that keeps
 * the user-curated notebook in sync with the structured plan state.
 */
function executionLifecycleBlock(): string {
  return `## Plan execution lifecycle

Triggers that start or advance execution:
- User types \`/execute\`, \`/run\`, or \`/test\` (slash commands dispatch here).
- User types natural-language approval ("go", "execute step 2", "run the plan").
- User clicks the Approve button on a plan draft card.

**Before invoking ANY Galaxy tool**, verify Galaxy is connected (the "Galaxy:" line injected at the top of this context). If execution mode is Remote and Galaxy is not connected, **do not silently skip** — instead send one short message asking the user: "Galaxy is not connected. Do you want to connect via \`/connect\`, switch to Local mode in the masthead, or cancel?" Wait for their choice. This rule applies whether execution was triggered by a slash command, an approval button, or natural-language prompt.

For every step:
1. Call \`analysis_plan_update_step\` with \`status: "in_progress"\` before running the work.
2. Run the step (Galaxy tool, local command, workflow invocation — per the step's execution type).
3. On success, call \`analysis_plan_update_step\` with \`status: "completed"\` and include a one-line \`result\` summary.
4. Flip the step's notebook checkbox in \`notebook.md\` from \`- [ ]\` to \`- [x]\` using the Edit tool. Match the step by its id or name; if no matching checkbox exists, skip silently (the notebook is user-curated and may not mirror every step).

Do NOT narrate progress in chat — the Plan and Activity tabs already show it.
If a step fails, set \`status: "failed"\`, write one line in chat explaining what failed, and stop. Do not auto-advance past a failure.`;
}

const NOTEBOOK_EXCERPT_MAX_CHARS = 4000;
const ACTIVITY_TAIL_COUNT = 10;

/**
 * Read the user-curated notebook.md from disk and return a tail-capped excerpt
 * for context injection. We keep the tail because the most recent entries are
 * likeliest to matter for the next turn; older content has already informed
 * earlier turns and typically repeats in the structured plan state.
 */
function buildNotebookExcerptBlock(): string {
  const nbPath = getNotebookPath();
  if (!nbPath) return "";
  let content: string;
  try {
    content = fs.readFileSync(nbPath, "utf-8");
  } catch {
    return "";
  }
  if (!content.trim()) return "";
  let excerpt = content;
  let truncated = false;
  if (excerpt.length > NOTEBOOK_EXCERPT_MAX_CHARS) {
    excerpt = excerpt.slice(-NOTEBOOK_EXCERPT_MAX_CHARS);
    truncated = true;
  }
  return `
## Notebook (user-curated notes)

\`${nbPath}\` — this is the researcher's running log. It is **a plain
markdown file that already exists** (auto-initialized on session start).
Read it for rationale, decisions, and free-form notes that may not be
reflected in the structured plan state.

### When the researcher asks you to "add / append / write something to the notebook"

This request is **exclusively a file-edit operation on \`${nbPath}\`**.
Use the **Edit** (or **Write**) tool to append the content. No other tool
call is needed. The sentence the user wrote — whether it says "datasets",
"samples", "references", "findings", "decisions", "a table", "a summary"
— does not change the workflow: it goes into \`notebook.md\` via Edit.

**Tools you MUST NOT call for notebook writes, even if the user's wording
sounds like it:**

- \`analysis_plan_create\`, \`analysis_plan_add_step\`,
  \`analysis_plan_update_step\`, \`analysis_plan_log_decision\`,
  \`analysis_checkpoint\` — these mutate structured plan state, not the
  notebook file.
- \`analysis_notebook_create\` — legacy tool that requires a plan; the
  notebook file is already auto-initialized and does not need creating.
- \`data_file_add\`, \`data_sample_add\`, \`data_provenance_set\`,
  \`data_provenance_*\` — these register items in the plan's data
  section and write to \`activity.jsonl\`. They do **not** write prose or
  tables into the notebook. If the user asked "add a sample table to the
  notebook", that means **render a markdown table and Edit it into the
  notebook file** — not call \`data_sample_add\`.
- \`interpretation_add_finding\`, \`interpretation_summarize\` — structured
  findings, not notebook prose.
- \`report_result\` — displays a typed block in the Results tab; not a
  substitute for writing into the notebook.

**How to recognize which path the user actually wants:**

- "add X to the notebook" / "write X in the notebook" / "include X in the
  notebook" → **Edit \`${nbPath}\`**. Nothing else.
- "register the samples / files / reference" (no notebook mentioned) →
  structured \`data_*\` tools are fine.
- "record a decision" (no notebook mentioned) → \`analysis_plan_log_decision\`.
- "create a plan" / "draft a plan" → produce a \`\`\`plan\`\`\` fenced draft
  in chat (see Plan draft format), wait for approval.

Create a plan only when the researcher explicitly asks for one or approves
a \`\`\`plan\`\`\` draft (see the Plan draft format / Plan execution
lifecycle sections). Notebook content is independent of plan existence.
If a plan was **auto-restored** from a prior session, you may reference
its status but do not start mutating it unless the user's current message
asks you to.

${truncated ? "_(showing trailing excerpt; earlier content elided)_\n\n" : ""}\`\`\`markdown
${excerpt}
\`\`\`
`;
}

/**
 * Format the last few activity events as a compact list so the agent can pick
 * up continuity across restarts — which step was touched, what was decided,
 * which findings were recorded. Kept small (`ACTIVITY_TAIL_COUNT` items) to
 * stay well under typical context budgets.
 */
function buildRecentActivityBlock(): string {
  const events = getRecentActivityEvents(ACTIVITY_TAIL_COUNT);
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const changeType = (e.payload?.changeType as string) || "";
    const tag = changeType ? `${e.kind}:${changeType}` : e.kind;
    return `- ${e.timestamp} · ${tag}`;
  });
  return `
## Recent activity

Last ${events.length} activity event(s) — use for continuity, not as a source
of truth. Structured state (plan, steps, findings) is authoritative.

${lines.join("\n")}
`;
}

/** Build the execution-mode block injected into every system prompt. */
function buildExecutionModeContext(): string {
  const cfg = loadConfig();
  const mode = cfg.executionMode || "remote";
  const galaxyUrl = process.env.GALAXY_URL || cfg.galaxy?.profiles?.[cfg.galaxy.active || ""]?.url;

  if (mode === "local") {
    return `
## Execution mode: Local

Galaxy MCP tools are not registered in this session. Run work locally using
whatever local execution primitives are available. Plan management, notebook
updates, and non-Galaxy reasoning all still work normally.

If the user wants reproducibility or large-scale compute, suggest switching
to Remote mode in the masthead toggle so Galaxy user-defined tools become
available.
`;
  }

  return `
## Execution mode: Remote (Galaxy: ${galaxyUrl || "configured"})

Both execution paths are available, with a clear default:

- **Preferred: Galaxy user-defined tools.** Search Galaxy first; run real
  computation via \`galaxy_run_tool\` / \`galaxy_invoke_workflow\`.
  Reproducibility and provenance live in Galaxy -- that's why it's the
  default.
- **Local execution** is fine for quick, exploratory, or ad-hoc work that
  doesn't merit a Galaxy tool wrapper. Use it when the user explicitly asks
  or when Galaxy has no equivalent tool.

When a custom step has no Galaxy equivalent but is likely to be reused,
suggest wrapping it as a Galaxy tool rather than leaving it as a one-off
local script.
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
      galaxyContext = `Galaxy: Credentials configured for ${process.env.GALAXY_URL}. Call galaxy_connect() to establish the connection -- do this before calling any other Galaxy tools.`;
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
## Loom Status
No active analysis plan.

**Do not invent a plan proactively.** Plans are only for **multi-step pipeline
orchestration** that the researcher explicitly wants driven — e.g. "run an RNA-seq
analysis", "execute the MRSA workflow", "set up the full pipeline". Most requests are
not that. They are questions, summaries, notebook edits, one-off tool calls,
exploratory lookups — and those should be answered directly with the appropriate
tool or chat response. No plan, no data registration, no notebook creation.

**Only propose a plan** when:
- The researcher explicitly asks for one ("plan this", "draft a plan", "what would the
  steps be"), OR
- The researcher's request unambiguously describes a multi-step executable pipeline
  the agent is expected to orchestrate end-to-end.

When you do propose, draft in chat inside a \`\`\`plan fenced block (see "Plan draft
format" below). Do NOT call \`analysis_plan_create\` yet — wait for explicit approval
("yes", "go", "approve"). On approval, call \`analysis_plan_create\` with the drafted
steps.

For everything else (questions, notebook edits, file reads, explaining data, producing
summaries or tables), respond directly. No plan prerequisite. In particular: if the
user asks you to write/save/add/include anything in the notebook, open \`notebook.md\`
with Edit and append — see the "Notebook (user-curated notes)" section below for the
exhaustive list of tools NOT to call in that case.

${planDraftFormatBlock()}
${brcSection}
${galaxyContext}
${buildExecutionModeContext()}
${buildTeamDispatchContext()}`
      };
    }

    // Active plan - inject summary
    const planSummary = formatPlanSummary(plan);

    // Sketch corpus matching (gxy-sketches analysis scaffolding)
    let sketchSection = "";
    try {
      const cfg = loadConfig();
      if (cfg.sketchCorpusPath) {
        const corpus = loadSketchCorpus(cfg.sketchCorpusPath);
        const matches = matchSketchesForPlan(plan, corpus).slice(0, 2);
        if (matches.length > 0) {
          sketchSection =
            "\n" +
            matches.map((m) => renderSketchForPrompt(m)).join("\n---\n\n") +
            "\n";
        }
      }
    } catch (err) {
      console.warn("[sketches] context injection failed:", err);
    }

    // Workflow guidance if plan has workflow steps
    const workflowSteps = plan.steps.filter(s => s.execution.type === 'workflow');
    const activeInvocations = getWorkflowSteps();
    let workflowContext = '';
    if (workflowSteps.length > 0 || activeInvocations.length > 0) {
      workflowContext = '\n## Workflow Integration\n';
      workflowContext += '- Use `workflow_to_plan` to add Galaxy workflows as plan steps\n';
      workflowContext += '- Use `workflow_invocation_link` after invoking a workflow via Galaxy MCP\n';
      workflowContext += '- Use `workflow_invocation_check` to poll invocation status\n';
      workflowContext += '- Use `workflow_set_overrides` to record per-step parameter deviations from defaults. When invoking via galaxy-mcp `invoke_workflow`, pass the step\'s `parameterOverrides` as the `params` argument so the deviation actually flows to Galaxy.\n';
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

${planDraftFormatBlock()}
${executionLifecycleBlock()}
${buildNotebookExcerptBlock()}
${buildRecentActivityBlock()}
${workflowContext}${brcSection}${sketchSection}
${galaxyContext}
${buildExecutionModeContext()}
${buildTeamDispatchContext()}`
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
      ctx.ui.setStatus("galaxy-plan", "Ready");
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
