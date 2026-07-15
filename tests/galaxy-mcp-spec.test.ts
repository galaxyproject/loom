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
    const arg = dockerfile.match(/^ARG GALAXY_MCP_SPEC="([^"]+)"$/m);
    expect(arg, 'Dockerfile should declare ARG GALAXY_MCP_SPEC="..."').not.toBeNull();
    expect(arg![1]).toBe(GALAXY_MCP_SPEC);
  });

  it("installs from the ARG rather than a second hardcoded spec", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain('RUN uv tool install "${GALAXY_MCP_SPEC}"');
    // A literal `uv tool install "galaxy-mcp..."` would dodge the ARG (and this
    // test's pairing) even while the ARG stays correct.
    expect(dockerfile).not.toMatch(/uv tool install "galaxy-mcp/);
  });

  it("bin/loom.js writes the shared constant into mcp.json, not a literal", () => {
    const loomBin = readFileSync(join(repoRoot, "bin", "loom.js"), "utf-8");
    expect(loomBin).toContain("args: [GALAXY_MCP_SPEC]");
    expect(loomBin).not.toMatch(/args: \["galaxy-mcp/);
  });
});
