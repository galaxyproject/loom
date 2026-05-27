/**
 * Spawn `loom --mode json` against a fixture cwd, capture the JSON event
 * stream, and return the parsed events for assertion.
 *
 * Each scenario gets its own temp directory containing both the agent dir
 * (PI_CODING_AGENT_DIR) and the working directory. This keeps runs isolated
 * from the user's real ~/.pi/agent and ~/.loom config.
 *
 * Tier 2 scenarios (`requiresModel: true`) are run once per available model
 * in evals/models.json. The runner synthesizes a Pi-shaped models.json into
 * the temp agent dir so OpenAI-compatible custom providers (TACC, litellm)
 * become first-class for that one spawn, then passes `--provider` and
 * `--model` to point loom at it.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { writePiModelsConfig } from "./matrix.js";
import type { AnyEvent, ModelEntry, Scenario, ScenarioRun } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const loomBin = path.join(repoRoot, "bin", "loom.js");

export async function runScenario(
  scenarioDir: string,
  model: ModelEntry | null,
): Promise<ScenarioRun> {
  const scenarioPath = path.join(scenarioDir, "scenario.json");
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf-8")) as Scenario;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-eval-"));
  const tmpCwd = path.join(tmpRoot, "cwd");
  const tmpAgentDir = path.join(tmpRoot, ".pi", "agent");
  fs.mkdirSync(tmpCwd);
  fs.mkdirSync(tmpAgentDir, { recursive: true });

  const fixtureCwd = path.join(scenarioDir, "cwd");
  if (fs.existsSync(fixtureCwd)) {
    copyDir(fixtureCwd, tmpCwd);
  }

  if (model) {
    writePiModelsConfig(model, tmpAgentDir);
  }

  const start = Date.now();
  try {
    const result = await spawnLoom(scenario, model, tmpCwd, tmpAgentDir, tmpRoot);
    const events = parseJsonLines(result.stdout);
    const notebookContent = readNotebook(tmpCwd);
    return {
      scenarioDir,
      scenario,
      model,
      exitCode: result.exitCode,
      events,
      stdout: result.stdout,
      stderr: result.stderr,
      notebookContent,
      failures: [],
      durationMs: Date.now() - start,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function readNotebook(cwd: string): string | null {
  const nbPath = path.join(cwd, "notebook.md");
  if (!fs.existsSync(nbPath)) return null;
  try {
    return fs.readFileSync(nbPath, "utf-8");
  } catch {
    return null;
  }
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnLoom(
  scenario: Scenario,
  model: ModelEntry | null,
  cwd: string,
  agentDir: string,
  fakeHome: string,
): Promise<SpawnResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(scenario.env ?? {}),
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LOOM_FRESH_SESSION: "1",
    HOME: fakeHome, // isolates ~/.loom/config.json reads
  };

  const args = ["--mode", "json"];
  if (model) {
    args.push("--provider", model.provider, "--model", model.model);
  }
  for (const arg of scenario.loomArgs ?? []) args.push(arg);
  for (const input of scenario.inputs) args.push(input);

  const timeoutMs = scenario.timeoutMs ?? 15000;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [loomBin, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? -2 : (code ?? -1),
        stdout,
        stderr: stderr + (timedOut ? `\n[runner] timed out after ${timeoutMs}ms\n` : ""),
      });
    });
  });
}

function parseJsonLines(stdout: string): AnyEvent[] {
  const events: AnyEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // non-JSON line (banner, etc.); skip
    }
  }
  return events;
}

function copyDir(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
