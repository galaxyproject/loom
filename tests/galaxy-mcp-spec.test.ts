import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GALAXY_MCP_SPEC } from "../shared/galaxy-mcp-spec.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The container bakes galaxy-mcp into its uv cache so a GxIT job starts without
 * PyPI. That only holds while the pre-warmed spec is the one the brain actually
 * asks for at runtime: the image once pre-warmed >=1.8.0 while mcp.json required
 * >=1.9.0, so the cached copy didn't satisfy the request and uv silently went
 * back to the network. Nothing in CI builds the image, so guard the pairing here.
 */
describe("galaxy-mcp spec lockstep", () => {
  it("Dockerfile pre-warms exactly the spec the brain requests", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf-8");
    // Deliberately a literal, not an ARG: a build arg could be overridden at
    // build time to bake a spec the runtime won't accept while this test still
    // passed against the default -- the exact drift it's here to catch.
    expect(dockerfile).toContain(`RUN uv tool install "${GALAXY_MCP_SPEC}"`);
  });

  it("has no second, unpaired galaxy-mcp install in the image", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf-8");
    const installs = dockerfile.match(/uv tool install "[^"]*"/g) ?? [];
    expect(installs).toEqual([`uv tool install "${GALAXY_MCP_SPEC}"`]);
  });

  it("bin/loom.js writes the shared constant into mcp.json, not a literal", () => {
    const loomBin = readFileSync(join(repoRoot, "bin", "loom.js"), "utf-8");
    expect(loomBin).toContain("args: [GALAXY_MCP_SPEC]");
    expect(loomBin).not.toMatch(/args: \["galaxy-mcp/);
  });
});
