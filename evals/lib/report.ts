/**
 * Plain-stdout reporter. One line per scenario; per-failure detail when red.
 */

import type { ScenarioRun } from "./types.js";

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
    console.log(`${tag} ${run.scenario.name} ${ms}`);
    if (!ok) {
      for (const f of run.failures) {
        console.log(`  - ${f.assertion}: ${f.detail}`);
      }
      if (process.env.LOOM_EVALS_VERBOSE) {
        console.log(`  --- stdout (last 500 chars) ---`);
        console.log(`  ${run.stdout.slice(-500).split("\n").join("\n  ")}`);
        if (run.stderr.trim()) {
          console.log(`  --- stderr (last 500 chars) ---`);
          console.log(`  ${run.stderr.slice(-500).split("\n").join("\n  ")}`);
        }
      }
    }
  }
  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  return { passed, failed };
}
