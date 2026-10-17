/** Read saved MCP output without putting megabytes back into model context. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inspectOutput, record } from "./galaxy-output";

export { inspectOutput, type OutputQuery } from "./galaxy-output";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MARKER = "[loom MCP output recovery]";

/** Whether `path` (parent already resolved) is a file pi's MCP support saved its full output to. */
function isMcpOutputFile(root: string, parent: string, name: string): boolean {
  if (parent === root) return /^pi-mcp-[a-f0-9]{16}\.txt$/.test(name);
  // pi-mcp-adapter's spill files, still named by tool results in older sessions.
  return (
    dirname(parent) === root &&
    /^pi-mcp-output-[\w-]+$/.test(basename(parent)) &&
    /^(?:output|mcp-result)-[a-f0-9]+\.txt$/.test(name)
  );
}

/**
 * Only MCP output files registered by tool-result metadata are readable.
 * `maxBytes` defaults to the inspection limit; a caller that needs the whole
 * file regardless of size, like submission capture, raises it.
 */
export async function readMcpOutputFile(
  path: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<string> {
  const root = await realpath(tmpdir());
  const parent = await realpath(dirname(path));
  if (!isMcpOutputFile(root, parent, basename(path))) {
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
      stat.size > maxBytes
    )
      throw new Error(
        `MCP artifact is not a regular file within the ${Math.round(maxBytes / (1024 * 1024))} MB limit; narrow the original read-only query.`,
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
    const d = record(details);
    const guard = record(d?.outputGuard);
    // pi's MCP tools report {server, tool, fullOutputPath} once they truncate;
    // outputGuard is how pi-mcp-adapter reported it, in older sessions.
    const path =
      typeof d?.server === "string" && typeof d.fullOutputPath === "string"
        ? d.fullOutputPath
        : guard?.truncated === true && typeof guard.fullOutputPath === "string"
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
        const text = await readMcpOutputFile(path);
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
      const page = inspectOutput(await readMcpOutputFile(path), {
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
