/**
 * The Galaxy tools Orbit builds for itself: one pi tool per galaxy-ops operation, run in-process.
 *
 * Each tool is galaxy-ops' own: its name is the operation's wire name, its description is the
 * line galaxy-ops gives that operation, and every parameter carries its zod field's description,
 * so the model reads what galaxy-ops' TypeScript server would advertise. Parameters are snake_case
 * at the top level and mapped back to the operation's camelCase input before it runs.
 *
 * The schema is plain JSON schema, not TypeBox: pi validates a schema without TypeBox's Kind
 * symbol by coercing values at every depth, which is what the MCP tools these replace always got.
 *
 * `@galaxyproject/galaxy-ops` is imported bare, so Node resolves the 45-operation entry and a
 * bundler's `browser` condition the 42-operation one, with no code change here.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import * as galaxyOps from "@galaxyproject/galaxy-ops";
import {
  allOperations,
  describeOperation,
  isPlainObject,
  laxenLikePydantic,
  runWithEnvelope,
  spellParamNames,
  type AnyOperation,
} from "@galaxyproject/galaxy-ops";
import { getJobDetailsBridge, getJobLogsBridge, listJobsBridge } from "./galaxy-job-ops";
import { GALAXY_OP_POLICY, type GalaxyOpArgs, type GalaxyOpPolicy } from "./galaxy-op-policy";
import { inspectOutput, type OutputQuery } from "./galaxy-output";
import { galaxyOutputStore } from "./galaxy-output-store";
import { getPageBridge, updatePageBridge } from "./galaxy-page-ops";
import type { GalaxyTool, GalaxyToolSource } from "./galaxy-tool-source";
import {
  GALAXY_ENVELOPE_SCHEMA,
  galaxyFailure,
  renderGalaxyResult,
  runGalaxyCall,
  type GalaxyCallDetails,
  type GalaxyContextFactory,
  type GalaxyEnvelope,
} from "./galaxy-tool-wrap";

/** galaxy-ops' camelCase input key as the wire spells it; the same regex the TS server uses. */
export const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * What a zod 4 field offers, without naming zod: root resolves zod 3, and galaxy-ops' fields are
 * its own nested zod 4 instances, so the source talks to each field through its own methods.
 */
interface ZodField {
  toJSONSchema(params: { io: "input" }): Record<string, unknown>;
  safeParse(
    value: unknown,
  ):
    { success: true; data: unknown } | { success: false; error: { issues: { message: string }[] } };
  description?: string;
}

const fieldsOf = (op: AnyOperation) => Object.entries(op.input) as unknown as [string, ZodField][];

export interface RenderedOperation {
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties: false;
  };
  /** The operation's fields under their wire names, for laxenLikePydantic. */
  snakeShape: AnyOperation["input"];
  /** The model's snake_case arguments under the operation's own keys; unknown keys pass through. */
  inputOf(args: GalaxyOpArgs): GalaxyOpArgs;
}

/**
 * An operation's input as JSON schema, rendered field by field. The result equals
 * `z.toJSONSchema(z.strictObject(op.input), { io: "input" })` with snake_case keys, which the
 * tests pin against galaxy-ops' own zod.
 */
export function renderOperation(op: AnyOperation): RenderedOperation {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const snakeShape: Record<string, unknown> = {};
  const toInput = new Map<string, string>();
  for (const [key, field] of fieldsOf(op)) {
    const { $schema: _dialect, ...schema } = field.toJSONSchema({ io: "input" });
    properties[snake(key)] = schema;
    if (!field.safeParse(undefined).success) required.push(snake(key));
    snakeShape[snake(key)] = field;
    toInput.set(snake(key), key);
  }
  return {
    parameters: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    snakeShape: snakeShape as AnyOperation["input"],
    inputOf: (args) =>
      Object.fromEntries(Object.entries(args).map(([k, v]) => [toInput.get(k) ?? k, v])),
  };
}

export type ParsedInput = { ok: true; input: GalaxyOpArgs } | { ok: false; message: string };

/**
 * The operation's input as galaxy-ops' zod would parse it: each present field parsed (so a
 * field's transform runs), each absent field given its default. runWithEnvelope does neither,
 * and the MCP servers this replaces did both. A missing required key is left to Galaxy: pi has
 * already enforced the schema's `required`, and a bridging op may relax it.
 */
