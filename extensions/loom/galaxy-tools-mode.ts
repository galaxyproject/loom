/**
 * The desktop's switch between galaxy-mcp (the default) and the in-process
 * Galaxy tools, until the in-process path becomes the only one.
 *
 * A shell with its own idea of the profile (the browser worker) installs it
 * before the brain loads, and this leaves that alone; the switch only ever
 * describes a Node shell that would otherwise read its profile from env.
 */
import { readEnv } from "../../shared/orbit-env.js";
import {
  installedCapabilityProfile,
  installedCapabilityProfileOwner,
  profileFromEnv,
  setCapabilityProfile,
} from "../../shared/capability-profile.js";
import { loadConfig } from "./config";

export type GalaxyToolsMode = "bare" | "mcp";

/** LOOM_GALAXY_TOOLS, then experiments.galaxyTools, else mcp. Env wins, as with autoResume. */
export function galaxyToolsMode(env: NodeJS.ProcessEnv = process.env): GalaxyToolsMode {
  // The web container forwards LOOM_* to the brain wholesale and its gate knows
  // only the MCP spellings, so a flag meant for someone's desktop must not flip
  // it into names the gate would refuse.
  if (readEnv("LOCAL_EXEC", env) === "off") return "mcp";
  const v = readEnv("GALAXY_TOOLS", env)?.trim().toLowerCase();
  if (v === "bare" || v === "mcp") return v;
  return loadConfig().experiments?.galaxyTools === "bare" ? "bare" : "mcp";
}

// Tags the profile this module installs, so a reload that turns the flag back off takes it down
// again and a shell's own install is never mistaken for it. The tag lives with the installed
// profile, not here: pi reloads this module fresh, but the profile module stays cached.
const OWNER = "loom:galaxy-tools-mode";

/**
 * Install a bare profile when the switch says bare, and only then: under mcp
 * env stays in charge, exactly as it was before the switch existed.
 */
export function applyGalaxyToolsMode(): void {
  const mine = installedCapabilityProfileOwner() === OWNER;
  if (installedCapabilityProfile() && !mine) return;
  if (galaxyToolsMode() === "bare") {
    setCapabilityProfile({ ...profileFromEnv(), galaxyTools: "bare" }, OWNER);
  } else if (mine) {
    setCapabilityProfile(null);
  }
}
