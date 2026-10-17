import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Type } from "@sinclair/typebox";
import {
  allOperations,
  describeOperation,
  spellParamNames,
  type AnyOperation,
} from "@galaxyproject/galaxy-ops";
import {
  createGalaxyOpsToolSource,
  galaxyOpsEntry,
  galaxyReadOutputTool,
  parseInput,
  renderOperation,
  snake,
  toolFromOperation,
} from "../extensions/loom/galaxy-ops-tools";
import { setGalaxyTransport } from "../extensions/loom/galaxy-api";
import {
  createMemoryOutputStore,
  galaxyOutputStore,
  setGalaxyOutputStore,
} from "../extensions/loom/galaxy-output-store";
import {
  galaxyToolFamily,
  registerGalaxyTools,
  registeredGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/loom/galaxy-tool-source";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

const ROOT = join(__dirname, "..");
// galaxy-ops' own zod (4.x): root resolves zod 3, which renders these fields wrongly.
const { z } = createRequire(join(ROOT, "node_modules/@galaxyproject/galaxy-ops/package.json"))(
  "zod",
) as typeof import("zod/v4");

// A snapshot: the array is shared with the browser entry and must not be read live later.
const OPS: AnyOperation[] = [...allOperations];
const op = (name: string) => OPS.find((o) => o.name === name)!;
const field = (o: AnyOperation, key: string) =>
  (o.input as Record<string, { description?: string }>)[key];

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

function hasKindSymbol(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Object.getOwnPropertySymbols(value).includes(TYPEBOX_KIND)) return true;
  return Object.values(value).some(hasKindSymbol);
}

const CREDENTIALS = () => ({ url: "https://galaxy.test", apiKey: "k" });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  setGalaxyTransport(null);
  setGalaxyOutputStore(null);
  setGalaxyToolSource(null);
  setCapabilityProfile(null);
});

