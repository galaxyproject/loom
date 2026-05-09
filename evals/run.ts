/**
 * Eval runner entry point. Discovers scenarios under evals/scenarios/,
 * runs each, evaluates assertions, prints a report, and exits non-zero
 * on any failure.
 *
 * Usage:
 *   npm run evals               -- run all scenarios
 *   npm run evals -- <name>     -- run a single scenario by directory name
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { evaluate } from "./lib/assertions.js";
import { report } from "./lib/report.js";
import { runScenario } from "./lib/runner.js";

const __filename = fileURLToPath(import.meta.url);
const evalsDir = path.dirname(__filename);
const scenariosDir = path.join(evalsDir, "scenarios");

async function main() {
  const filter = process.argv[2];
  const scenarioDirs = discoverScenarios(filter);
  if (scenarioDirs.length === 0) {
    console.error(filter ? `no scenario matches '${filter}'` : "no scenarios found");
    process.exit(2);
  }

  const runs = [];
  for (const dir of scenarioDirs) {
    const run = await runScenario(dir);
    run.failures = evaluate(run);
    runs.push(run);
  }

  const { failed } = report(runs);
  process.exit(failed === 0 ? 0 : 1);
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
