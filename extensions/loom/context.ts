/**
 * Context injection for the Loom session.
 *
 * Notebook is the durable record. State is just connection + path. The agent
 * gets the notebook content (tail-capped excerpt + recent activity tail) and
 * Galaxy connection status injected at session start, plus tool-usage
 * guidance for the new markdown-and-invocation-block model.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import { getState, getNotebookPath } from "./state";
import { isTeamDispatchEnabled } from "./teams/is-enabled";
import { getRecentActivityEvents } from "./activity";

const NOTEBOOK_HEAD_MAX_CHARS = 2000;
const NOTEBOOK_TAIL_MAX_CHARS = 4000;
const ACTIVITY_TAIL_COUNT = 10;

/**
 * Read the user-curated notebook.md from disk and return a head + tail
 * excerpt for context injection. Head gives project intent + early plans;
 * tail gives the most recent activity.
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
  if (!content.trim()) {
    return `
## Notebook (project log)

\`${nbPath}\` — empty. The session just started; you'll be writing project
context, plans, and progress notes into this file via Edit/Write.
`;
  }

  let excerpt = content;
  let truncated = false;
  if (content.length > NOTEBOOK_HEAD_MAX_CHARS + NOTEBOOK_TAIL_MAX_CHARS + 100) {
    const head = content.slice(0, NOTEBOOK_HEAD_MAX_CHARS);
    const tail = content.slice(-NOTEBOOK_TAIL_MAX_CHARS);
    excerpt = `${head}\n\n_(... middle elided ...)_\n\n${tail}`;
    truncated = true;
  }

  return `
## Notebook (project log)

\`${nbPath}\` — the durable project record. **Markdown the user (and you)
maintain via Edit/Write tools.** It accumulates over the project's lifetime:
ad-hoc exploration notes, plan sections, executed steps, interpretations,
new plans, and so on.

${truncated ? "_(showing head + tail; middle elided)_\n\n" : ""}\`\`\`markdown
${excerpt}
\`\`\`
`;
}

/**
 * Last few activity events for continuity across restarts.
 */
function buildRecentActivityBlock(): string {
  const events = getRecentActivityEvents(ACTIVITY_TAIL_COUNT);
  if (events.length === 0) return "";
  const lines = events.map((e) => `- ${e.timestamp} · ${e.kind}`);
  return `
## Recent activity

Last ${events.length} event(s):

${lines.join("\n")}
`;
}

/**
 * Galaxy connection status block — replaces the old Local|Remote toggle
 * with agent-side per-plan routing decisions.
 */
function buildGalaxyContextBlock(): string {
  const galaxyUrl = process.env.GALAXY_URL;
  const apiKey = process.env.GALAXY_API_KEY;
  const connected = Boolean(galaxyUrl && apiKey);

  if (!connected) {
    return `
## Galaxy connection: NOT CONNECTED

No Galaxy credentials configured (\`GALAXY_URL\` / \`GALAXY_API_KEY\`).
All execution is local. If the user asks for an analysis that would
benefit from Galaxy-scale compute, suggest connecting via \`/connect\`
once — don't badger.
`;
  }

  return `
## Galaxy connection: ${galaxyUrl}

Galaxy is connected. When drafting a plan, **first** consult Galaxy
resources before deciding what runs where:

1. Search the IWC workflow registry for matching workflows
   (\`galaxy_search_iwc\` / similar Galaxy MCP tool). If a full match
   exists, propose running the plan as a single Galaxy invocation
   (mode: **remote**).
2. Otherwise, draft step-by-step. Per step:
   - Heavy compute (alignment, large variant calling, big assemblies,
     long-running BLAST, etc.) → check Galaxy tool availability
     (\`galaxy_search_tools_by_name\`); if installed, mark step Galaxy.
   - Light/exploratory (parsing, summarization, awk/sed/jq/small
     scripts) → mark step local.
3. Document routing in the plan section header and inline per-step:
   \`## Plan A: chrM Variant Calling [hybrid]\`
   \`Step 3: BWA alignment (Galaxy: bwa-mem2/2.2.1)\`
   \`Step 4: VCF filter (local awk)\`

The three operating modes are an *outcome* of the plan you draft, not a
mode setting:
- **local** — every step runs locally
- **hybrid** — some local, some Galaxy
- **remote** — entire plan is a Galaxy workflow invocation

### Executing a Galaxy step

After invoking via Galaxy MCP and getting an \`invocationId\` back:
1. Call \`galaxy_invocation_record({ invocationId, notebookAnchor, label })\`.
   The \`notebookAnchor\` is a stable id like \`plan-1-step-3\` that
   matches an anchor you wrote in the markdown plan section.
2. Periodically call \`galaxy_invocation_check_all\` to advance in-flight
   invocations. The tool auto-transitions YAML status (all-jobs-ok →
   completed, any-error → failed) and writes results back to the
   notebook. After a transition, edit the markdown checkbox for the step
   from \`- [ ]\` to \`- [x]\` (or \`- [!]\` for failures).
`;
}

