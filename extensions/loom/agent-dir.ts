import * as path from "path";
import * as os from "os";

/**
 * Resolve pi's agent directory -- where mcp.json, sessions, and Loom's own
 * per-cwd state live. Honors PI_CODING_AGENT_DIR (set in tests and custom
 * setups), else ~/.pi/agent.
 */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}
