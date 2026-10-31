import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { format } from "prettier";
import { createGalaxyOpsToolSource } from "../extensions/orbit/galaxy-ops-tools";

// The browser worker runs Orbit's brain, so its Galaxy tools are galaxy-ops' operations run
// in-process, as Orbit's are, plus the few the browser shell adds. Which tools the browser offers,
// which are its own, and where an extra's parameters differ from galaxy-ops' Node operation is
// pinned here, so a tool appearing or a parameter moving is a reviewed change, not a surprise.

const ROOT = join(__dirname, "..");
const BROWSER = join(ROOT, "browser");

interface RequestTool {
  function: { name: string; description: string; parameters: { properties?: object } };
}

const bare = JSON.parse(
  readFileSync(join(BROWSER, "bare", "src", "__surface__", "request-plain.json"), "utf-8"),
) as { tools: RequestTool[] };
const olit = JSON.parse(
  readFileSync(join(BROWSER, "olit", "src", "agent", "__surface__", "request-plain.json"), "utf-8"),
) as { tools: RequestTool[] };

const browserTools = new Map(bare.tools.map((t) => [t.function.name, t.function]));
const olitOnly = olit.tools.map((t) => t.function.name).filter((name) => !browserTools.has(name));
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

// Parameters are the tools Orbit registers: root's galaxy-ops, rendered by the default source with
// Orbit's bridges in.
const orbitTools = createGalaxyOpsToolSource().tools();
const upstreamParams = new Map(
  orbitTools.map((tool) => [
    tool.name,
    Object.keys((tool.parameters as { properties?: object }).properties ?? {}),
  ]),
);

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

describe("the browser's Galaxy tools against Orbit's", () => {
  it("pins the shared tools, the browser-only tools and the known differences", async () => {
    const contract = {
      sources: {
        browser:
          "bare/src/__surface__/request-plain.json + olit/src/agent/__surface__/request-plain.json",
        orbit: `@galaxyproject/galaxy-ops ${opsVersion} allOperations (Node entry)`,
        parameters: "createGalaxyOpsToolSource().tools() (root galaxy-ops + Loom bridges)",
      },
      intersection: browserNames.filter((n) => opNames.includes(n)).sort(),
      browserOnly: browserNames.filter((n) => !opNames.includes(n)).sort(),
      olitFlavorOnly: [...olitOnly].sort(),
      orbitOnly: opNames.filter((n) => !browserNames.includes(n)).sort(),
      orbitBridging: LOOM_BRIDGING,
      knownDifferences: { parameters: paramDifferences() },
    };
    // Written as prettier would, so `prettier --check .` passes on the golden.
    const json = await format(JSON.stringify(contract), { parser: "json", printWidth: 100 });
    await expect(json).toMatchFileSnapshot("__surface__/galaxy-tool-contract.json");
  });

  it("leaves Orbit no Galaxy operation the browser lacks", () => {
    // Computed from galaxy-ops itself, so this holds by source, not by the golden alone.
    expect(opNames.filter((n) => !browserNames.includes(n))).toEqual([]);
  });
});
