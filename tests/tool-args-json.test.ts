import { afterEach, describe, expect, it, vi } from "vitest";
import { Type, type TSchema } from "@sinclair/typebox";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { coerceJsonStringArgs, withJsonStringArgs } from "../extensions/orbit/tool-args-json";
import { toolFromOperation } from "../extensions/orbit/galaxy-ops-tools";
import { registerProposalCommands } from "../extensions/orbit/proposal-commands";
import { setCapabilityProfile } from "../shared/capability-profile.js";
import { setGalaxyToolSource } from "../extensions/orbit/galaxy-tool-source";

vi.mock("../extensions/orbit/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/config")>()),
  loadConfig: () => ({}),
}));

interface Tool {
  name: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
}

const op = (name: string) => [...allOperations].find((o) => o.name === name)!;

/** What pi does with a call: prepareArguments, then its schema check. */
function validate(tool: Tool, args: Record<string, unknown>) {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return validateToolArguments(tool as never, {
    type: "toolCall",
    id: "c1",
    name: tool.name,
    arguments: prepared as Record<string, unknown>,
  });
}

/** A pi stand-in whose registerTool can be wrapped in place, as the real one can. */
function fakePi() {
  const tools: Tool[] = [];
  const noop = () => undefined;
  const target: Record<string, unknown> = {
    registerTool: (t: Tool) => tools.push(t),
  };
  const pi = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      if (prop === "getAllTools" || prop === "getActiveTools") return () => [];
      if (prop === "events") return { on: noop, emit: noop };
      return noop;
    },
  });
  return { pi: pi as never, tools };
}

describe("coerceJsonStringArgs", () => {
  const schema = Type.Object({
    target: Type.Object({ kind: Type.String(), id: Type.String() }),
    inputs: Type.Array(Type.Object({ slot: Type.String(), n: Type.Optional(Type.Object({})) })),
    note: Type.Optional(Type.String()),
    either: Type.Optional(Type.Union([Type.Object({ a: Type.Number() }), Type.Null()])),
    loose: Type.Optional(Type.Union([Type.String(), Type.Object({})])),
    anything: Type.Optional(Type.Unknown()),
  });

  it("parses JSON text where the schema wants an object or an array", () => {
    const out = coerceJsonStringArgs(schema, {
      target: '{"kind":"tool","id":"cat1"}',
      inputs: '[{"slot":"a"}]',
    });
    expect(out).toEqual({ target: { kind: "tool", id: "cat1" }, inputs: [{ slot: "a" }] });
  });

  it("does the same for plain JSON schema and nullable unions", () => {
    const plain = {
      type: "object",
      properties: {
        inputs: { type: "object" },
        maybe: { type: ["object", "null"] },
        either: { anyOf: [{ type: "object" }, { type: "null" }] },
      },
    };
    expect(
      coerceJsonStringArgs(plain, { inputs: '{"a":1}', maybe: '{"b":2}', either: '{"c":3}' }),
    ).toEqual({ inputs: { a: 1 }, maybe: { b: 2 }, either: { c: 3 } });
    expect(coerceJsonStringArgs(schema, { either: '{"a":1}' })).toEqual({ either: { a: 1 } });
  });

  it("parses array items and recurses into what it parsed", () => {
    expect(
      coerceJsonStringArgs(schema, { inputs: ['{"slot":"a"}', { slot: "b", n: "{}" }] }),
    ).toEqual({ inputs: [{ slot: "a" }, { slot: "b", n: {} }] });
    expect(coerceJsonStringArgs(schema, { inputs: '[{"slot":"a","n":"{}"}]' })).toEqual({
      inputs: [{ slot: "a", n: {} }],
    });
  });

  it("leaves strings the schema accepts, unknowns, bad text and the wrong container alone", () => {
    const args = {
      target: "[1]",
      inputs: "{not json",
      note: '{"a":1}',
      loose: '{"a":1}',
      anything: '{"a":1}',
    };
    expect(coerceJsonStringArgs(schema, args)).toBe(args);
    for (const target of ["5", "null", '"x"', "true"]) {
      const a = { target };
      expect(coerceJsonStringArgs(schema, a)).toBe(a);
    }
  });

  it("returns the same reference when nothing changed and never mutates its input", () => {
    const args = { target: { kind: "tool", id: "x" }, inputs: [{ slot: "a" }] };
    expect(coerceJsonStringArgs(schema, args)).toBe(args);
    const raw = { target: '{"kind":"tool","id":"x"}', inputs: [] };
    const copy = structuredClone(raw);
    coerceJsonStringArgs(schema, raw);
    expect(raw).toEqual(copy);
  });

  it("a value pi still rejects keeps pi's own error", () => {
    const tool = { name: "t", parameters: schema } as Tool;
    expect(() => validate(tool, { target: "[1]", inputs: [] })).toThrow(/target/);
  });
});

