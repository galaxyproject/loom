/**
 * The single source of truth for which galaxy-mcp the brain launches.
 *
 * bin/loom.js writes this into ~/.loom/agent/mcp.json as the `uvx` argument, so
 * it is what actually gets resolved at runtime. The container image pre-warms
 * the SAME spec into its uv cache (see the Dockerfile) so a GxIT job can start
 * without reaching PyPI -- a pre-warm of anything the runtime spec doesn't
 * accept silently reintroduces a network dependency at launch.
 * tests/galaxy-mcp-spec.test.ts guards that pairing.
 */
export const GALAXY_MCP_SPEC = "galaxy-mcp>=1.9.0";
