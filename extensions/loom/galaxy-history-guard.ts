/**
 * Refuse a Galaxy tool run whose inputs live in a history other than the one
 * the job runs in. Galaxy allows it, but an agent that does it has nearly
 * always copied the wrong id, and the job answers a question nobody asked.
 * Ported from the browser shell's run_tool check, refusal text and all.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { galaxyGet } from "./galaxy-api";
import { galaxyMcpTool } from "../../shared/galaxy-mcp-tools.js";

const RUN_TOOL = galaxyMcpTool("run_tool");

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Sources a history owns: where each answers its history_id, and how to ask for
 * little more than that.
 */
const HISTORY_SCOPED_SRCS: Record<string, { path: string; brief: string }> = {
  hda: { path: "/datasets", brief: "?keys=history_id,name" },
  hdca: { path: "/dataset_collections", brief: "?view=collection" },
};

/** How many references are looked up at once. */
const LOOKUPS = 4;

/** Every history-scoped reference in a tool payload, with the field that carries it. */
function hdaInputs(inputs: unknown): [string, string, string][] {
  const found: [string, string, string][] = [];
  const walk = (name: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${name}[${index}]`, item));
    } else if (isRow(value)) {
      if (
        typeof value.src === "string" &&
        Object.hasOwn(HISTORY_SCOPED_SRCS, value.src) &&
        value.id
      ) {
        found.push([name, String(value.id), value.src]);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        walk(name ? `${name}.${key}` : key, item);
      }
    }
  };
  walk("", inputs || {});
  return found;
}

/**
 * Inputs that belong to a history other than `historyId`, each looked up once.
 * An id Galaxy won't resolve, or a lookup that fails, is not known to be
 * foreign: the run is left to report it.
 */
async function foreignInputs(inputs: unknown, historyId: string, signal?: AbortSignal) {
  const refs = hdaInputs(inputs);
  const distinct = [...new Set(refs.map(([, id, src]) => `${src}/${id}`))];
  const found = new Map<string, Row>();
  const lookup = async () => {
    for (let ref = distinct.pop(); ref !== undefined; ref = distinct.pop()) {
      const [src, id] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
      // `.` and `..` would name a parent path, not an id.
      if (/^(\.|%2e){0,2}$/i.test(id)) continue;
      const { path, brief } = HISTORY_SCOPED_SRCS[src];
      try {
        const detail = await galaxyGet(`${path}/${encodeURIComponent(id)}${brief}`, signal);
        if (isRow(detail)) found.set(ref, detail);
      } catch {
        // Fail open: a Galaxy that can't answer here can't be shown to disagree.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS, distinct.length) }, lookup));
  return refs.flatMap(([input, id, src]) => {
    const detail = found.get(`${src}/${id}`);
    const where = detail?.history_id;
    return where && where !== historyId
      ? [{ input, supplied_id: id, history_id: where, name: detail?.name ?? null }]
      : [];
  });
}

export function registerGalaxyHistoryGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== RUN_TOOL) return;
    const args = event.input as Row;
    if (typeof args.history_id !== "string" || !args.history_id) return;
    const foreign = await foreignInputs(args.inputs, args.history_id, ctx?.signal);
    if (!foreign.length) return;
    return {
      block: true,
      reason:
        `Refused: these inputs are in another history, not in history ${args.history_id} ` +
        `where this job runs: ${JSON.stringify(foreign)}. An id from another history is ` +
        "usually the wrong one: take the input's `id` from get_history_contents for this " +
        "history. If the user does mean that data, say which history it is in and ask them " +
        "to copy it into this one in Galaxy, then use the copy's id.",
    };
  });
}
