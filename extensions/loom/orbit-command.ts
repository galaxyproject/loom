import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findOrbit, launchOrbit } from "./orbit-launcher";

const RELEASE_URL = "https://github.com/galaxyproject/loom/releases";

export function registerOrbitCommand(pi: ExtensionAPI): void {
  const handler = async (_args: string | undefined, ctx: ExtensionContext) => {
    const orbitPath = findOrbit();
    if (!orbitPath) {
      ctx.ui.notify(
        `Orbit is not installed. Grab a release for your platform from ${RELEASE_URL}, ` +
          `then run /orbit again. (If Orbit is installed in a non-standard location, ` +
          `set ORBIT_BIN to the binary path.)`,
        "warning",
      );
      return;
    }

    try {
      const result = launchOrbit(orbitPath, ctx.cwd);
      ctx.ui.notify(
        `Launching Orbit (pid ${result.pid ?? "?"}) on ${ctx.cwd}. ` +
          `Closing this CLI session -- your work continues in Orbit.`,
        "info",
      );
      // ctx.shutdown() awaits the session_shutdown lifecycle (notebook
      // summary, galaxy poller stop) before quitting -- no race with
      // process.exit. Documented on ExtensionContext as "Gracefully
      // shutdown pi and exit. Available in all contexts."
      ctx.shutdown();
    } catch (err) {
      ctx.ui.notify(
        `Failed to launch Orbit at ${orbitPath}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  pi.registerCommand("orbit", {
    description: "Hand off this session to the Orbit desktop app",
    handler,
  });
}
