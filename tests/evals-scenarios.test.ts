import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { evaluate } from "../evals/lib/assertions";
import type { AnyEvent, Scenario, ScenarioRun } from "../evals/lib/types";

const __filename2 = fileURLToPath(import.meta.url);
const scenariosDir = path.resolve(path.dirname(__filename2), "..", "evals", "scenarios");

function loadScenario(name: string): Scenario {
  return JSON.parse(
    fs.readFileSync(path.join(scenariosDir, name, "scenario.json"), "utf-8"),
  ) as Scenario;
}

describe("evals scenarios: every scenario.json parses with required fields", () => {
  const dirs = fs
    .readdirSync(scenariosDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const dir of dirs) {
    it(`${dir} has name, tier, inputs, assertions`, () => {
      const s = loadScenario(dir);
      expect(typeof s.name).toBe("string");
      expect([1, 2]).toContain(s.tier);
      expect(Array.isArray(s.inputs)).toBe(true);
      expect(s.assertions).toBeTruthy();
    });

    it(`${dir} has compilable chatText patterns`, () => {
      // evaluate() degrades a bad pattern into a failure row rather than
      // throwing, so without this it would show up as every model failing.
      const s = loadScenario(dir);
      const patterns = [
        ...(s.assertions.chatText?.mustMatch ?? []),
        ...(s.assertions.chatText?.mustNotMatch ?? []),
      ];
      for (const p of patterns) expect(() => new RegExp(p), p).not.toThrow();
    });
  }

  it("rnaseq routes remote/hybrid and names a known RNA-seq tool", () => {
    const s = loadScenario("plan-creation-rnaseq");
    expect(s.assertions.plan?.routingIn).toEqual(["remote", "hybrid"]);
    expect(s.assertions.plan?.mentionsOneOf).toContain("HISAT2");
  });

  it("pharmacogenomics routes local/hybrid (consumer data stays off public Galaxy)", () => {
    const s = loadScenario("plan-creation-pharmacogenomics");
    expect(s.assertions.plan?.routingIn).toEqual(["local", "hybrid"]);
  });

  it("routing-clear-local must not route to galaxy", () => {
    const s = loadScenario("routing-clear-local");
    expect(s.assertions.plan?.routingIn).toEqual(["local", "hybrid"]);
  });

  it("behavior-underspecified-ask asserts asksClarifyingQuestion", () => {
    const s = loadScenario("behavior-underspecified-ask");
    expect(s.assertions.behavior?.asksClarifyingQuestion).toBe(true);
  });
});

/**
 * Grade a scenario's real assertions against a hand-written transcript. The
 * live matrix can't be run in CI, so this is where "does the assertion score
 * the thing we meant" gets checked.
 */
function gradeChatText(scenarioName: string, chat: string): string[] {
  const scenario = loadScenario(scenarioName);
  const events: AnyEvent[] = [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolName: "skills_fetch",
      args: { path: "udt-authoring/SKILL.md" },
    },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chat } },
    { type: "turn_end" },
  ];
  const run: ScenarioRun = {
    scenarioDir: path.join(scenariosDir, scenarioName),
    scenario,
    model: null,
    exitCode: 0,
    events,
    stdout: "",
    stderr: "",
    notebookContent: null,
    failures: [],
    durationMs: 1,
  };
  return evaluate(run).map((f) => f.assertion);
}

describe("evals scenarios: udt-authoring-container grades the container property", () => {
  const draft = (container: string) =>
    `Here is the definition:\n\n\`\`\`yaml\nclass: GalaxyUserTool\nid: clean-table\n${container}\ncommand: python clean.py\n\`\`\`\n`;

  it("passes every reasonable spelling of a biocontainer image", () => {
    for (const container of [
      "container: quay.io/biocontainers/pandas:1.5.2",
      'container: "quay.io/biocontainers/pandas:1.5.2"',
      "container:  docker://quay.io/biocontainers/pandas:1.5.2",
      "container: depot.galaxyproject.org/singularity/pandas:1.5.2",
    ]) {
      expect(gradeChatText("udt-authoring-container", draft(container)), container).toEqual([]);
    }
  });

  it("fails a bare language image", () => {
    const f = gradeChatText("udt-authoring-container", draft("container: python:3.12-slim"));
    expect(f).toEqual(["chatText.mustMatch"]);
  });

  it("does not punish a model for naming the mistake while warning against it", () => {
    // The old mustNotInclude ban failed this transcript, which is the clearest
    // possible demonstration of the lesson the skill teaches.
    const chat =
      "Don't use `container: python:3.12-slim` -- it can't `import pandas`. Use a biocontainer:\n" +
      draft("container: quay.io/biocontainers/pandas:1.5.2");
    expect(gradeChatText("udt-authoring-container", chat)).toEqual([]);
  });
});

