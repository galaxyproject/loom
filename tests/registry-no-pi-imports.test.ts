/**
 * The trusted core has to be servable unchanged from a standalone MCP process
 * or Galaxy's shared operations layer, so `registry.ts` and everything it
 * imports may use Node builtins, each other and the dependency-free modules
 * under shared/, and nothing else: no pi, no extension entry point, no session
 * state. This walks the real import graph.
 */

import * as fs from "fs";
import { builtinModules } from "module";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

const EXT = path.join(__dirname, "..", "extensions", "loom");
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const FORBIDDEN_LOCAL = new Set(["index.ts", "state.ts"]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  // A shared/*.js module is a real file, so the spec itself resolves too.
  const asIs = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts"), asIs]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${fromFile}`);
}

/** Every problem in `entry`'s import graph, as "file: specifier" strings. */
export function couplingViolations(entry: string): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf-8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const where = `${path.basename(file)}: ${spec}`;
      if (spec.startsWith(".")) {
        const target = resolveLocal(file, spec);
        if (FORBIDDEN_LOCAL.has(path.basename(target)) && path.dirname(target) === EXT) {
          problems.push(where);
        }
        queue.push(target);
      } else if (!BUILTINS.has(spec)) {
        problems.push(where);
      }
    }
  }
  return problems;
}

describe("registry has no harness coupling", () => {
  it("imports only Node builtins and its own modules", () => {
    expect(couplingViolations(path.join(EXT, "registry.ts"))).toEqual([]);
  });

  it("holds for the proposal and approval core too", () => {
    expect(couplingViolations(path.join(EXT, "registry-proposal.ts"))).toEqual([]);
  });

  it("holds for the evaluation core and the Page carrier codec too", () => {
    expect(couplingViolations(path.join(EXT, "registry-evaluation.ts"))).toEqual([]);
    expect(couplingViolations(path.join(EXT, "registry-carrier.ts"))).toEqual([]);
  });

  it("walks the whole graph, not just the entry file", () => {
    // Guard against the walker going quiet: it must reach the modules the
    // store is built from.
    const reached = new Set<string>();
    const src = fs.readFileSync(path.join(EXT, "registry.ts"), "utf-8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith("."))
        reached.add(path.basename(resolveLocal(path.join(EXT, "registry.ts"), spec)));
    }
    expect([...reached].sort()).toEqual(
      expect.arrayContaining([
        "registry-eligibility.ts",
        "registry-import.ts",
        "registry-lock.ts",
        "registry-schema.ts",
        "ulid.ts",
      ]),
    );
  });

  describe("the check itself", () => {
    function graph(files: Record<string, string>): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-coupling-"));
      for (const [name, body] of Object.entries(files))
        fs.writeFileSync(path.join(dir, name), body);
      return path.join(dir, "entry.ts");
    }

    it("catches a pi import two hops away", () => {
      const entry = graph({
        "entry.ts": 'import { x } from "./mid";\n',
        "mid.ts": 'export * from "./deep";\n',
        "deep.ts": 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n',
      });
      expect(couplingViolations(entry)).toEqual(["deep.ts: @earendil-works/pi-coding-agent"]);
    });

    it("catches a dynamic import and a require", () => {
      const entry = graph({
        "entry.ts":
          'const a = await import("@earendil-works/pi-ai");\nconst b = require("yaml");\n',
      });
      expect(couplingViolations(entry).sort()).toEqual([
        "entry.ts: @earendil-works/pi-ai",
        "entry.ts: yaml",
      ]);
    });

    it("catches a multi-line import", () => {
      const entry = graph({
        "entry.ts": 'import {\n  a,\n  b,\n} from "@earendil-works/pi-coding-agent";\n',
      });
      expect(couplingViolations(entry)).toHaveLength(1);
    });
  });
});
