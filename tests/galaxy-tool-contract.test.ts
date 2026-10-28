import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { format } from "prettier";
import { createGalaxyOpsToolSource } from "../extensions/loom/galaxy-ops-tools";

// The browser offers its Galaxy tools from a galaxy-ops fork; Orbit runs the
// same operations in-process from galaxy-ops itself. Which tools both shells
// have, which only the browser has, and where their parameters differ is pinned
// here, so a tool or parameter appearing on one side only is a reviewed change,
// not a surprise.

const ROOT = join(__dirname, "..");
const BROWSER = join(ROOT, "browser");

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

// Orbit's Galaxy tools: one per galaxy-ops operation on the Node entry. The
// array is shared with the browser entry, so it is copied once, here.
const operations = [...allOperations];
const opNames = operations.map((op) => op.name);
const opsVersion = (
  JSON.parse(
    readFileSync(join(ROOT, "node_modules/@galaxyproject/galaxy-ops/package.json"), "utf-8"),
  ) as { version: string }
).version;

/** Galaxy tools Loom adds beside the operations, and the operations it widens. */
const LOOM_BRIDGING = {
  tools: ["list_jobs", "get_job_logs", "galaxy_read_output"],
  wraps: ["get_job_details(job_id)", "update_page(section, expect_hash)", "get_page(content_hash)"],
};

/** Parameters and tools Orbit lacks until galaxy-ops ships them. */
const UPSTREAM_PENDING = [
  "get_invocations.offset",
  "get_invocations.sort_by",
  "get_invocations.sort_desc",
  "get_invocations.include_terminal",
  "get_tool_details.tool_version",
  "get_workflow_input_template.version",
  "get_user_tool",
];

// Parameters and descriptions are the tools Orbit registers: root's galaxy-ops, the
// upstream of the browser's fork, rendered by the default source with Loom's bridges in.
const orbitTools = createGalaxyOpsToolSource().tools();
const upstreamParams = new Map(
  orbitTools.map((tool) => [
    tool.name,
    Object.keys((tool.parameters as { properties?: object }).properties ?? {}),
  ]),
);
const upstreamSummary = new Map(orbitTools.map((tool) => [tool.name, tool.description]));

/** Only the browser's fork says these; they wait for galaxy-ops to be upstreamed. */
const FORK_ONLY: readonly { tool: string; param: string; in: "parameters" | "description" }[] = [];

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
        orbit: `@galaxyproject/galaxy-ops ${opsVersion} allOperations (Node entry)`,
        parameters: "createGalaxyOpsToolSource().tools() (root galaxy-ops + Loom bridges)",
      },
      intersection: browserNames.filter((n) => opNames.includes(n)).sort(),
      browserOnly: browserNames.filter((n) => !opNames.includes(n)).sort(),
      olitFlavorOnly: [...olitOnly].sort(),
      orbitOnly: opNames.filter((n) => !browserNames.includes(n)).sort(),
      loomBridging: LOOM_BRIDGING,
      upstreamPending: UPSTREAM_PENDING,
      knownDifferences: { parameters: paramDifferences(), forkOnly: FORK_ONLY },
    };
    // Written as prettier would, so `prettier --check .` passes on the golden.
    const json = await format(JSON.stringify(contract), { parser: "json", printWidth: 100 });
    await expect(json).toMatchFileSnapshot("__surface__/galaxy-tool-contract.json");
  });

  it("leaves Orbit no Galaxy operation the browser lacks", () => {
    // Computed from galaxy-ops itself, so this holds by source, not by the golden alone.
    expect(opNames.filter((n) => !browserNames.includes(n))).toEqual([]);
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
