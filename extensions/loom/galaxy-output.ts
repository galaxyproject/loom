/**
 * Inspect a saved Galaxy response without putting all of it back into model context: JSON Pointer
 * selection, literal search over scalar fields, paging, and a summary view of user-defined tool
 * catalogs. Pure string-in, object-out, so the same code serves Orbit and the browser worker.
 *
 * Moved here from mcp-output.ts, whose file reader pulls in Node-only modules; that file keeps
 * re-exporting `inspectOutput` until the MCP path is deleted.
 */
import { truncateMiddle, utf8ByteLength } from "../../shared/truncate-middle.js";

const PAGE_BYTES = 12 * 1024;
export type Recordish = Record<string, unknown>;
export function record(value: unknown): Recordish | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Recordish)
    : undefined;
}

export interface OutputQuery {
  outputId: string;
  pointer?: string;
  query?: string;
  offset?: number;
  limit?: number;
}

function pointerPart(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** A bounded, explicitly lossy preview, never an apparently complete object. */
function preview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= 300
      ? value
      : { preview: value.slice(0, 300), characters: value.length, omitted: true };
  }
  if (Array.isArray(value)) return { type: "array", items: value.length, omitted: true };
  const obj = record(value);
  if (!obj) return value;
  const keys = Object.keys(obj);
  if (depth >= 1) return { type: "object", keys: keys.slice(0, 12), omitted: true };
  return {
    fields: Object.fromEntries(keys.slice(0, 12).map((key) => [key, preview(obj[key], depth + 1)])),
    omitted: keys.length > 12,
  };
}

function select(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
    throw new Error("Use a JSON Pointer, for example /data/0.");
  let value = root;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    value = (value as Recordish)[key];
  }
  return value;
}

/** Search scalar fields, not serialized ancestors (which would match whole catalogs). */
function* matches(
  value: unknown,
  pointer: string,
  query: string,
): Generator<{ pointer: string; value: unknown }> {
  const stack = [{ pointer, value }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 100_000)
      throw new Error("Search scope too large; select a narrower JSON Pointer.");
    const item = stack.pop()!;
    const obj = record(item.value);
    if (
      obj &&
      Object.values(obj).some(
        (v) =>
          (typeof v === "string" || typeof v === "number") &&
          String(v).toLowerCase().includes(query),
      )
    ) {
      yield item;
    } else if (typeof item.value === "string" && item.value.toLowerCase().includes(query)) {
      yield item;
    }
    if (item.value !== null && typeof item.value === "object") {
      const entries = Object.entries(item.value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        // Object scalar fields were checked together above; retain their parent IDs.
        if ((child !== null && typeof child === "object") || Array.isArray(item.value)) {
          stack.push({ pointer: `${item.pointer}/${pointerPart(key)}`, value: child });
        }
      }
    }
  }
}

/** Catalog discovery needs identity fields, not every tool's embedded script. */
function userToolCatalog(root: unknown, args: OutputQuery): Recordish | undefined {
  const response = record(root);
  const tools = response?.data;
  if (
    !response ||
    response.success === false ||
    (args.pointer && args.pointer !== "/data") ||
    !Array.isArray(tools) ||
    tools.length === 0 ||
    !tools.every((tool) => {
      const row = record(tool);
      return (
        row?.tool_format === "GalaxyUserTool" &&
        typeof row.id === "string" &&
        typeof row.uuid === "string" &&
        typeof row.tool_id === "string" &&
        record(row.representation)
      );
    })
  )
    return;

  const query = args.query?.toLowerCase();
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
  const items: Recordish[] = [];
  let totalItems = 0;
  let bytes = 0;
  let more = false;
  for (const [index, tool] of tools.entries()) {
    const definition = tool.representation as Recordish;
    const fields = {
      id: tool.id,
      uuid: tool.uuid,
      tool_id: tool.tool_id,
      name: definition.name,
      version: definition.version,
      description: definition.description,
      container: definition.container,
      active: tool.active,
      hidden: tool.hidden,
    };
    if (
      query &&
      !Object.values(fields).some(
        (value) => typeof value === "string" && value.toLowerCase().includes(query),
      )
    )
      continue;
    if (totalItems++ < offset) continue;
    const item = {
      pointer: `/data/${index}`,
      definitionPointer: `/data/${index}/representation`,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, preview(value)])),
    };
    const size = utf8ByteLength(JSON.stringify(item));
    if (more || items.length >= limit || bytes + size > PAGE_BYTES) {
      more = true;
      continue;
    }
    items.push(item);
    bytes += size;
  }
  if (more && items.length === 0)
    throw new Error("Catalog entry exceeds the preview budget; select its exact JSON Pointer.");
  return {
    outputId: args.outputId,
    pointer: "/data",
    type: "user_tool_catalog",
    offset,
    totalItems,
    responseItems: tools.length,
    sourceCount: preview(response.count),
    sourcePagination: preview(response.pagination),
    items,
    nextOffset: more ? offset + items.length : null,
    definitionsOmitted: true,
    searchScope: "tool identity, name, version, description, container, not command bodies",
  };
}

