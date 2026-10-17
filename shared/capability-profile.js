import { isDesktopShell, readEnv } from "./orbit-env.js";

/**
 * What the shell running the brain can do, in one place, so the brain asks
 * "is there a local shell?" rather than which env var a particular shell sets.
 *
 * Today only the Node shells exist, and they describe themselves through env:
 * - LOCAL_EXEC=off: no local execution surface at all (the web/container
 *   remote shell), so no local files and the shell owns the tool_call gate.
 * - LOCAL_SHELL=off: files stay, the bash shell goes (the Windows remote-only
 *   desktop).
 * The two are read independently, as they always have been: LOCAL_EXEC=off
 * does not by itself mark the shell unavailable. Both fail safe -- only the
 * exact value "off" turns a surface off.
 *
 * The other fields have one value under every Node shell and no env var behind
 * them; they are here so a shell that differs (the browser worker) has
 * somewhere to say so. The browser worker has no env to set, so it installs
 * its profile as an object with setCapabilityProfile instead.
 *
 * @typedef {object} CapabilityProfile
 * @property {boolean} shell a local bash shell
 * @property {boolean} files a local file surface, which exec-guard jails
 * @property {"file" | "page"} notebook where the notebook lives
 * @property {boolean} network direct outbound network from the brain
 * @property {"mcp" | "bare"} galaxyTools how Galaxy tools are named to the model
 * @property {boolean} mcpServers pi's MCP layer, for the servers Loom brings
 *   (brc-analytics; galaxy-mcp too under mcp Galaxy tools)
 * @property {"desktop" | "terminal" | "worker"} ui the surface a human answers prompts on
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {CapabilityProfile}
 */
export function profileFromEnv(env = process.env) {
  return {
    shell: readEnv("LOCAL_SHELL", env) !== "off",
    files: readEnv("LOCAL_EXEC", env) !== "off",
    notebook: "file",
    network: true,
    galaxyTools: "mcp",
    mcpServers: true,
    ui: isDesktopShell(env) ? "desktop" : "terminal",
  };
}

let installed = null;
// Who installed the profile, kept beside it: a brain module reloaded by pi comes back with its
// own state reset while this module stays cached, so only this survives to say whose it is.
let installedOwner = null;

/**
 * The shell's own description of itself; null puts env back in charge.
 * `owner` tags an install made by the brain itself rather than a shell.
 * @param {CapabilityProfile | null} profile
 * @param {string | null} [owner]
 */
export function setCapabilityProfile(profile, owner = null) {
  installed = profile ? { ...profile } : null;
  installedOwner = installed ? owner : null;
}

/**
 * The owner tag the installed profile was set with, or null for a shell's
 * install or when nothing is installed.
 * @returns {string | null}
 */
export function installedCapabilityProfileOwner() {
  return installedOwner;
}

/**
 * The installed profile itself (the same object capabilityProfile() returns),
 * or null when env is in charge.
 * @returns {CapabilityProfile | null}
 */
export function installedCapabilityProfile() {
  return installed;
}

/**
 * The profile the brain acts on: the installed one, else env. An explicit env
 * always means "read env", the way galaxyCredentials(env) does, so pure helpers
 * and tests never see a shell's object.
 * @param {Record<string, string | undefined>} [env]
 * @returns {CapabilityProfile}
 */
export function capabilityProfile(env) {
  if (!env && installed) return installed;
  return profileFromEnv(env);
}
