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
 * somewhere to say so.
 *
 * @typedef {object} CapabilityProfile
 * @property {boolean} shell a local bash shell
 * @property {boolean} files a local file surface, which exec-guard jails
 * @property {"file" | "page"} notebook where the notebook lives
 * @property {boolean} network direct outbound network from the brain
 * @property {"mcp" | "bare"} galaxyTools how Galaxy tools are named to the model
 * @property {"desktop" | "terminal"} ui the surface a human answers prompts on
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
    ui: isDesktopShell(env) ? "desktop" : "terminal",
  };
}
