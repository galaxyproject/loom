import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as mcpOutput from "../extensions/loom/mcp-output";
import * as galaxyOutput from "../extensions/loom/galaxy-output";
import {
  GALAXY_OUTPUT_MARKER,
  inspectOutput,
  spillPreview,
} from "../extensions/loom/galaxy-output";
import { utf8ByteLength } from "../shared/truncate-middle.js";

const ROOT = join(__dirname, "..");

function userTools(count = 57) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: `encoded-tool-${i}`,
      uuid: `user-tool-uuid-${i}`,
      tool_id: "example_tool",
      tool_format: "GalaxyUserTool",
      active: i !== 3,
      hidden: i === 3,
      representation: {
        class: "GalaxyUserTool",
        name: i === count - 1 ? "ChronAeon validator" : `Example tool ${i}`,
        version: `1.${i}.0`,
        description: "A useful tool",
        container: "example.invalid/python:3.11",
        shell_command: "private command body; ".repeat(250),
        inputs: [{ name: "alignment", type: "data" }],
      },
    })),
    success: true,
    message: "Retrieved user-defined tools",
    count,
    pagination: null as unknown,
  };
}

function unicodeCatalog() {
  const payload = userTools(31);
  for (const item of payload.data) {
    item.representation.description = "🧬".repeat(3000);
    item.representation.name = "🧬".repeat(3000);
  }
  return payload;
}

function toolPanel() {
  return {
    success: true,
    data: Array.from({ length: 87 }, (_, section) => ({
      name: `Section ${section}`,
      elems: Array.from({ length: 80 }, (_, i) => ({
        id: `tool-${section}-${i}`,
        name: section === 86 && i === 79 ? "TISSUE" : "Other tool",
        description: "x".repeat(400),
      })),
    })),
  };
}

describe("inspectOutput extraction", () => {
  // One function behind both imports, so tests/mcp-output.test.ts passing unedited is what pins
  // the moved code's behaviour; comparing the two paths case by case would compare it with itself.
  it("is the same function through mcp-output and galaxy-output", () => {
    expect(mcpOutput.inspectOutput).toBe(galaxyOutput.inspectOutput);
  });

  it("bounds catalog pages by UTF-8 bytes as before", () => {
    const page = inspectOutput(JSON.stringify(unicodeCatalog()), { outputId: "x", limit: 20 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(14_000);
    expect((page.items as unknown[]).length).toBeGreaterThan(0);
  });
});

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";

describe("spillPreview", () => {
  it("shows a catalog headline and catalog paging advice for user-defined tools", () => {
    const envelope = JSON.stringify(userTools());
    const text = spillPreview(envelope, ID, false);
    const [headline, overview] = text.split("\n");
    expect(headline).toBe(
      "User-defined tools: showing 20 of 57 tools returned by Galaxy. Full definitions are available on demand.",
    );
    expect(JSON.parse(overview)).toEqual(inspectOutput(envelope, { outputId: ID, limit: 20 }));
    expect(text).toContain('page this catalog with pointer "/data" and nextOffset');
    expect(text).not.toContain("private command body");
  });

  it("keeps the error headline for a failed catalog response", () => {
    const failed = userTools(2);
    failed.success = false;
    failed.message = "Access denied";
    const text = spillPreview(JSON.stringify(failed), ID, true);
    expect(text.split("\n")[0]).toBe(
      "Galaxy returned a large error response. Saved response preview follows.",
    );
    expect(text).toContain("Access denied");
    expect(text).not.toContain("User-defined tools: showing");
  });

  it("ends with the marker and the galaxy_read_output pointer", () => {
    const envelope = JSON.stringify({
      success: true,
      data: Array.from({ length: 500 }, (_, i) => ({ id: `d${i}`, name: "x".repeat(60) })),
    });
    const text = spillPreview(envelope, ID, false);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Large Galaxy response saved in memory. Showing a bounded preview.");
    expect(lines[2]).toBe(GALAXY_OUTPUT_MARKER);
    expect(GALAXY_OUTPUT_MARKER).toBe("[loom Galaxy output]");
    expect(lines[3]).toBe(
      `For more detail, use galaxy_read_output with outputId "${ID}". Select a JSON Pointer from the preview, or use query to find relevant records. A partial preview does not establish that omitted records are absent. Saved outputs live in memory for this session only. Inspect required fields before proceeding. Do not repeat the original operation just to recover output.`,
    );
    expect(lines).toHaveLength(4);
    expect(text).not.toMatch(/\bMCP\b/);
  });

  it("falls back to a head and tail cut when one entry exceeds the preview budget", () => {
    // Twelve long key names make even the bounded object preview larger than a page.
    const entry = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`${i}${"k".repeat(2000)}`, i]),
    );
    const envelope = JSON.stringify({ data: [entry] });
    expect(() => inspectOutput(envelope, { outputId: ID, pointer: "/data", limit: 20 })).toThrow(
      "preview budget",
    );
    const big = JSON.stringify([entry, entry, entry]);
    expect(() => inspectOutput(big, { outputId: ID, limit: 20 })).toThrow("preview budget");
    const text = spillPreview(big, ID, false);
    expect(text).toContain("chars truncated…");
    expect(text).toContain(GALAXY_OUTPUT_MARKER);
    expect(text).toContain(`outputId "${ID}"`);
    expect(utf8ByteLength(text)).toBeLessThan(20 * 1024);
  });

  it("stays under the 20 KiB spill threshold for a large ordinary response", () => {
    const envelope = JSON.stringify(toolPanel());
    expect(utf8ByteLength(spillPreview(envelope, ID, false))).toBeLessThan(20 * 1024);
  });
});