export function parseInput(op: AnyOperation, input: GalaxyOpArgs): ParsedInput {
  const out: GalaxyOpArgs = { ...input };
  for (const [key, field] of fieldsOf(op)) {
    if (input[key] === undefined) {
      const r = field.safeParse(undefined);
      if (r.success && r.data !== undefined) out[key] = r.data;
      continue;
    }
    const r = field.safeParse(input[key]);
    if (!r.success) {
      const issue = r.error.issues[0]?.message ?? "invalid value";
      return { ok: false, message: `Invalid arguments for ${op.name}: ${snake(key)}: ${issue}` };
    }
    out[key] = r.data;
  }
  return { ok: true, input: out };
}

// The envelope's `data` is whatever Galaxy sent, which pi's JsonValue cannot spell.
const asToolResult = (result: ReturnType<typeof renderGalaxyResult>) =>
  result as unknown as AgentToolResult<GalaxyCallDetails>;

const NAMESPACE = Object.freeze({
  name: "galaxy",
  description: "Galaxy operations, run in-process through galaxy-ops",
  instructions:
    "Galaxy ids are the encoded strings Galaxy returns; pass them back exactly, never shortened or invented. Listing tools return one page at a time: pass pagination.next_offset as offset for the next page.",
});

export interface ToolFromOperationOptions {
  policy?: GalaxyOpPolicy;
  /** Bridging ops replace the rendered schema, description or key mapping; nothing else does. */
  parameters?: RenderedOperation["parameters"];
  description?: string;
  inputOf?: (args: GalaxyOpArgs) => GalaxyOpArgs;
  context?: GalaxyContextFactory;
  deadlineMs?: number;
}

/** One galaxy-ops operation as a pi tool: rendered schema, lax arguments, the shared wrapper. */
export function toolFromOperation(
  op: AnyOperation,
  opts: ToolFromOperationOptions = {},
): GalaxyTool {
  const rendered = renderOperation(op);
  const inputOf = opts.inputOf ?? rendered.inputOf;
  const policy = opts.policy;
  const invalid = (message: string) => galaxyFailure(message, "validation");
  return {
    name: op.name,
    label: op.name,
    description: opts.description ?? spellParamNames(describeOperation(op), op.input, snake),
    parameters: (opts.parameters ?? rendered.parameters) as unknown as TSchema,
    // The MCP servers decode ints and bools the way pydantic does ("5", "yes", "off"); keeping
    // every spelling they accepted means a model's habits carry over.
    prepareArguments: (args: unknown) =>
      isPlainObject(args) ? laxenLikePydantic(rendered.snakeShape, args) : args,
    annotations: { readOnlyHint: op.readOnly !== false, destructiveHint: op.destructive === true },
    // upload_file stays registered so the family knows the name; the local upload tool is the
    // model's way in, as it was under the MCP server.
    exposure: op.name === "upload_file" ? "hidden" : "direct",
    namespace: NAMESPACE,
    outputSchema: GALAXY_ENVELOPE_SCHEMA as unknown as TSchema,
    async execute(_toolCallId, params: GalaxyOpArgs, signal) {
      const upfront = parseInput(op, inputOf(params));
      if (!upfront.ok)
        return asToolResult(renderGalaxyResult(op.name, invalid(upfront.message), 0));
      const result = await runGalaxyCall(
        op.name,
        signal,
        async (ctx, joined): Promise<GalaxyEnvelope> => {
          // Inside the deadline: a policy that asks Galaxy something must not outlive the call.
          const refusal = await policy?.check?.(params, { signal: joined });
          if (refusal !== undefined) return invalid(refusal);
          const run = async (sent?: GalaxyOpArgs): Promise<GalaxyEnvelope> => {
            // A check or lock wait that outlasted the deadline has already been reported as an
            // unknown result; sending the request now could submit work the model then retries.
            joined.throwIfAborted();
            const parsed = sent === undefined ? upfront : parseInput(op, inputOf(sent));
            if (!parsed.ok) return invalid(parsed.message);
            return runWithEnvelope(op, parsed.input as never, ctx);
          };
          const env = policy?.around
            ? await policy.around(run, params, { signal: joined })
            : await run();
          if (env.success === false && policy?.refused) {
            const message = policy.refused(String(env.message ?? ""), params);
            if (message !== undefined) return { ...env, message };
          }
          return env;
        },
        { deadlineMs: opts.deadlineMs, context: opts.context },
      );
      return asToolResult(result);
    },
  };
}

