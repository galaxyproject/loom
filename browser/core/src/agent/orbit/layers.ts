/**
 * What the browser shell adds on top of Orbit's brain, as tool_call handlers registered after
 * Orbit's own, so Orbit's guards decide first and these only see a call they let through:
 *
 * - `{{artifact}}` tokens in a Galaxy or shell tool's text arguments become the fenced block of
 *   the artifact they name, from what this conversation's results carried; a token inside a fence,
 *   or one naming nothing, refuses the call with the sentence the browser has always used.
 * - A page write that still holds an embed the model made up (an image link to a chart, say) is
 *   refused: Galaxy would render it as text.
 * - A Galaxy call aimed at one of the shell's own tools (run_tool with tool_id "lineage_report",
 *   a catalog search for it) is sent back to that tool. Orbit has no rule for this: Galaxy just
 *   answers "not found", and the model goes looking for a Galaxy tool that was never there.
 *
 * Every other browser guard either has an Orbit equivalent or was dropped; the slice 3 notes list
 * each one's disposition.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registeredGalaxyTools } from "../../../../../extensions/orbit/galaxy-tool-source";
import { inventedEmbed, resolveArtifacts } from "../artifacts";
import type { Annotate } from "../tools";
import type { Artifact, Context } from "../tool";
import type { AgentFlavor } from "../tools";
import { GALAXY_UNREACHABLE, type GalaxyStatus } from "../galaxy-status";
import { galaxyUnavailableBlock } from "../../../../../shared/prompt-blocks.js";

/**
 * What the model is told when Galaxy didn't answer as the session opened. Orbit can't tell on its
 * own: in the worker the page's cookie authenticates, so Orbit always has credentials.
 */
export const GALAXY_UNAVAILABLE = galaxyUnavailableBlock({
  cause: "Galaxy did not answer, so no Galaxy tool or workflow can run in this session.",
  remedy: "say so plainly and ask the user to check that the server is up and reload the page",
});

export interface LayerHost {
  /** The product name a misroute names the tool's owner by, e.g. "Olit". */
  brandName: string;
  /** Every tool that isn't a Galaxy one, by name: what a Galaxy call is sent back to. */
  shellTools: () => ReadonlySet<string>;
  /** The non-Galaxy tools whose text arguments take {{artifact}} tokens: the flavor's. */
  placing?: () => ReadonlySet<string>;
  /** The artifacts the bound conversation's results carried, newest last. */
  artifacts: () => Promise<Artifact[]>;
}

const PAGE_WRITES = new Set(["create_page", "update_page"]);
/** Where a token may start: the browser's pattern allows space after the braces. */
const MAYBE_TOKEN = /\{\{\s*artifact/;
const PAGE_TEXT = ["content", "section_content"];

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** The refusal for a Galaxy call aimed at one of the shell's own tools, or undefined. */
export function misrouted(
  input: Record<string, unknown>,
  own: ReadonlySet<string>,
  name: string,
): string | undefined {
  const wanted = [input.tool_id, input.query].find(
    (v): v is string => typeof v === "string" && own.has(v.trim()),
  );
  if (!wanted) return undefined;
  if (wanted === input.tool_id) {
    return `'${wanted}' is ${article(name)} ${name} tool, not a Galaxy tool. Call ${wanted} directly.`;
  }
  return (
    `'${wanted}' is ${article(name)} ${name} tool rather than a Galaxy tool, so the tool catalog does not ` +
    "hold it. It is already in your tool list if you need it."
  );
}

export function registerBrowserLayers(api: ExtensionAPI, host: LayerHost): void {
  api.on("tool_call", async (event) => {
    const galaxy = new Set(registeredGalaxyTools().map((t) => t.name));
    const own = host.shellTools();
    const placing = galaxy.has(event.toolName) || (host.placing?.().has(event.toolName) ?? false);
    if (!galaxy.has(event.toolName) && !placing) return undefined;
    const input = event.input as Record<string, unknown>;

    if (galaxy.has(event.toolName)) {
      const sentBack = misrouted(input, own, host.brandName);
      if (sentBack) return { block: true, reason: sentBack };
    }

    // Read only when a token is there to place: most calls carry none.
    const tokened = Object.entries(input).filter(
      ([, value]) => typeof value === "string" && MAYBE_TOKEN.test(value),
    );
    if (tokened.length) {
      const known = await host.artifacts();
      for (const [key, value] of tokened) {
        const { text, refusal } = resolveArtifacts(value, known);
        if (refusal) return { block: true, reason: `Refused: ${refusal}` };
        input[key] = text;
      }
    }

    if (PAGE_WRITES.has(event.toolName)) {
      for (const key of PAGE_TEXT) {
        const value = input[key];
        const invented = typeof value === "string" ? inventedEmbed(value) : null;
        if (invented) return { block: true, reason: `Refused: ${invented}` };
      }
    }
    return undefined;
  });
}

export interface FlavorLayerHost {
  /** The section heading the flavor's prompt lines go under. */
  brandName: string;
  annotators?: readonly Annotate[];
  promptSections?: AgentFlavor["promptSections"];
  /** The dataset the bound conversation was opened on. */
  datasetId: () => Promise<string | undefined>;
  /** A tool call's context, for an annotator that asks Galaxy something. */
  context: () => Promise<Context>;
  /** Whether Galaxy answered when the session opened, once the runtime knows. */
  galaxyStatus?: () => GalaxyStatus | undefined;
}

/** A Galaxy result's payload: the envelope's `data`, when the text is the envelope. */
function payloadOf(content: ReadonlyArray<{ type: string; text?: string }>): unknown {
  const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
  try {
    return (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    return undefined;
  }
}

/**
 * What a flavor adds to the brain: who the agent is and its prompt sections, around Orbit's system
 * prompt, and its notes on Galaxy results (Olit's "that's a visualization, not a tool" after a
 * catalog search), appended to what the model reads. Both after Orbit's own handlers.
 */
export function registerFlavorLayers(api: ExtensionAPI, host: FlavorLayerHost): void {
  api.on("before_agent_start", async (event, ctx) => {
    const sections = host.promptSections?.({
      model: ctx.model?.id,
      provider: ctx.model?.provider,
      datasetId: await host.datasetId(),
    });
    // Orbit's prompt names no product: the shell's identity leads, as in the browser brain, and
    // stays a stable prefix ahead of Orbit's cached prompt.
    const unreachable = host.galaxyStatus?.() === GALAXY_UNREACHABLE;
    const before = [
      `You are ${host.brandName}.`,
      ...(unreachable ? [GALAXY_UNAVAILABLE] : []),
      ...(sections?.afterIdentity ?? []),
    ];
    const after = [
      ...(sections?.terminology?.length
        ? [`## ${host.brandName} terms\n\n${sections.terminology.join("\n")}`]
        : []),
      ...(sections?.afterRouter ?? []),
    ];
    return {
      systemPrompt: [...before, event.systemPrompt, ...after].filter(Boolean).join("\n\n"),
    };
  });
  const annotators = host.annotators ?? [];
  if (annotators.length) {
    api.on("tool_result", async (event) => {
      if (event.isError) return undefined;
      if (!registeredGalaxyTools().some((t) => t.name === event.toolName)) return undefined;
      const data = payloadOf(event.content as Array<{ type: string; text?: string }>);
      if (data === undefined) return undefined;
      const ctx = await host.context();
      for (const annotate of annotators) {
        const note = await annotate(
          event.toolName,
          event.input as Record<string, unknown>,
          data,
          ctx,
        );
        if (note)
          return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }] };
      }
      return undefined;
    });
  }
}
