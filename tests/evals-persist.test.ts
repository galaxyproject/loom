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
    // pi's real shape: usage rides on the assistant message, one turn_end per model call.
    events: [
      {
        type: "turn_end",
        message: {
          role: "assistant",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 20,
            totalTokens: 135,
            cost: { total: 0.01 },
          },
        },
        toolResults: [],
      },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          usage: {
            input: 3,
            output: 7,
            cacheRead: 120,
            cacheWrite: 0,
            totalTokens: 130,
            cost: { total: 0.02 },
          },
        },
        toolResults: [],
      },
    ],
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
    expect(first.usage).toEqual({
      calls: 2,
      errors: 0,
      input: 13,
      output: 12,
      cacheRead: 220,
      cacheWrite: 20,
      totalTokens: 265,
      cost: 0.03,
    });
  });

  it("a tag gives concurrent runs on one commit their own file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-persist-"));
    const a = writeResultsJsonl([run("tacc:a", 0)], dir, "a");
    const b = writeResultsJsonl([run("tacc:b", 0)], dir, "b");
    expect(a).not.toBe(b);
    expect(path.basename(a!)).toMatch(/-a\.jsonl$/);
    expect(fs.readFileSync(a!, "utf-8")).toContain("tacc:a");
    expect(fs.readFileSync(b!, "utf-8")).toContain("tacc:b");
  });
});
