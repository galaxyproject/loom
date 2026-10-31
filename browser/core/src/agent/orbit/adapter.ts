/**
 * The browser's own tools as Orbit tools: Pyodide's run_python and the processes built on it,
 * and the Galaxy extras the browser's galaxy-ops entry lacks (download_dataset, upload_file,
 * recommend_biocontainer). Each keeps its browser implementation; what changes is that it's
 * declared as a pi ToolDefinition, so Orbit's guards, capture and grant see it like any other.
 *
 * A browser tool reads its conversation's binding and earlier artifacts when it runs. They're
 * resolved at execute time from the conversation the call runs in, never captured at
 * registration, since one registration serves every conversation the worker attaches.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";

import type { GalaxyExtra } from "../../../../../extensions/orbit/galaxy-ops-tools";
import { wrapGalaxyTool } from "../../../../../extensions/orbit/galaxy-tool-wrap";
import type { GalaxyTool } from "../../../../../extensions/orbit/galaxy-tool-source";
import {
  claim,
  fail,
  Outcome,
  rendered,
  type AgentTool,
  type Artifact,
  type Binding,
  type Capability,
  type Context,
} from "../tool";

/** What a browser tool reads beyond its arguments, for the conversation a call runs in. */
export interface ShellToolHost {
  /** Galaxy clients and Python for one call, ended by its abort signal. */
  clients(signal: AbortSignal | undefined): Pick<Context, "galaxy" | "web" | "python">;
  /** The conversation the call runs in: the bound one. */
  conversation(): ConversationId | undefined;
  binding(id: ConversationId): Promise<Binding>;
  /** Keep the binding fields the tool changed (a record page it made, a history it switched to). */
  rebind(id: ConversationId, changed: Partial<Binding>): Promise<void>;
  /** The artifacts the conversation's results carried, newest last. */
  artifacts(id: ConversationId): Promise<Artifact[]>;
}

/** Every capability a tool needs. */
export const needs = (tool: AgentTool): Capability[] =>
  tool.requires ?? (tool.capability ? [tool.capability] : []);

/** Whether a grant of `capabilities` covers what `tool` needs. */
export const granted = (tool: AgentTool, capabilities: readonly string[]) =>
  needs(tool).every((c) => capabilities.includes(c));

/** A browser tool as a pi tool definition, its context resolved for each call. */
export function adaptTool(tool: AgentTool, host: ShellToolHost): GalaxyTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    annotations: {
      readOnlyHint: !needs(tool).includes("write"),
      destructiveHint: tool.destructive === true,
    },
    async execute(_callId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const id = host.conversation();
      if (id === undefined) {
        return {
          content: [{ type: "text" as const, text: `${tool.name}: no conversation is open.` }],
          details: {},
          isError: true,
        };
      }
      const [bound, prior] = await Promise.all([host.binding(id), host.artifacts(id)]);
      const ctx: Context = {
        ...host.clients(signal),
        binding: { ...bound },
        artifacts: { prior, produced: [] },
      };
      let value: unknown;
      try {
        value = await tool.run(params, ctx);
      } catch (err) {
        if (signal?.aborted) throw err;
        value = fail(`Tool '${tool.name}' raised: ${(err as Error)?.message ?? err}`);
      }
      // The envelope's shape, as a Galaxy tool's text is: capture reads a submission's ids from it.
      const text =
        value instanceof Outcome
          ? value.text
          : typeof value === "string"
            ? value
            : rendered({ data: claim(value, ctx) });
      // Only what the tool changed: a whole snapshot written back would undo a binding write
      // that landed while the call ran (the record page made, the model switched).
      const changed = Object.fromEntries(
        Object.entries(ctx.binding).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify((bound as Record<string, unknown>)[key]),
        ),
      );
      if (Object.keys(changed).length) await host.rebind(id, changed);
      const guard = value instanceof Outcome ? value.guard : undefined;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          ...(ctx.artifacts.produced.length ? { artifacts: ctx.artifacts.produced } : {}),
          ...(guard ? { refused: true, guard } : {}),
        },
        isError: value instanceof Outcome && value.isError,
      };
    },
  };
}

/**
 * The extras as Galaxy tools: wrapped like the source's own, so they get its deadline, its spill,
 * `details.galaxy`, and for upload_file the submission ledger. The source leaves out any operation
 * of the same name (the Node entry's own upload_file), so the shell's is the one registered.
 */
export function galaxyExtras(tools: readonly AgentTool[], host: ShellToolHost): GalaxyExtra[] {
  return tools.map((tool) => wrapGalaxyTool(adaptTool(tool, host)) as GalaxyExtra);
}