describe("withJsonStringArgs", () => {
  it("gives a tool without prepareArguments the coercion", () => {
    const { pi, tools } = fakePi();
    withJsonStringArgs(pi);
    (pi as { registerTool: (t: unknown) => void }).registerTool({
      name: "t",
      parameters: Type.Object({ target: Type.Object({ id: Type.String() }) }),
    });
    expect(validate(tools[0], { target: '{"id":"x"}' })).toEqual({ target: { id: "x" } });
  });

  it("runs the coercion before a tool's own prepareArguments (run_tool, from the llama dump)", () => {
    const { pi, tools } = fakePi();
    withJsonStringArgs(pi);
    (pi as { registerTool: (t: unknown) => void }).registerTool(toolFromOperation(op("run_tool")));
    const args = {
      history_id: "b364f1cd2e205537",
      inputs: '{"input|input_select": "accession_number", "input|accession": "SRR11772204"}',
      tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/sra_tools/fastq_dump",
    };
    const out = validate(tools[0], args) as Record<string, unknown>;
    expect(out.inputs).toEqual({
      "input|input_select": "accession_number",
      "input|accession": "SRR11772204",
    });
  });

  it("validates loom_propose args sent as JSON text (from the llama dump)", () => {
    const { pi, tools } = fakePi();
    withJsonStringArgs(pi);
    registerProposalCommands(pi, {} as never);
    const tool = tools.find((t) => t.name === "loom_propose")!;
    const out = validate(tool, {
      step_anchor: "plan-a-step-1",
      target: '{"kind": "tool", "id": "addValue"}',
      inputs: '[{"slot": "input", "src": "hda", "id": "hist1/dataset_1"}]',
      label: "Add column",
      predicate: '{"kind": "exists_with_ext", "ext": "tabular"}',
      overrides: '[{"param": "value", "value": 7, "rationale": "Add 7 as a new column"}]',
    }) as Record<string, unknown>;
    expect(out.target).toEqual({ kind: "tool", id: "addValue" });
    expect(out.inputs).toEqual([{ slot: "input", src: "hda", id: "hist1/dataset_1" }]);
    expect(out.overrides).toEqual([
      { param: "value", value: 7, rationale: "Add 7 as a new column" },
    ]);
    // predicate is Type.Unknown, so the schema leaves it to parsePredicate.
    expect(out.predicate).toBe('{"kind": "exists_with_ext", "ext": "tabular"}');
  });
});

describe("the extension installs the coercion before any tool registers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setCapabilityProfile(null);
    setGalaxyToolSource(null);
  });

  it("every tool, the in-process Galaxy ones included, has prepareArguments", async () => {
    vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
    vi.stubEnv("GALAXY_API_KEY", "fixture-key");
    const { pi, tools } = fakePi();
    const mod = await import("../extensions/orbit/index");
    mod.default(pi);
    expect(tools.map((t) => t.name)).toContain("run_tool");
    expect(tools.map((t) => t.name)).toContain("loom_propose");
    for (const tool of tools) expect(tool.prepareArguments, tool.name).toBeTypeOf("function");
  });
});
