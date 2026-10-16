import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { format } from "prettier";

import { GALAXY_MCP_SPEC } from "../shared/galaxy-mcp-spec.js";
import { GALAXY_MCP_TOOLS } from "../extensions/loom/observation-allowlists";

// The browser offers its Galaxy tools from a galaxy-ops fork; Orbit reaches the
// same operations through galaxy-mcp. Which tools both shells have, which only
// the browser has, and where their parameters differ is pinned here, so a tool
// or parameter appearing on one side only is a reviewed change, not a surprise.

const BROWSER = join(__dirname, "..", "browser");

interface RequestTool {
  function: { name: string; description: string; parameters: { properties?: object } };
}

const bare = JSON.parse(
  readFileSync(join(BROWSER, "bare", "src", "__surface__", "request-plain.json"), "utf-8"),
) as { tools: RequestTool[] };
const olitTraits = JSON.parse(
  readFileSync(join(BROWSER, "olit", "src", "agent", "__surface__", "traits.json"), "utf-8"),
) as Array<{ name: string }>;

const browserTools = new Map(bare.tools.map((t) => [t.function.name, t.function]));
const olitOnly = olitTraits.map((t) => t.name).filter((name) => !browserTools.has(name));
const browserNames = [...browserTools.keys(), ...olitOnly];

// galaxy-mcp's tools, as generated from its server.py; the list spells them galaxy_<name>.
const mcpNames = [...GALAXY_MCP_TOOLS].map((name) => name.replace(/^galaxy_/, ""));

// Parameters come from root's galaxy-ops, the upstream of the browser's fork; its
// inputs are camelCase where both tool surfaces are snake_case.
const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const upstreamParams = new Map(
  allOperations.map((op) => [op.name, Object.keys(op.input as object).map(snake)]),
);
const upstreamSummary = new Map(allOperations.map((op) => [op.name, op.summary]));

/** Only the browser's fork has these; they wait for galaxy-ops to be upstreamed. */
const FORK_ONLY = [
  { tool: "update_page", param: "section_heading", in: "parameters" },
  { tool: "update_page", param: "expect_hash", in: "parameters" },
] as const;

function paramDifferences() {
  const out: Record<string, { browserOnly: string[]; upstreamOnly: string[] }> = {};
  for (const [name, tool] of browserTools) {
    const upstream = upstreamParams.get(name);
    if (!upstream) continue;
    const browser = Object.keys(tool.parameters.properties ?? {});
    const browserOnly = browser.filter((p) => !upstream.includes(p));
    const upstreamOnly = upstream.filter((p) => !browser.includes(p));
    if (browserOnly.length || upstreamOnly.length) out[name] = { browserOnly, upstreamOnly };
  }
  return out;
}

describe("the Galaxy tool contract between the browser and Orbit", () => {
  it("pins the shared tools, the browser-only tools and the known differences", async () => {
    const contract = {
      sources: {
        browser: "bare/src/__surface__/request-plain.json + olit/src/agent/__surface__/traits.json",
        orbit: `${GALAXY_MCP_SPEC}, tool names as generated into observation-allowlists.ts`,
        parameters: "root @galaxyproject/galaxy-ops allOperations, snake_cased",
      },
      intersection: browserNames.filter((n) => mcpNames.includes(n)).sort(),
      browserOnly: browserNames.filter((n) => !mcpNames.includes(n)).sort(),
      olitFlavorOnly: [...olitOnly].sort(),
      orbitOnly: mcpNames.filter((n) => !browserNames.includes(n)).sort(),
      knownDifferences: { parameters: paramDifferences(), forkOnly: FORK_ONLY },
    };
    // Written as prettier would, so `prettier --check .` passes on the golden.
    const json = await format(JSON.stringify(contract), { parser: "json", printWidth: 100 });
    await expect(json).toMatchFileSnapshot("__surface__/galaxy-tool-contract.json");
  });

  it("finds each fork-only field in the browser and not upstream", () => {
    for (const { tool, param, in: where } of FORK_ONLY) {
      const browser = browserTools.get(tool)!;
      if (where === "parameters") {
        expect(Object.keys(browser.parameters.properties ?? {})).toContain(param);
        expect(upstreamParams.get(tool)).not.toContain(param);
      } else {
        expect(browser.description).toContain(param);
        expect(upstreamSummary.get(tool)).not.toContain(param);
      }
    }
  });
});