// Modules that run in the browser worker as well as Orbit.
const HOT_PATH = [
  "shared/truncate-middle.js",
  "shared/markdown-sections.js",
  "shared/malformed-object-ids.js",
  "extensions/loom/galaxy-output.ts",
  "extensions/loom/galaxy-output-store.ts",
  "extensions/loom/galaxy-ops-tools.ts",
  "extensions/loom/galaxy-tool-wrap.ts",
  "extensions/loom/galaxy-failure.ts",
  "extensions/loom/galaxy-op-policy.ts",
  "extensions/loom/galaxy-page-ops.ts",
  "extensions/loom/galaxy-job-ops.ts",
];

// The transport seam, reached through galaxyOpsContext. Its process.env read is the fallback
// when no transport supplies credentials, and the browser installs one; nothing else may read env.
const ENV_FALLBACK = new Set(["extensions/loom/galaxy-api.ts"]);

const FORBIDDEN_TOKEN = /node:|\bBuffer\b|\btmpdir\b|process\.env|\bcrypto\b|\brequire\s*\(/;
const NODE_SPECIFIER = /^(?:node:|fs$|fs\/|path$|os$|crypto$)/;

// Type-only imports are erased before anything runs, so they reach nothing.
function withoutTypeImports(text: string): string {
  return text
    .replace(/\b(?:import|export)\s+type\s[\s\S]*?from\s*["'][^"']+["']\s*;?/g, "")
    .replace(
      /\bimport\s*\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["']\s*;?/g,
      "",
    );
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of withoutTypeImports(source).matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
  ))
    found.push(m[1]);
  return found;
}

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find((p) =>
    statSync(p, { throwIfNoEntry: false })?.isFile(),
  );
}

describe("hot-path modules stay Node-free", () => {
  it.each(HOT_PATH)("%s contains no Node-only token", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toMatch(FORBIDDEN_TOKEN);
    // A value import of pi counts as a Node edge in the browser conformance scan.
    expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']@earendil-works\//m);
  });

  it("nothing a hot-path module imports, transitively, reaches a Node module", () => {
    const seen = new Set<string>();
    const queue = HOT_PATH.map((f) => join(ROOT, f));
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const node = ENV_FALLBACK.has(relative(ROOT, file))
        ? /\bBuffer\b|\btmpdir\b/
        : /\bBuffer\b|\btmpdir\b|process\.env/;
      expect(source, relative(ROOT, file)).not.toMatch(node);
      for (const spec of specifiers(source)) {
        expect(spec, `${relative(ROOT, file)} imports ${spec}`).not.toMatch(NODE_SPECIFIER);
        if (spec.startsWith(".")) {
          const target = resolveRelative(file, spec);
          expect(target, `${relative(ROOT, file)} -> ${spec}`).toBeDefined();
          queue.push(target!);
        }
      }
    }
    // Proves the walk follows imports; the ring's ids come through ulid.ts.
    const reached = [...seen].map((f) => relative(ROOT, f));
    expect(reached).toContain("shared/random.js");
    expect(reached).toContain("extensions/loom/galaxy-api.ts");
    expect(reached).toContain("shared/page-content-hash.js");
    // The page policy's record lock comes through the seam, never the fs-backed store.
    expect(reached).toContain("extensions/loom/record-store-seam.ts");
    expect(reached).not.toContain("extensions/loom/record-store-file.ts");
    // Only the source's types are imported; the registrar and the profile it reads stay out.
    expect(reached).not.toContain("extensions/loom/galaxy-tool-source.ts");
  });
});
