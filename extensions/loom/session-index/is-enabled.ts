import { loadConfig } from "../config";
import { readEnv } from "../../../shared/orbit-env.js";

/**
 * Whether the experimental session-index tools are opted in.
 *
 * Resolution order mirrors isTeamDispatchEnabled():
 *   1. LOOM_SESSION_INDEX env var -- "1" -> on, "0" -> off, else defer.
 *   2. config.experiments.sessionIndex -- boolean.
 *   3. Default: off.
 */
export function isSessionIndexEnabled(): boolean {
  const env = readEnv("SESSION_INDEX");
  if (env === "1") return true;
  if (env === "0") return false;
  return loadConfig().experiments?.sessionIndex === true;
}