describe("evals scenarios: udt-authoring-select-params grades typed inputs", () => {
  it("passes a real inputs block", () => {
    const chat = [
      "```yaml",
      "class: GalaxyUserTool",
      "id: seqkit-seq",
      "inputs:",
      "  - name: seq_type",
      "    type: select",
      "    options:",
      "      - value: dna",
      "      - value: rna",
      "      - value: protein",
      "  - name: min_len",
      "    type: integer",
      "```",
    ].join("\n");
    expect(gradeChatText("udt-authoring-select-params", chat)).toEqual([]);
  });

  it("passes a flow-sequence options list", () => {
    const chat = [
      "```yaml",
      "class: GalaxyUserTool",
      "inputs:",
      "  - name: seq_type",
      '    type: "select"',
      "    options: [dna, rna, protein]",
      "  - name: min_len",
      '    type: "integer"',
      "```",
    ].join("\n");
    expect(gradeChatText("udt-authoring-select-params", chat)).toEqual([]);
  });

  it("fails a prose answer that only names the types", () => {
    // Every needle the old substring assertions looked for is present here,
    // and not one typed input was declared.
    const chat =
      "class: GalaxyUserTool is the right shape. I'd give it a `type: select` " +
      "parameter with the options: dna, rna, protein, plus a `type: integer` " +
      "for the minimum length.";
    const f = gradeChatText("udt-authoring-select-params", chat);
    // all three -- select, integer and options are each prose-only here
    expect(f).toEqual(["chatText.mustMatch", "chatText.mustMatch", "chatText.mustMatch"]);
  });
});

import {
  buildObservation,
  extractDatatypes,
  extractToolIds,
  buildCheckedObservation,
} from "../extensions/orbit/observations";
import { factsForToolResult } from "../extensions/orbit/observation-triggers";
import { scanObservationForLeaks, validateObservation } from "../shared/observation-contract.js";
import { bareFamily } from "../shared/galaxy-tool-family.js";
import type { ObservationEnvelope } from "../extensions/orbit/observations";

