/**
 * Write per-run results to evals/results/<date>-<sha>[-<tag>].jsonl for later
 * model-vs-model and prompt-regression diffing. One JSON object per run.
 * One file is created per date + short SHA (+ tag); re-running on the same
 * commit with the same tag overwrites that file rather than appending.
 * This is a normal Node process -- Date and git are fine to call here.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ScenarioRun } from "./types.js";
import { runUsage } from "./usage.js";

function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "nosha";
  }
}

export function writeResultsJsonl(
  runs: ScenarioRun[],
  outDir: string,
  tag?: string,
): string | null {
  if (runs.length === 0) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  // A tag keeps concurrent runs on one commit (one process per model) from overwriting each other.
  const file = path.join(outDir, `${date}-${gitShortSha()}${tag ? `-${tag}` : ""}.jsonl`);

  const lines = runs.map((r) =>
    JSON.stringify({
      scenario: r.scenario.name,
      modelId: r.model?.id ?? null,
      runIndex: r.runIndex ?? 0,
      exitCode: r.exitCode,
      passed: r.failures.length === 0,
      failedDimensions: [...new Set(r.failures.map((f) => f.dimension ?? "other"))],
      failures: r.failures.map((f) => ({ assertion: f.assertion, detail: f.detail })),
      usage: runUsage(r),
      durationMs: r.durationMs,
    }),
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