export function inspectOutput(text: string, args: OutputQuery): Recordish {
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
  const pointer = args.pointer ?? "";
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    root = text;
  }
  const catalog = userToolCatalog(root, args);
  if (catalog) return catalog;
  const value = select(root, pointer);
  const base = { outputId: args.outputId, pointer, offset };
  if (typeof value === "string" && !args.query) {
    // Character offsets work even when the entire response occupies one line.
    const chunk = value.slice(offset, offset + 2000);
    return {
      ...base,
      type: "text",
      characters: value.length,
      text: chunk,
      nextOffset: offset + chunk.length < value.length ? offset + chunk.length : null,
    };
  }
  let entries: Iterable<{ pointer: string; value: unknown }>;
  if (args.query) entries = matches(value, pointer, args.query.toLowerCase());
  else if (value !== null && typeof value === "object") {
    entries = Object.entries(value).map(([key, child]) => ({
      pointer: `${pointer}/${pointerPart(key)}`,
      value: child,
    }));
  } else return { ...base, value, nextOffset: null };
  const items: unknown[] = [];
  let index = 0;
  let bytes = 0;
  let more = false;
  for (const entry of entries) {
    if (index++ < offset) continue;
    const item = { pointer: entry.pointer, preview: preview(entry.value) };
    const size = utf8ByteLength(JSON.stringify(item));
    if (items.length >= limit || bytes + size > PAGE_BYTES) {
      more = true;
      break;
    }
    items.push(item);
    bytes += size;
  }
  if (more && items.length === 0)
    throw new Error("Entry exceeds the preview budget; select a narrower JSON Pointer.");
  return {
    ...base,
    type: args.query ? "search" : Array.isArray(value) ? "array" : "object",
    totalItems: args.query ? undefined : Object.keys(value as object).length,
    items,
    nextOffset: more ? offset + items.length : null,
    previewsOnly: true,
  };
}

export const GALAXY_OUTPUT_MARKER = "[loom Galaxy output]";

// Keeps headline + overview + pointer text under the 20 KiB spill threshold when the preview
// cannot be built and the raw text is cut instead.
const FALLBACK_PREVIEW_BYTES = 16 * 1024;

/**
 * What the model sees in place of a spilled Galaxy response: a headline, the same bounded
 * overview `galaxy_read_output` returns, a marker, and how to read more.
 */
export function spillPreview(text: string, outputId: string, isError: boolean): string {
  let headline = isError
    ? "Galaxy returned a large error response. Saved response preview follows."
    : "Large Galaxy response saved in memory. Showing a bounded preview.";
  let next =
    "Select a JSON Pointer from the preview, or use query to find relevant records. A partial preview does not establish that omitted records are absent.";
  let overview: string;
  try {
    const page = inspectOutput(text, { outputId, limit: 20 });
    overview = JSON.stringify(page);
    if (page.type === "user_tool_catalog") {
      if (!isError)
        headline = `User-defined tools: showing ${(page.items as unknown[]).length} of ${page.responseItems} tools returned by Galaxy. Full definitions are available on demand.`;
      next =
        'Search tool names/IDs/descriptions with query, or page this catalog with pointer "/data" and nextOffset. Use a tool\'s definitionPointer to inspect its inputs, outputs or command only when needed. These are summaries of this response, not proof that Galaxy has no other pages.';
    }
  } catch {
    // One entry is larger than a preview page; a raw head and tail still shows its shape.
    overview = truncateMiddle(text, FALLBACK_PREVIEW_BYTES).content;
  }
  return `${headline}\n${overview}\n${GALAXY_OUTPUT_MARKER}\nFor more detail, use galaxy_read_output with outputId ${JSON.stringify(outputId)}. ${next} Saved outputs live in memory for this session only. Inspect required fields before proceeding. Do not repeat the original operation just to recover output.`;
}
