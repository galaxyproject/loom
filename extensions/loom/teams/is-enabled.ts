import { loadConfig } from "../config";
import { readEnv } from "../../../shared/orbit-env.js";

/**
 * Whether the experimental team_dispatch tool is opted in.
 *
 * Resolution order (env wins so a developer can flip it for one session
 * without touching ~/.loom/config.json):
 *   1. LOOM_TEAM_DISPATCH env var -- "1" -> on, "0" -> off (explicit
 *      override of an on-config), anything else -> defer to config.
 *   2. config.experiments.teamDispatch -- boolean.
 *   3. Default: off.
 *
 * Intended to be called once at extension boot, not in a hot path --
 * each call hits loadConfig() / disk.
 */
export function isTeamDispatchEnabled(): boolean {
  const env = readEnv("TEAM_DISPATCH");
  if (env === "1") return true;
  if (env === "0") return false;
  return loadConfig().experiments?.teamDispatch === true;
}
