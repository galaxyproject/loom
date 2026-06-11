/**
 * `/cost` table construction (issue #263).
 *
 * `/cost` used to inject a prompt asking the agent to append the cost table to
 * notebook.md, so it made 2-3 full-context model round-trips just to display a
 * table the renderer had already computed from its own usage counters. These
 * pure helpers move the table construction out of the agent's hands: the
 * default `/cost` builds the markdown locally (zero model calls), and only the
 * opt-in "append to notebook" action uses the model.
 *
 * Kept DOM-free so the table construction is unit-testable on its own.
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Resolve a model's cost from its usage, or null when the model is unpriced. */
export type ComputeCost = (u: Usage, model: string) => number | null;

export interface CostBreakdown {
  /** Markdown table: one row per model plus a totals row. */
  table: string;
  /** Sum of the known per-model costs (excludes unpriced models). */
  grandCost: number;
  /** False when at least one model had no pricing entry. */
  totalCostKnown: boolean;
}

/**
 * Build the session cost breakdown purely from the renderer's per-model usage
 * counters. `computeCost` is injected so this stays independent of the
 * renderer's PRICING map (and trivially testable).
 */
export function buildCostBreakdown(
  perModelUsage: Iterable<[string, Usage]>,
  computeCost: ComputeCost,
): CostBreakdown {
  const rows: string[] = [];
  let totalCostKnown = true;
  let grandCost = 0;
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const [model, u] of perModelUsage) {
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    const cost = computeCost(u, model);
    const costStr = cost === null ? "unknown (no pricing entry)" : `$${cost.toFixed(4)}`;
    if (cost === null) totalCostKnown = false;
    else grandCost += cost;
    rows.push(
      `| \`${model}\` | ${u.input.toLocaleString()} | ${u.output.toLocaleString()} | ` +
        `${u.cacheRead.toLocaleString()} | ${u.cacheWrite.toLocaleString()} | ${costStr} |`,
    );
  }

  const totalCostStr = totalCostKnown
    ? `$${grandCost.toFixed(4)}`
    : `≥$${grandCost.toFixed(4)} (some models unpriced)`;
  rows.push(
    `| **Total** | **${totals.input.toLocaleString()}** | **${totals.output.toLocaleString()}** | ` +
      `**${totals.cacheRead.toLocaleString()}** | **${totals.cacheWrite.toLocaleString()}** | **${totalCostStr}** |`,
  );

  const table =
    `| Model | Input tokens | Output tokens | Cache read | Cache write | Cost (USD) |\n` +
    `|-------|-------------:|--------------:|-----------:|------------:|-----------:|\n` +
    rows.join("\n");

  return { table, grandCost, totalCostKnown };
}

export type CostCommandAction = { kind: "empty" } | ({ kind: "table" } & CostBreakdown);

/**
 * Resolve the `/cost` command to a local-render action. Returns `empty` when no
 * billable turns have been recorded, otherwise a `table` action carrying the
 * breakdown. This never makes a model call — the only collaborator is the
 * injected `computeCost`.
 */
export function resolveCostCommand(
  perModelUsage: Map<string, Usage>,
  computeCost: ComputeCost,
): CostCommandAction {
  if (perModelUsage.size === 0) return { kind: "empty" };
  return { kind: "table", ...buildCostBreakdown(perModelUsage, computeCost) };
}

/** Heading the cost table is filed under in the notebook. */
export const COST_HEADING = "## Session cost";

/** Shown when `/cost` runs before any billable assistant turn. */
export const NO_USAGE_MESSAGE =
  "No billable assistant turns recorded yet in this renderer session.";

/**
 * The renderer surface `runCostCommand` drives. Kept abstract so the command
 * orchestration is testable without a DOM — the test asserts the default path
 * never reaches `promptAgent`, which is the regression #263 is about.
 */
export interface CostCommandView {
  /** Echo the `/cost` command into the chat log. */
  addUserMessage(text: string): void;
  /** Report that there's nothing to show yet. */
  addErrorMessage(text: string): void;
  /** Render the breakdown locally and wire `onAppend` to the opt-in button. */
  renderBreakdown(table: string, onAppend: () => void): void;
  /** Surface the "asking the agent…" notice + thinking state for the append. */
  beginNotebookAppend(): void;
  /** Send a prompt to the agent — the only model-call path in `/cost`. */
  promptAgent(message: string): void;
}

/**
 * Orchestrate `/cost`: echo the command, then either report "no usage" or
 * render the breakdown locally. The only `promptAgent` call is behind the
 * opt-in append action, so the default path provably makes no model call.
 */
export function runCostCommand(
  raw: string,
  perModelUsage: Map<string, Usage>,
  computeCost: ComputeCost,
  view: CostCommandView,
): void {
  view.addUserMessage(raw);

  const action = resolveCostCommand(perModelUsage, computeCost);
  if (action.kind === "empty") {
    view.addErrorMessage(NO_USAGE_MESSAGE);
    return;
  }

  view.renderBreakdown(action.table, () => {
    view.beginNotebookAppend();
    view.promptAgent(buildCostAppendPrompt(action.table));
  });
}

/**
 * Prompt for the opt-in "append to notebook" action: hand the agent the table
 * that was already rendered in chat and ask it to append verbatim. This is the
 * only `/cost` path that costs a model call, and the user opts into it.
 */
export function buildCostAppendPrompt(table: string): string {
  return (
    `Append the following session cost breakdown verbatim to the notebook file ` +
    `(notebook.md) in the current working directory. Use Edit or Write to append — ` +
    `do NOT regenerate, reformat, or wrap the table. The numbers below are authoritative ` +
    `(captured from the renderer's usage counters, same source as the masthead), so ` +
    `use them as-is.\n\n` +
    `Use exactly this heading (H2, verbatim) on its own line, followed by a blank line, ` +
    `then the table:\n` +
    `    ${COST_HEADING}\n\n` +
    `--- Cost table ---\n` +
    table +
    `\n--- end table ---`
  );
}
