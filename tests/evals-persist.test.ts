import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeResultsJsonl } from "../evals/lib/persist";
import type { ScenarioRun } from "../evals/lib/types";

function run(modelId: string, idx: number): ScenarioRun {
  return {
    scenarioDir: "/tmp/s",
    scenario: { name: "s", tier: 2, requiresModel: true, inputs: ["x"], assertions: {} },
    model: { id: modelId, provider: "p", model: "m" },
    runIndex: idx,
    exitCode: 0,
    events: [{ type: "turn_end", usage: { inputTokens: 10, outputTokens: 5 } }],
    stdout: "",
    stderr: "",
    notebookContent: null,
    failures: [{ assertion: "x", detail: "y", dimension: "routing" }],
    durationMs: 42,
  };
}

describe("evals persist", () => {
  it("writes one JSONL line per run with model, dims, and duration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-persist-"));
    const out = writeResultsJsonl([run("tacc:x", 0), run("tacc:x", 1)], dir);
    expect(out).not.toBeNull();
    const lines = fs.readFileSync(out!, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.modelId).toBe("tacc:x");
    expect(first.scenario).toBe("s");
    expect(first.failedDimensions).toContain("routing");
    expect(typeof first.durationMs).toBe("number");
  });
});
