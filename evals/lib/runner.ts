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
import type { ActivityEvent, AnyEvent, ModelEntry, Scenario, ScenarioRun } from "./types.js";

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

  const start = Date.now();
  const runId = makeRunId(new Date(start));
  try {
    // Inside the try so a failed config write still hits the cleanup below
    // rather than orphaning the temp dir.
    if (model) {
      writePiModelsConfig(model, tmpAgentDir);
    }
    const result = await spawnLoom(scenario, model, tmpCwd, tmpAgentDir, tmpRoot, runId);
    const events = parseJsonLines(result.stdout);
    const notebookContent = readNotebook(tmpCwd);
    const activityEvents = readActivityLog(tmpCwd);
    dumpRun(scenarioDir, model, runId, tmpCwd, result);
    return {
      scenarioDir,
      scenario,
      model,
      runId,
      exitCode: result.exitCode,
      events,
      stdout: result.stdout,
      stderr: result.stderr,
      notebookContent,
      activityEvents,
      failures: [],
      durationMs: Date.now() - start,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * A per-run token scenarios splice into their prompts as `{{RUN_ID}}`. Live
 * Galaxy scenarios name their histories with it, so concurrent or repeated
 * runs never collide on a name and teardown can tell this run's histories
 * from anything else on a shared server.
 */
export function makeRunId(now: Date, rand: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");
  const suffix = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${stamp}-${suffix}`;
}

export function substituteRunId(input: string, runId: string): string {
  return input.split("{{RUN_ID}}").join(runId);
}

/**
 * Raw transcript of a run, for diagnosing a live failure after the temp dir
 * is gone. Off unless LOOM_EVAL_DUMP_DIR is set; point it somewhere outside
 * the repo, since tool results land in it verbatim.
 */
function dumpRun(
  scenarioDir: string,
  model: ModelEntry | null,
  runId: string,
  cwd: string,
  result: SpawnResult,
): void {
  const dir = process.env.LOOM_EVAL_DUMP_DIR;
  if (!dir) return;
  const base = path.join(
    dir,
    `${path.basename(scenarioDir)}--${(model?.id ?? "none").replace(/[^\w.-]/g, "_")}--${runId}`,
  );
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "stdout.jsonl"), result.stdout);
  fs.writeFileSync(path.join(base, "stderr.txt"), result.stderr);
  for (const name of ["notebook.md", "activity.jsonl"]) {
    const src = path.join(cwd, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(base, name));
  }
}

/**
 * Point uv back at the real cache. The fake HOME would otherwise give every
 * run an empty one, and `uvx galaxy-mcp` would reinstall from PyPI on each
 * spawn -- long enough to blow pi's 10s wait for direct MCP servers before the
 * first prompt, so the model's opening Galaxy calls come back "Tool not found"
 * and the run grades a cold install instead of Loom.
 */
export function uvCacheEnv(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): Record<string, string> {
  return {
    UV_CACHE_DIR:
      env.UV_CACHE_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "uv"),
    UV_PYTHON_INSTALL_DIR:
      env.UV_PYTHON_INSTALL_DIR ??
      path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "uv", "python"),
  };
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

/**
 * The harness's own audit trail, read from the temp cwd before cleanup. In
 * `--mode json` there is no UI, so `ctx.ui.notify` is a no-op and a command
 * that records a decision leaves no trace in the event stream; this file is
 * where it lands. Malformed lines are skipped rather than failing the run,
 * matching how the brain hydrates it.
 */
function readActivityLog(cwd: string): ActivityEvent[] {
  const file = path.join(cwd, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: ActivityEvent[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ActivityEvent);
      } catch {
        // skip
      }
    }
  } catch {
    return out;
  }
  return out;
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
  runId: string,
): Promise<SpawnResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(scenario.env ?? {}),
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LOOM_FRESH_SESSION: "1",
    HOME: fakeHome, // isolates ~/.loom/config.json reads
    ...uvCacheEnv(),
  };

  const args = ["--mode", "json"];
  if (model) {
    args.push("--provider", model.provider, "--model", model.model);
  }
  for (const arg of scenario.loomArgs ?? []) args.push(arg);
  for (const input of scenario.inputs) args.push(substituteRunId(input, runId));

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
