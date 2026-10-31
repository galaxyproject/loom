/**
 * The Tier-1 submission-capture scenarios, graded in-process: each scenario's recorded results go
 * through the real replay seam with the shell's Galaxy tools registered, and the scenario's own
 * activity and notebook assertions grade what lands. The runner does the same through a spawned
 * `orbit --mode json`; this is the copy that runs with the suite, so a fixture spelled in names no
 * shell offers fails here rather than only in a manual eval run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evaluate } from "../evals/lib/assertions";
import type { ActivityEvent, Scenario } from "../evals/lib/types";
import { registerSubmissionReplay } from "../extensions/orbit/submission-replay";
import { resetSubmissionCapture } from "../extensions/orbit/galaxy-submission-capture";
import { registerGalaxyTools, setGalaxyToolSource } from "../extensions/orbit/galaxy-tool-source";
import { resetState, setNotebookPath } from "../extensions/orbit/state";

const SCENARIOS = path.resolve(__dirname, "..", "evals", "scenarios");

const replayScenarios = fs
  .readdirSync(SCENARIOS)
  .filter((name) => name.startsWith("submission-capture-"))
  .map((name) => ({
    name,
    scenario: JSON.parse(
      fs.readFileSync(path.join(SCENARIOS, name, "scenario.json"), "utf-8"),
    ) as Scenario,
  }))
  .filter(({ scenario }) => scenario.env?.ORBIT_SUBMISSION_REPLAY);

let tmp: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  resetState();
  resetSubmissionCapture();
  setGalaxyToolSource(null);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function replay(name: string, scenario: Scenario) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-tier1-"));
  fs.cpSync(path.join(SCENARIOS, name, "cwd"), tmp, { recursive: true });
  const nb = path.join(tmp, "notebook.md");
  if (!fs.existsSync(nb)) fs.writeFileSync(nb, "# Analysis\n", "utf-8");
  // Credentials stay empty: the replay must not need a Galaxy, and none is reachable here.
  for (const [k, v] of Object.entries(scenario.env ?? {}))
    vi.stubEnv(k, k.startsWith("GALAXY_") ? "" : v);
  setNotebookPath(nb);
  registerGalaxyTools({ registerTool: () => {} } as never);
  const handlers: ((event: unknown, ctx: unknown) => Promise<unknown>)[] = [];
  registerSubmissionReplay({
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (event === "session_start") handlers.push(handler);
    },
  } as never);
  for (const h of handlers) await h({ type: "session_start" }, {});
  const activity = path.join(tmp, "activity.jsonl");
  const activityEvents = fs.existsSync(activity)
    ? fs
        .readFileSync(activity, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ActivityEvent)
    : [];
  return evaluate({
    scenarioDir: path.join(SCENARIOS, name),
    scenario,
    model: null,
    exitCode: 0,
    events: [],
    stdout: "",
    stderr: "",
    notebookContent: fs.readFileSync(nb, "utf-8"),
    activityEvents,
    failures: [],
    durationMs: 0,
  });
}

describe("Tier-1 submission fixtures under the bare Galaxy tools", () => {
  it("finds the scenarios", () => {
    expect(replayScenarios.length).toBeGreaterThanOrEqual(4);
  });

  for (const { name, scenario } of replayScenarios) {
    it(`${name} passes its own assertions`, async () => {
      expect(await replay(name, scenario)).toEqual([]);
    });
  }
});