/** Orbit's reader for a spilled Galaxy output. Registered beside the family, not in it. */
export function galaxyReadOutputTool(): GalaxyTool {
  return {
    name: "galaxy_read_output",
    label: "Inspect saved Galaxy output",
    description:
      "Read/search an oversized Galaxy response already returned in this session. Use the outputId from its preview. Saved outputs live in memory for this session only, and only those are readable. JSON Pointer selects a field; query searches literal text in scalar fields; offset/limit page results. User-defined tool catalogs default to identity/name/version/container summaries; query searches their metadata, and definitionPointer selects a full definition for inspection. Object previews may omit fields: use their pointers to inspect exact values. Text offsets are characters, not lines. Continue the authorized task without asking the user to inspect the output.",
    parameters: Type.Object({
      outputId: Type.String(),
      pointer: Type.Optional(Type.String({ maxLength: 2000 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, args: OutputQuery, signal) {
      signal?.throwIfAborted();
      const text = galaxyOutputStore().get(args.outputId);
      if (text === undefined) {
        throw new Error(
          `Galaxy output ${args.outputId} is no longer available: saved outputs live in memory for this session only. Call the original tool again with a narrower request.`,
        );
      }
      let page: Record<string, unknown>;
      try {
        page = inspectOutput(text, args);
      } catch (error) {
        // pi turns a throw into an error result; returning one would read as a success.
        throw new Error(
          `Galaxy output inspection failed: ${error instanceof Error ? error.message : String(error)}. Do not infer missing results or repeat a submission.`,
          { cause: error },
        );
      }
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}

/**
 * Which galaxy-ops entry this module loaded. The browser conformance test asserts it saw the
 * 42-operation browser entry, so a resolution that silently picks the Node entry cannot pass.
 * `in` rather than a read: vitest's mocked namespace throws on reading an export it lacks.
 */
export function galaxyOpsEntry(): { operations: readonly string[]; hasUploadFile: boolean } {
  return {
    operations: galaxyOps.allOperations.map((op) => op.name),
    hasUploadFile: "uploadFileOp" in galaxyOps,
  };
}

/**
 * An operation Loom supplies because galaxy-ops does not have it yet, in galaxy-ops' own shape.
 * It runs through the same wrapper as every operation; only its tool's words and schema may
 * differ from what the operation would render on its own.
 */
export interface GalaxyBridge {
  op: AnyOperation;
  /** A sentence after galaxy-ops' own description of the operation, saying what the bridge adds. */
  note?: string;
  parameters?: RenderedOperation["parameters"];
  inputOf?: (args: GalaxyOpArgs) => GalaxyOpArgs;
}

/** Bridges that widen an operation the entry has, and replace it under the same name. */
const WIDENED: readonly GalaxyBridge[] = [getJobDetailsBridge, getPageBridge, updatePageBridge];
/**
 * Bridges with a name galaxy-ops lacks, registered after the operations. When galaxy-ops ships
 * one, registration refuses the duplicate name, which is the cue to delete the bridge.
 */
const ADDED: readonly GalaxyBridge[] = [listJobsBridge, getJobLogsBridge];

function bridgeTool(bridge: GalaxyBridge, policy: GalaxyOpPolicy | undefined): GalaxyTool {
  const { op, note } = bridge;
  return toolFromOperation(op, {
    policy,
    parameters: bridge.parameters,
    inputOf: bridge.inputOf,
    ...(note === undefined
      ? {}
      : { description: `${spellParamNames(describeOperation(op), op.input, snake)} ${note}` }),
  });
}

export interface GalaxyOpsToolSourceOptions {
  /** Tools the shell supplies because its galaxy-ops entry lacks them; appended as given. */
  extras?: readonly GalaxyTool[];
  policies?: Record<string, GalaxyOpPolicy>;
}

/**
 * Orbit's default Galaxy tool source: every operation of the loaded galaxy-ops entry, the widened
 * ones replaced by their bridges, then the added bridges, then the shell's extras.
 */
export function createGalaxyOpsToolSource(
  options: GalaxyOpsToolSourceOptions = {},
): GalaxyToolSource {
  const policies = options.policies ?? GALAXY_OP_POLICY;
  return {
    tools() {
      // A snapshot: allOperations is one array both entries share, and grows when the other loads.
      const ops = [...allOperations];
      const widened = new Map(WIDENED.map((bridge) => [bridge.op.name, bridge]));
      return [
        ...ops.map((op) => {
          const bridge = widened.get(op.name);
          return bridge
            ? bridgeTool(bridge, policies[op.name])
            : toolFromOperation(op, { policy: policies[op.name] });
        }),
        ...ADDED.map((bridge) => bridgeTool(bridge, policies[bridge.op.name])),
        ...(options.extras ?? []),
      ];
    },
    companions: () => [galaxyReadOutputTool()],
  };
}