/**
 * Local-tool environment convention — per-analysis conda env rooted in
 * the analysis cwd. Always relevant; no longer mode-gated.
 */
function buildLocalEnvContext(): string {
  return `
## Local-tool environment (per-analysis conda env)

When running any bioinformatics tool locally, use a **per-analysis conda
environment** rooted at \`.loom/env/\` inside the current analysis
directory. Isolates tool versions between analyses and keeps each
notebook's reproducibility record self-contained.

Conventions:

- **Env path:** \`.loom/env/\` (prefix style: \`-p .loom/env\`, not \`-n name\`).
- **Channel priority:** \`-c bioconda -c conda-forge\`, in that order.
- **Prefer \`mamba\`** if available (\`which mamba\`) — much faster solves.
  Fall back to \`conda\` if absent. Same flags either way.

Lifecycle (lazy):

1. First tool needed: \`test -d .loom/env\`. If missing:
   \`conda create -p .loom/env -c bioconda -c conda-forge -y python=3.11\`
2. Install in batches: \`conda install -p .loom/env -c bioconda -c conda-forge -y bwa samtools lofreq\`
3. Run via \`conda run -p .loom/env <cmd>\` or full path \`.loom/env/bin/<cmd>\`.
4. Record installs under a \`## Environment\` heading in \`notebook.md\` for
   reproducibility.

If neither conda nor mamba is installed, tell the user once and ask
whether to fall back to system tools (non-reproducible) or abort.

### Bash timeouts on long-running tools

Pi's \`bash\` tool's \`timeout\` is **optional** and in **seconds**. When
omitted, the command runs to completion — correct default for
bioinformatics pipelines whose runtime you cannot reliably predict
(PGGB / assembly / minimap2 / bwa-on-WGS / long variant calling, conda
solves on fresh envs).

**Do not guess-cap at 3600 s.** Real pangenome builds will cross an hour
and be killed partway. When you do need a bound, pick generously: 300 s
for quick commands, 3600 s for short pipelines, 86400 s for overnight.
Prefer **omitting \`timeout\` entirely** over capping too low.
`;
}

/**
 * Plan-section convention block. Plans live as markdown sections, not
 * structured state. This guidance shapes how the agent drafts, reviews,
 * and eventually writes them.
 */
