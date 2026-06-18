/**
 * Plain-stdout reporter. One line per scenario; per-failure detail when red.
 */

import type { Cell, Dimension, ScenarioRun } from "./types.js";

const DIMENSION_ORDER: Dimension[] = ["validity", "routing", "tools", "behavior", "other"];

/**
 * Markdown grid: rows are models, columns are dimensions, cells aggregate the
 * pass count over total runs across all scenarios that exercised that
 * dimension for that model. "--" when a model never exercised a dimension.
 */
export function renderLeaderboard(cells: Cell[]): string {
  const models = [...new Set(cells.map((c) => c.modelId))].sort();
  const totals = new Map<string, Map<Dimension, { pass: number; total: number }>>();

  for (const cell of cells) {
    const row = totals.get(cell.modelId) ?? new Map<Dimension, { pass: number; total: number }>();
    for (const dim of DIMENSION_ORDER) {
      const d = cell.dimensions[dim];
      if (!d) continue;
      const acc = row.get(dim) ?? { pass: 0, total: 0 };
      acc.pass += d.pass;
      acc.total += d.total;
      row.set(dim, acc);
    }
    totals.set(cell.modelId, row);
  }

  const activeDims = DIMENSION_ORDER.filter((dim) =>
    cells.some((c) => c.dimensions[dim] !== undefined),
  );

  const header = `| model | ${activeDims.join(" | ")} |`;
  const sep = `| --- | ${activeDims.map(() => "---").join(" | ")} |`;
  const rows = models.map((m) => {
    const row = totals.get(m);
    const cellsText = activeDims.map((dim) => {
      const acc = row?.get(dim);
      return acc ? `${acc.pass}/${acc.total}` : "--";
    });
    return `| ${m} | ${cellsText.join(" | ")} |`;
  });

  return ["## Leaderboard (pass / total runs per dimension)", "", header, sep, ...rows].join("\n");
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function report(runs: ScenarioRun[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const run of runs) {
    const ok = run.failures.length === 0;
    if (ok) passed++;
    else failed++;
    const tag = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const ms = `${DIM}(${run.durationMs}ms)${RESET}`;
    const modelTag = run.model ? ` ${DIM}[${run.model.id}]${RESET}` : "";
    console.log(`${tag} ${run.scenario.name}${modelTag} ${ms}`);
    if (!ok) {
      for (const f of run.failures) {
        console.log(`  - ${f.assertion}: ${f.detail}`);
      }
    }
    if ((!ok || process.env.LOOM_EVALS_VERBOSE) && run.notebookContent !== null) {
      console.log(`  --- notebook.md (${run.notebookContent.length} bytes) ---`);
      console.log(indent(run.notebookContent));
      console.log(`  --- end notebook ---`);
    }
    if (!ok && process.env.LOOM_EVALS_VERBOSE) {
      console.log(`  --- stdout (last 500 chars) ---`);
      console.log(`  ${run.stdout.slice(-500).split("\n").join("\n  ")}`);
      if (run.stderr.trim()) {
        console.log(`  --- stderr (last 500 chars) ---`);
        console.log(`  ${run.stderr.slice(-500).split("\n").join("\n  ")}`);
      }
    }
  }
  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  return { passed, failed };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  | ${l}`)
    .join("\n");
}
