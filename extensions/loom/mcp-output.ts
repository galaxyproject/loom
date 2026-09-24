/** Read adapter spill files without putting megabytes back into model context. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const PAGE_BYTES = 12 * 1024;
const MARKER = "[loom MCP output recovery]";
type Recordish = Record<string, unknown>;
function record(value: unknown): Recordish | undefined {
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
    const size = Buffer.byteLength(JSON.stringify(item));
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
    const size = Buffer.byteLength(JSON.stringify(item));
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

/** Only adapter-created artifacts registered by tool-result metadata are readable. */
async function readArtifact(path: string): Promise<string> {
  const root = await realpath(tmpdir());
  const parent = await realpath(dirname(path));
  if (
    dirname(parent) !== root ||
    !/^pi-mcp-output-[\w-]+$/.test(basename(parent)) ||
    !/^(?:output|mcp-result)-[a-f0-9]+\.txt$/.test(basename(path))
  ) {
    throw new Error("Not an MCP output artifact.");
  }
  const resolved = join(parent, basename(path));
  const before = await lstat(resolved);
  if (!before.isFile()) throw new Error("MCP artifact must be a regular file, not a symlink.");
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > MAX_FILE_BYTES
    )
      throw new Error(
        "MCP artifact is not a regular file within the 32 MB inspection limit; narrow the original read-only query.",
      );
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size)
      throw new Error("MCP artifact changed during inspection; retry inspection.");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export function registerMcpOutputRecovery(pi: ExtensionAPI): void {
  const artifacts = new Map<string, string>();
  function remember(id: string, details: unknown): string | undefined {
    const guard = record(record(details)?.outputGuard);
    const path =
      guard?.truncated === true && typeof guard.fullOutputPath === "string"
        ? guard.fullOutputPath
        : undefined;
    if (path) artifacts.set(id, path);
    return path;
  }
  function restore(ctx: ExtensionContext): void {
    artifacts.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        remember(entry.message.toolCallId, entry.message.details);
      }
    }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "mcp_read_output",
    label: "Inspect saved MCP output",
    description:
      "Read/search an oversized MCP response already returned in this session. Use outputId from the recovery notice, or the saved path from an older truncation notice. Only registered session artifacts are readable, never arbitrary files. JSON Pointer selects a field; query searches literal text in scalar fields; offset/limit page results. User-defined tool catalogs default to identity/name/version/container summaries; query searches their metadata, and definitionPointer selects a full definition for inspection. Object previews may omit fields: use their pointers to inspect exact values. Text offsets are characters, not lines. Continue the authorized task without asking the user to inspect files.",
    parameters: Type.Object({
      outputId: Type.String(),
      pointer: Type.Optional(Type.String({ maxLength: 2000 })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, args, signal) {
      try {
        signal?.throwIfAborted();
        const path =
          artifacts.get(args.outputId) ??
          [...artifacts.values()].find((path) => path === args.outputId);
        if (!path)
          throw new Error(
            "Unknown MCP outputId for this session. Use the ID from its recovery notice.",
          );
        const text = await readArtifact(path);
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: JSON.stringify(inspectOutput(text, args)) }],
          details: {},
        };
      } catch (error) {
        // Pi marks thrown errors as failed tool results; returning isError on
        // the execute result itself is ignored by its agent loop.
        throw new Error(
          `MCP output inspection failed: ${error instanceof Error ? error.message : String(error)}. Do not infer missing results or repeat a submission. For expired files, repeat only a read-only query with narrower scope.`,
          { cause: error },
        );
      }
    },
  });

  pi.on("tool_result", async (event) => {
    const path = remember(event.toolCallId, event.details);
    if (!path || event.content.some((c) => c.type === "text" && c.text.includes(MARKER))) return;
    let overview: string;
    let headline = event.isError
      ? "MCP request returned an error. Saved response preview follows."
      : "Large MCP response saved. Showing a bounded preview.";
    let next =
      "Select a JSON Pointer from the preview, or use query to find relevant records. A partial preview does not establish that omitted records are absent.";
    try {
      const page = inspectOutput(await readArtifact(path), {
        outputId: event.toolCallId,
        limit: 20,
      });
      overview = JSON.stringify(page);
      if (page.type === "user_tool_catalog") {
        if (!event.isError)
          headline = `User-defined tools: showing ${(page.items as unknown[]).length} of ${page.responseItems} tools returned by Galaxy. Full definitions are available on demand.`;
        next =
          'Search tool names/IDs/descriptions with query, or page this catalog with pointer "/data" and nextOffset. Use a tool\'s definitionPointer to inspect its inputs, outputs or command only when needed. These are summaries of this response, not proof that Galaxy has no other pages.';
      }
    } catch {
      headline = event.isError
        ? "MCP request returned an error; its saved response preview could not be read."
        : "Large MCP response saved; its preview could not be read.";
      overview =
        "Saved output is unavailable or exceeds the inspection limit. Do not infer its contents. Narrow read-only queries; check Galaxy state before repeating a mutation.";
    }
    // Preserve native images and the original success/error flag. The model gets
    // usable structure even when truncateHead returned zero preview lines.
    return {
      content: [
        ...event.content.filter((c) => c.type !== "text"),
        {
          type: "text" as const,
          text: `${headline}\n${overview}\n${MARKER}\nComplete response: ${path}\nFor more detail, use mcp_read_output with outputId ${JSON.stringify(event.toolCallId)}. ${next} Inspect required fields before proceeding. Do not ask the user to read the file, repeat the original operation just to recover output, or dump the entire file with cat/read/grep.`,
        },
      ],
    };
  });
}