function buildPlanConventionBlock(): string {
  return `## Project model and plan sections

The project is the directory you're working in. \`notebook.md\` is its
durable log — chronological, accumulates over the project's lifetime:
ad-hoc exploration, plan drafts, plan execution, interpretations, new
plans based on interpretations, and so on. Multiple plans coexist.

**Don't propose a plan unless asked.** Most user requests are questions,
explorations, summaries, ad-hoc edits — answer those directly. A plan
is for multi-step pipeline orchestration the user explicitly wants
driven (e.g. "draft a plan for variant calling on this data", "set up
the geographic distribution analysis").

### Plan lifecycle — the four-stage approval gate

When the user **does** ask for a plan, follow this order strictly:

1. **Draft in chat (NOT in the notebook yet).** Reply in chat with a
   fenced markdown block formatted as a plan section (see template
   below). This is a proposal for review. Do not call Edit/Write to
   put it into \`notebook.md\` at this point.
2. **Wait for explicit plan approval.** The user must signal approval
   with words like "yes", "go", "approve", "looks good", "proceed",
   "execute", or by directly asking for parameters. If they request
   changes ("add step 3 for QC", "drop the indel filtering step"),
   revise the draft IN CHAT and ask again. Loop until they approve.
3. **Show the parameter table in chat.** Once the plan structure is
   approved, surface the parameter table for the user to review and
   edit. See the "Parameter review" block below for what to show and
   how to handle edits. Still NOT in the notebook.
4. **Wait for explicit parameters approval.** Same trigger words as
   step 2. Iterate on user edits until they approve.

**Only after both gates pass** do you Edit/Write the plan section
(plan markdown + parameter table) into \`notebook.md\` and begin
execution. Writing earlier pollutes the notebook with proposals the
user may have rejected.

If the user explicitly says "save this plan to the notebook even
though I haven't approved it" or similar, that's a manual override —
honor it and skip the remaining gates.

### Plan section template (used in the chat draft AND the notebook write)

\`\`\`markdown
## Plan A: <Title> [local|hybrid|remote]

<one or two sentences of rationale + research question>

### Steps

- [ ] 1. **<Step name>** {#plan-a-step-1} — <one-line purpose>
       Routing: local | Galaxy: <tool-id>
- [ ] 2. **<Step name>** {#plan-a-step-2} — ...
- ...

### Parameters

| Step | Tool | Parameter | Default | Value | Description |
| --- | --- | --- | --- | --- | --- |
| 1   | ... | ...       | ...     | ...   | ...         |
\`\`\`

Conventions:

- Use \`{#plan-X-step-N}\` anchors so invocation YAML blocks can reference
  individual steps unambiguously.
- Routing tag in the section header: \`[local]\`, \`[hybrid]\`, or
  \`[remote]\`. Tag literal so future tooling can grep.
- Mark step status by editing the checkbox: \`- [ ]\` (pending),
  \`- [x]\` (completed), \`- [!]\` (failed).
- Multiple plans coexist; append new plan sections at the bottom of the
  notebook. Don't delete old plans.
`;
}

/**
 * Parameter review discipline. Issue users hit: agent silently chose a
 * "biology-relevant" subset and hid the rest. Cure: show everything by
 * default; let the user opt into a curated view.
 */
function buildParameterReviewBlock(): string {
  return `## Parameter review

When the user asks to review/show/list parameters for a plan or for a
tool, **show every parameter the tool exposes** — do not silently
filter to a "critical" or "biology-relevant" subset. The user is the
domain expert; let them decide what to ignore.

Format: a single markdown table per tool, columns
\`Parameter | Default | Value | Description\`. \`Value\` mirrors
\`Default\` until the user edits it. Keep \`Description\` to one line.

If the table would be unwieldy (>30 rows for a single tool), still
show all rows — but offer at the end: *"That's the complete set. If
you want a curated view focused on biology-relevant knobs only, say
'show critical only' and I'll filter."* Default = full set.

Editing flow:

- The user edits values inline by saying things like *"set min_qual
  to 30, leave others"* or by pasting an updated table back at you.
- After each edit batch, re-show the table with the new values
  highlighted (e.g. wrap modified values in **bold**) so the user
  can confirm they took.
- When the user approves ("looks good", "go", etc.), proceed to the
  notebook write + execute gate (see Plan lifecycle).

Do not put the parameter table into \`notebook.md\` until the plan
itself has cleared the four-stage approval gate. The chat exchange is
the working surface for parameters; the notebook is the durable
record once everything is settled.
`;
}

