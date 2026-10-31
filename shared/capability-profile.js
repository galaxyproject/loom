import { installedCapabilityProfile } from "./capability-profile-installed.js";
import { isDesktopShell, readEnv } from "./orbit-env.js";

export {
  authRemedy,
  DEFAULT_AUTH_REMEDY,
  installedCapabilityProfile,
  setCapabilityProfile,
} from "./capability-profile-installed.js";

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
 * @property {boolean} mcpServers pi's MCP layer, for the servers Orbit brings
 *   (brc-analytics)
 * @property {"desktop" | "terminal" | "worker"} ui the surface a human answers prompts on
 * @property {boolean} [python] an in-brain Python runtime (the browser's Pyodide), apart from
 *   whatever the local shell offers; no Node shell has one
 * @property {"read" | "write"} [galaxy] whether the brain may change Galaxy. Under "read" it
 *   registers no tool that writes Galaxy or the analysis record. Every Node shell writes; a shell
 *   with a local shell couldn't hold to "read" anyway, since bash can reach Galaxy itself.
 * @property {string} [authRemedy] what the model should ask of the user when Galaxy refuses the
 *   credentials, as an imperative with no closing period. The Node shells have /connect; the
 *   browser worker rides the Galaxy page's own sign-in.
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
    mcpServers: true,
    ui: isDesktopShell(env) ? "desktop" : "terminal",
    python: false,
    galaxy: "write",
  };
}

/**
 * The profile the brain acts on: the installed one, else env. An explicit env
 * always means "read env", the way galaxyCredentials(env) does, so pure helpers
 * and tests never see a shell's object.
 * @param {Record<string, string | undefined>} [env]
 * @returns {CapabilityProfile}
 */
export function capabilityProfile(env) {
  const installed = installedCapabilityProfile();
  if (!env && installed) return installed;
  return profileFromEnv(env);
}
