/**
 * Eval runner entry point. Discovers scenarios under evals/scenarios/,
 * crosses Tier 2 scenarios with the model matrix in evals/models.json,
 * runs each (scenario × model) cell, evaluates assertions, prints a report,
 * and exits non-zero on any failure.
 *
 * Tier 1 scenarios that don't traverse the matrix run once with model=null.
 *
 * Usage:
 *   npm run evals                       -- run all scenarios × all available models
 *   npm run evals -- <scenario>         -- filter to a single scenario directory
 *   npm run evals -- --model <id>       -- filter to a single model id
 *   npm run evals -- <scenario> --model <id>
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { evaluate } from "./lib/assertions.js";
import { loadDotEnv } from "./lib/env.js";
import { loadMatrix } from "./lib/matrix.js";
import { report } from "./lib/report.js";
import { runScenario } from "./lib/runner.js";
import type { ModelEntry, Scenario, ScenarioRun } from "./lib/types.js";

loadDotEnv();

const __filename = fileURLToPath(import.meta.url);
const evalsDir = path.dirname(__filename);
const scenariosDir = path.join(evalsDir, "scenarios");

interface CliArgs {
  scenarioFilter?: string;
  modelFilter?: string[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const scenarioDirs = discoverScenarios(args.scenarioFilter);
  if (scenarioDirs.length === 0) {
    console.error(
      args.scenarioFilter ? `no scenario matches '${args.scenarioFilter}'` : "no scenarios found",
    );
    process.exit(2);
  }

  const matrix = loadMatrix(args.modelFilter);
  for (const { model, missing } of matrix.skipped) {
    console.warn(`[skip] ${model.id} -- missing env: ${missing.join(", ")}`);
  }

  const runs: ScenarioRun[] = [];
  for (const dir of scenarioDirs) {
    const scenario = readScenario(dir);
    const cells: (ModelEntry | null)[] = scenario.requiresModel ? [...matrix.available] : [null];
    for (const model of cells) {
      const run = await runScenario(dir, model);
      run.failures = evaluate(run);
      runs.push(run);
    }
    if (scenario.requiresModel && matrix.available.length === 0) {
      console.warn(`[skip] ${scenario.name} -- requiresModel but no available models in matrix`);
    }
  }

  const { failed } = report(runs);
  process.exit(failed === 0 ? 0 : 1);
}

function readScenario(dir: string): Scenario {
  return JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf-8")) as Scenario;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      const next = argv[++i];
      if (!next) {
        console.error("--model requires an id (or comma-separated ids)");
        process.exit(2);
      }
      out.modelFilter = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (!a.startsWith("--") && !out.scenarioFilter) {
      out.scenarioFilter = a;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function discoverScenarios(filter: string | undefined): string[] {
  const all = fs
    .readdirSync(scenariosDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(scenariosDir, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "scenario.json")));
  if (!filter) return all;
  return all.filter((dir) => path.basename(dir) === filter);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