/**
 * Notebook-write discipline. The notebook is the source of truth; many
 * user requests boil down to "write this in the notebook."
 */
function buildNotebookWriteBlock(): string {
  const nbPath = getNotebookPath() || "notebook.md";
  return `## Notebook writes

When the user says "add / append / write something to the notebook", or
asks for a summary, table, decision, finding, plan section, or anything
durable — that is **a file edit on \`${nbPath}\`**. Use **Edit** or
**Write**. No structured tool needed; there are no \`analysis_*\` plan
tools anymore.

Free-form chat continues to be fine for clarifying questions, quick
answers, and turn-by-turn dialogue that doesn't need persistence.
`;
}

/**
 * System-prompt block describing team_dispatch usage. Empty when the
 * experimental flag is off so default sessions never see guidance for a
 * tool that isn't registered.
 */
function buildTeamDispatchContext(): string {
  if (!isTeamDispatchEnabled()) return "";
  return `
## Team dispatch (for specialist sub-tasks)

When the user asks for a short-lived specialist team (e.g. "start a team
for literature review — one finds papers, one validates"), call the
\`team_dispatch\` tool. It runs a two-role critic loop (proposer → critic)
and returns the converged output.

MVP limitation: team roles have NO tool access. Any external data the
team needs (search results, file contents, notebook excerpts) MUST be
gathered by you first with your own tools, then included verbatim in
the TeamSpec.description before dispatching.

Composing the TeamSpec:
- Exactly two roles. The first proposes; the second critiques.
- The critic must end its turn with a JSON line:
  \`{"approved": boolean, "critique": string}\`. The team_dispatch tool
  injects this into the critic's system preamble — leave the critic's
  \`system_prompt\` focused on domain criteria.
- \`max_rounds\` defaults to 5 if omitted.
- \`model\` (per-role or team-wide) is optional; default is the session model.

Confirmation heuristic: if the user's request gives concrete roles, task
framing, and success criteria, dispatch without asking. If vague (e.g.
"use a team"), propose the TeamSpec in chat and ask for approval first.
`;
}

export function setupContextInjection(pi: ExtensionAPI): void {

  pi.on("before_agent_start", async (_event, ctx) => {
    const systemPrompt = [
      buildPlanConventionBlock(),
      buildParameterReviewBlock(),
      buildNotebookWriteBlock(),
      buildGalaxyContextBlock(),
      buildLocalEnvContext(),
      buildNotebookExcerptBlock(),
      buildRecentActivityBlock(),
      buildTeamDispatchContext(),
    ]
      .filter(Boolean)
      .join("\n");

    return { systemPrompt };
  });

  // Reflect Galaxy connection state in the status bar after each turn.
  pi.on("turn_end", async (_event, ctx) => {
    const state = getState();
    const galaxyUrl = process.env.GALAXY_URL;
    const apiKey = process.env.GALAXY_API_KEY;
    const connected = Boolean(galaxyUrl && apiKey) || state.galaxyConnected;
    const text = connected ? `🟢 Galaxy: ${galaxyUrl || "connected"}` : "⚪ Local-only";
    ctx.ui.setStatus("galaxy-plan", text);
  });
}

/**
 * Connection status as a list of lines, suitable for /status output.
 */
export function formatConnectionStatus(_ctx: ExtensionContext): string[] {
  const state = getState();
  const galaxyUrl = process.env.GALAXY_URL;
  const apiKey = process.env.GALAXY_API_KEY;
  const connected = Boolean(galaxyUrl && apiKey) || state.galaxyConnected;

  const lines: string[] = [];
  if (connected) {
    lines.push(`🟢 Galaxy: ${galaxyUrl || "connected"}`);
    if (state.currentHistoryId) {
      lines.push(`   History: ${state.currentHistoryId}`);
    }
  } else {
    lines.push("⚪ Galaxy: not connected");
    lines.push("   Use /connect to set up credentials");
  }
  return lines;
}