describe("rendered operations", () => {
  it("covers every operation of the Node entry", () => {
    expect(OPS).toHaveLength(45);
    expect(galaxyOpsEntry()).toEqual({ operations: OPS.map((o) => o.name), hasUploadFile: true });
  });

  it.each(OPS.map((o) => [o.name, o] as const))(
    "%s: parameters equal galaxy-ops' zod rendering, snake-cased",
    (_name, o) => {
      const { $schema: _dialect, ...reference } = z.toJSONSchema(z.strictObject(o.input), {
        io: "input",
      }) as Record<string, unknown> & {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const expected = {
        ...reference,
        properties: Object.fromEntries(
          Object.entries(reference.properties ?? {}).map(([k, v]) => [snake(k), v]),
        ),
        ...(reference.required ? { required: reference.required.map(snake) } : {}),
      };
      const tool = toolFromOperation(o);
      expect(tool.parameters).toEqual(expected);
      expect(renderOperation(o).parameters).toEqual(expected);
      // pi coerces nested values in a schema without TypeBox's Kind, as it did for MCP tools.
      expect(hasKindSymbol(tool.parameters)).toBe(false);
    },
  );

  it("describes every tool and parameter in galaxy-ops' own words, none empty", () => {
    for (const o of OPS) {
      const tool = toolFromOperation(o);
      expect(tool.description).toBe(spellParamNames(describeOperation(o), o.input, snake));
      expect(tool.description.trim()).not.toBe("");
      const properties = (
        tool.parameters as { properties: Record<string, { description?: string }> }
      ).properties;
      for (const key of Object.keys(o.input)) {
        const said = properties[snake(key)].description;
        expect(said, `${o.name}.${key}`).toBe(field(o, key).description);
        expect(said?.trim(), `${o.name}.${key}`).toBeTruthy();
      }
    }
  });

  it("hides upload_file and takes annotations from the operation", () => {
    for (const o of OPS) {
      const tool = toolFromOperation(o);
      expect(tool.exposure, o.name).toBe(o.name === "upload_file" ? "hidden" : "direct");
      expect(tool.annotations).toEqual({
        readOnlyHint: o.readOnly !== false,
        destructiveHint: o.destructive === true,
      });
      expect(tool.namespace?.name).toBe("galaxy");
      expect(tool.label).toBe(o.name);
    }
    const destructive = OPS.filter((o) => toolFromOperation(o).annotations?.destructiveHint);
    expect(destructive.map((o) => o.name).sort()).toEqual([
      "cancel_workflow_invocation",
      "delete_user_tool",
    ]);
  });
});

/** A valid value for a required parameter, so validation reaches the parameter under test. */
function filler(schema: { type?: unknown }): unknown {
  if (schema.type === "object") return {};
  if (schema.type === "array") return ["x"];
  if (schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  return "x";
}

function kindOf(schema: Record<string, unknown>): "integer" | "boolean" | undefined {
  const types = [
    schema.type,
    ...((schema.anyOf as { type?: unknown }[] | undefined) ?? []).map((s) => s.type),
  ].flat();
  if (types.includes("integer")) return "integer";
  if (types.includes("boolean")) return "boolean";
  return undefined;
}

describe("lax arguments", () => {
  const cases = OPS.flatMap((o) => {
    const { properties, required = [] } = renderOperation(o).parameters;
    return Object.entries(properties).flatMap(([key, schema]) => {
      const kind = kindOf(schema);
      return kind ? [{ o, key, kind, properties, required }] : [];
    });
  });

  it("finds the integer and boolean parameters to check", () => {
    expect(cases.filter((c) => c.kind === "integer").length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.kind === "boolean").length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [`${c.o.name}.${c.key}`, c] as const))(
    "%s accepts strings the way pydantic does",
    (_label, { o, key, kind, properties, required }) => {
      const tool = toolFromOperation(o);
      const base = Object.fromEntries(
        required.filter((r) => r !== key).map((r) => [r, filler(properties[r])]),
      );
      const samples: [unknown, unknown][] =
        kind === "integer"
          ? [["5", 5]]
          : [
              ["true", true],
              ["yes", true],
              ["no", false],
            ];
      for (const [sent, expected] of samples) {
        const prepared = tool.prepareArguments!({ ...base, [key]: sent });
        const validated = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          { type: "toolCall", id: "call-1", name: tool.name, arguments: prepared },
        );
        expect(validated[key]).toBe(expected);
      }
    },
  );
});

describe("parseInput", () => {
  it("fills zod defaults for absent fields and leaves present ones parsed", () => {
    const parsed = parseInput(op("get_history_contents"), { historyId: "abc", limit: 7 });
    expect(parsed).toEqual({
      ok: true,
      input: {
        historyId: "abc",
        limit: 7,
        offset: 0,
        deleted: false,
        visible: true,
        order: "hid-asc",
      },
    });
  });

  it("refuses a value the field rejects, naming the wire key", () => {
    const parsed = parseInput(op("create_history"), { historyName: "" });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(
      /^Invalid arguments for create_history: history_name: /,
    );
  });

  it("passes unknown keys through and leaves a missing required key to Galaxy", () => {
    expect(parseInput(op("get_dataset_details"), { extra: 1 })).toMatchObject({
      ok: true,
      input: { extra: 1 },
    });
  });
});

describe("running an operation", () => {
  function recordFetch(reply: (url: string) => Response = () => json({})) {
    const seen: { method: string; url: string }[] = [];
    setGalaxyTransport({
      credentials: CREDENTIALS,
      fetch: async (url, init) => {
        seen.push({ method: init.method ?? "GET", url });
        return reply(url);
      },
    });
    return seen;
  }

  it("sends a zod default the model left out, under the operation's own key", async () => {
    const seen = recordFetch(() => json([]));
    const tool = toolFromOperation(op("get_history_contents"));
    const result = await tool.execute(
      "c1",
      { history_id: "f00d" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(false);
    expect(new URL(seen.at(-1)!.url).pathname).toBe("/api/histories/f00d/contents");
    expect(result.structuredContent.pagination).toMatchObject({ limit: 100, offset: 0 });
    expect(result.details.galaxy).toMatchObject({ tool: "get_history_contents" });
    expect(result.details.galaxy.outputId).toBeUndefined();
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  });

  it("hands run the parsed input, defaults filled", async () => {
    // get_history_contents defaults its own limit inside run, so only a probe op can show what
    // run was handed.
    recordFetch();
    let given: unknown;
    const probe = {
      name: "probe_defaults",
      domain: "histories",
      summary: "Probe.",
      input: {
        historyId: z.string(),
        limit: z.number().int().default(100),
        view: z.string().default("collection"),
      },
      run: async (i: unknown) => {
        given = i;
        return [];
      },
    } as unknown as AnyOperation;
    const result = await toolFromOperation(probe).execute(
      "c1",
      { history_id: "f00d" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).toBe(false);
    expect(given).toEqual({ historyId: "f00d", limit: 100, view: "collection" });
  });

  it("answers an invalid argument with a validation envelope and no request", async () => {
    const seen = recordFetch();
    const tool = toolFromOperation(op("create_history"));
    const result = await tool.execute(
      "c1",
      { history_name: "" },
      undefined,
      undefined,
      {} as never,
    );
    expect(seen).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
    expect(result.details.galaxy.kind).toBeNull();
  });

  it("runs a policy's check, around and refused hooks", async () => {
    const seen = recordFetch((url) =>
      url.includes("/contents") ? json({ err_msg: "nope" }, 400) : json([]),
    );
    const refused = createGalaxyOpsToolSource({
      policies: { get_history_contents: { check: async () => "Read the history first." } },
    })
      .tools()
      .find((t) => t.name === "get_history_contents")!;
    const out = await refused.execute(
      "c1",
      { history_id: "f00d" },
      undefined,
      undefined,
      {} as never,
    );
    expect(seen).toEqual([]);
    expect(out.structuredContent).toMatchObject({
      success: false,
      message: "Read the history first.",
      errorKind: "validation",
    });

    const sent: unknown[] = [];
    const rewritten = toolFromOperation(op("get_history_contents"), {
      policy: {
        around: (call, args) => {
          sent.push(args);
          return call({ ...args, history_id: "beef" });
        },
        refused: (message) => `Policy says: ${message}`,
      },
    });
    const res = await rewritten.execute(
      "c2",
      { history_id: "f00d" },
      undefined,
      undefined,
      {} as never,
    );
    expect(sent).toEqual([{ history_id: "f00d" }]);
    expect(new URL(seen.at(-1)!.url).pathname).toBe("/api/histories/beef/contents");
    expect(res.isError).toBe(true);
    expect(res.structuredContent.message).toMatch(/^Policy says: /);
  });
});

describe("the default source", () => {
  const bare = () => setCapabilityProfile({ ...profileFromEnv({}), galaxyTools: "bare" });
  const stub = (name: string): GalaxyTool => ({
    name,
    label: name,
    description: `stub ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
  });

  it("registers every operation and the job bridges, then galaxy_read_output outside the family", () => {
    bare();
    const registerTool = vi.fn();
    const family = registerGalaxyTools({ registerTool } as unknown as ExtensionAPI);
    const names = registerTool.mock.calls.map(([t]) => t.name);
    expect(names).toEqual([
      ...OPS.map((o) => o.name),
      "list_jobs",
      "get_job_logs",
      "galaxy_read_output",
    ]);
    expect(names).toHaveLength(48);
    expect(family.toolName("run_tool")).toBe("run_tool");
    expect(family.toolName("galaxy_read_output")).toBeUndefined();
    expect(galaxyToolFamily()).toBe(family);
    expect(registeredGalaxyTools().map((t) => t.name)).toEqual(names);
  });

  it("appends extras unchanged", () => {
    const extra = stub("lineage_probe");
    const tools = createGalaxyOpsToolSource({ extras: [extra] }).tools();
    expect(tools.at(-1)).toBe(extra);
    expect(tools).toHaveLength(48);
  });

  // Every tool starts with galaxy-ops' own line for its operation; the three a bridge widens say
  // what the bridge adds after it.
  it("describes each tool in galaxy-ops' words, a widened one with its bridge's sentence after", () => {
    const tools = new Map(
      createGalaxyOpsToolSource()
        .tools()
        .map((t) => [t.name, t]),
    );
    const widened = ["get_job_details", "get_page", "update_page"];
    for (const o of OPS) {
      const said = spellParamNames(describeOperation(o), o.input, snake);
      const description = tools.get(o.name)!.description;
      if (widened.includes(o.name)) {
        expect(description.startsWith(`${said} `), o.name).toBe(true);
        expect(description.length, o.name).toBeGreaterThan(said.length + 1);
      } else {
        expect(description, o.name).toBe(said);
        expect(tools.get(o.name)!.parameters, o.name).toEqual(renderOperation(o).parameters);
      }
    }
    for (const name of ["list_jobs", "get_job_logs"]) {
      expect(tools.get(name)!.description.trim(), name).not.toBe("");
      expect(tools.get(name)!.description, name).not.toMatch(/MCP/);
    }
  });

  it("refuses an extra the entry already has", () => {
    bare();
    setGalaxyToolSource(createGalaxyOpsToolSource({ extras: [stub("upload_file")] }));
    expect(() => registerGalaxyTools({ registerTool: vi.fn() } as unknown as ExtensionAPI)).toThrow(
      "[galaxy-tools] two Galaxy tools are named upload_file",
    );
  });
});

describe("galaxy_read_output", () => {
  const read = (args: Record<string, unknown>) =>
    galaxyReadOutputTool().execute("r1", args, undefined, undefined, {} as never);

  function userTools(count: number) {
    return {
      data: Array.from({ length: count }, (_, i) => ({
        id: `encoded-tool-${i}`,
        uuid: `user-tool-uuid-${i}`,
        tool_id: "example_tool",
        tool_format: "GalaxyUserTool",
        active: true,
        hidden: false,
        representation: {
          class: "GalaxyUserTool",
          name: i === count - 1 ? "ChronAeon validator" : `Example tool ${i}`,
          version: `1.${i}.0`,
          container: "example.invalid/python:3.11",
          shell_command: "private command body; ".repeat(50),
        },
      })),
      success: true,
      message: "Retrieved user-defined tools",
      count,
      pagination: null,
    };
  }

  it("reads a pointer and a query from a saved envelope", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `dataset ${i}` }));
    const id = galaxyOutputStore().put(
      JSON.stringify({ data: rows, success: true }),
      "get_history_contents",
    );
    const one = JSON.parse((await read({ outputId: id, pointer: "/data/3" })).content[0].text);
    expect(JSON.stringify(one)).toContain("dataset 3");
    const found = JSON.parse((await read({ outputId: id, query: "dataset 17" })).content[0].text);
    expect(JSON.stringify(found)).toContain("/data/17");
  });

  it("summarises a saved user-tool catalog", async () => {
    const id = galaxyOutputStore().put(JSON.stringify(userTools(30)), "list_user_tools");
    const page = JSON.parse((await read({ outputId: id })).content[0].text);
    expect(page.type).toBe("user_tool_catalog");
    expect(JSON.stringify(page)).not.toContain("private command body");
    const hit = JSON.parse((await read({ outputId: id, query: "chronaeon" })).content[0].text);
    expect(hit.totalItems).toBe(1);
  });

  it("says an unknown or evicted id is gone and how to get it back", async () => {
    await expect(read({ outputId: "01JUNKNOWN0000000000000000" })).rejects.toThrow(
      /no longer available: saved outputs live in memory for this session only/,
    );
    setGalaxyOutputStore(createMemoryOutputStore({ entries: 1, bytes: 1024 * 1024 }));
    const first = galaxyOutputStore().put('{"data":[1]}', "get_histories");
    galaxyOutputStore().put('{"data":[2]}', "get_histories");
    await expect(read({ outputId: first })).rejects.toThrow("no longer available");
  });

  it("is read-only and keeps its parameters to the saved-output reader's set", () => {
    const tool = galaxyReadOutputTool();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual([
      "outputId",
      "pointer",
      "query",
      "offset",
      "limit",
    ]);
    expect(tool.description).not.toMatch(/MCP/);
  });
});