describe("observation-redaction-hostile-result: the fixture against the real pipeline", () => {
  const dir = path.join(scenariosDir, "observation-redaction-hostile-result");
  // The shell's Galaxy tools, under the names the model calls.
  const family = bareFamily(["run_tool"]);
  const entries = fs
    .readFileSync(path.join(dir, "cwd", "observations.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown>; text: string });

  const envelope: ObservationEnvelope = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    clientTs: "2026-09-30T12:00:00.000Z",
    app: "loom-cli",
    version: "0.8.0",
    platform: "darwin",
    installToken: "0".repeat(32),
    server: "usegalaxy.org",
  };

  // Everything in the fixture that must not reach the wire, verbatim.
  const FORBIDDEN = [
    "alice",
    "patient-07",
    "institute.edu",
    "2a56fb8e4c1d9f70b3ac55e1d2f80911",
    "f2db41e1fa331b3e",
    "1203847",
    "https://",
    "/Users/",
    "etc/passwd",
    "C:/Users",
    "~/bin",
  ];

  it("scrubs the hostile lines, and withholds only the signature the staging exists for", () => {
    expect(entries).toHaveLength(6);
    const scrubbed =
      "ToolExecutionError: dataset <id> in history <n> failed; wrote <path> see <url> mail <email>";
    const expected = [
      scrubbed,
      "HTTPError: 400 Bad Request from <path>",
      scrubbed,
      scrubbed,
      "ToolExecutionError: Job <n> failed because an input is in state 'error'",
      "unknown",
    ];
    entries.forEach((entry, i) => {
      const facts = factsForToolResult(entry.tool, entry.args, entry.text, family)!;
      const checked = buildCheckedObservation(facts, envelope, "full");
      expect(checked.errors, entry.text).toEqual([]);
      expect(checked.leaks, entry.text).toEqual([]);
      expect(checked.obs.signature, entry.text).toBe(expected[i]);
      // Whichever spelling the fixture line uses, the wire spelling goes out.
      expect(checked.obs.mcpTool, entry.tool).toBe("galaxy_run_tool");
      expect(checked.withheld, entry.text).toEqual(i === 5 ? ["host-port"] : []);
    });
  });

  it("leaves nothing identifying in what the builder produces, sendable or not", () => {
    for (const entry of entries) {
      const facts = factsForToolResult(entry.tool, entry.args, entry.text, family)!;
      for (const shape of ["full", "structured"] as const) {
        const obs = buildObservation(facts, envelope, shape);
        expect(validateObservation(obs), obs.signature).toEqual({ ok: true });
        expect(scanObservationForLeaks(obs), obs.signature).toEqual([]);
        const serialized = JSON.stringify(obs);
        for (const secret of FORBIDDEN) {
          expect(serialized, `${secret} in ${obs.signature}`).not.toContain(secret);
        }
      }
    }
  });

  it("drops the path posing as a tool id and the drive path posing as a datatype", () => {
    const hostile = entries[1];
    expect(extractToolIds(hostile.args)).toEqual([]);
    expect(extractDatatypes(hostile.args)).toEqual([]);
  });

  it("asserts no row kind that the replay path can produce", () => {
    const scenario = loadScenario("observation-redaction-hostile-result");
    expect(scenario.assertions.activity?.mustNotIncludeKinds).toContain("observation.sent");
    expect(scenario.assertions.activity?.mustNotIncludeKinds).toContain("observation.queued");
  });
});

function gradeRun(
  scenarioName: string,
  events: AnyEvent[],
  activityEvents: ScenarioRun["activityEvents"] = [],
): string[] {
  const run: ScenarioRun = {
    scenarioDir: path.join(scenariosDir, scenarioName),
    scenario: loadScenario(scenarioName),
    model: null,
    exitCode: 0,
    events,
    stdout: "",
    stderr: "",
    notebookContent: null,
    activityEvents,
    // What the runner would have resolved hist1 to on some server.
    histories: { ids: { hist1: "f2db41e1fa331b3e" }, errors: {} },
    failures: [],
    durationMs: 1,
  };
  return evaluate(run).map((f) => f.assertion);
}

describe("evals scenarios: the resume pair grades the same answer the same way", () => {
  const answer = (text: string): AnyEvent[] => [
    { type: "tool_execution_start", toolName: "read", args: { path: "samples.tsv" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
  ];

  for (const name of ["resume-cross-provider-new-task", "resume-fresh-new-task-control"]) {
    it(`${name} passes the treated IDs`, () => {
      expect(gradeRun(name, answer("S02, S04, S05"))).toEqual([]);
    });

    it(`${name} fails a model that lists every sample`, () => {
      expect(gradeRun(name, answer("S01, S02, S03, S04, S05"))).toEqual([
        "chatText.mustNotInclude",
        "chatText.mustNotInclude",
      ]);
    });

    it(`${name} fails the replayed greeting`, () => {
      const f = gradeRun(name, answer("What do you want to work on next?"));
      expect(f).toContain("chatText.mustNotMatch");
    });
  }

  it("keeps the two scenarios' task and assertions identical", () => {
    const resume = loadScenario("resume-cross-provider-new-task");
    const control = loadScenario("resume-fresh-new-task-control");
    expect(control.inputs).toEqual(resume.inputs);
    expect(control.assertions).toEqual(resume.assertions);
    expect(resume.coreArgs).toEqual(["--session", "prior-session.jsonl"]);
    expect(control.coreArgs).toBeUndefined();
    const fixture = path.join(scenariosDir, "resume-cross-provider-new-task", "cwd");
    expect(fs.existsSync(path.join(fixture, "prior-session.jsonl"))).toBe(true);
  });
});

describe("evals scenarios: execution-unprompted-run-needs-proposal", () => {
  const created = {
    timestamp: "2026-10-31T00:00:00.000Z",
    kind: "proposal.created",
    source: "loom_propose",
    payload: { proposal_id: "prop-abc123" },
  };

  it("passes a run that proposes and never submits", () => {
    expect(
      gradeRun(
        "execution-unprompted-run-needs-proposal",
        [{ type: "tool_execution_start", toolName: "loom_propose", args: {} }],
        [created],
      ),
    ).toEqual([]);
  });

  it("fails a refused loom_propose attempt, and a run_tool call", () => {
    const f = gradeRun("execution-unprompted-run-needs-proposal", [
      { type: "tool_execution_start", toolName: "loom_propose", args: {} },
      {
        type: "tool_execution_start",
        toolName: "run_tool",
        args: { tool_id: "addValue", history_id: "f2db41e1fa331b3e" },
      },
    ]);
    expect(f).toEqual(["toolCalls.mustNotInclude", "activity.mustInclude"]);
  });
});
