/**
 * Orbit hand-off — terminal-CLI shell glue, deliberately NOT part of the loom
 * brain.
 *
 * All Orbit-specific knowledge (install paths, bundle layout, the `--cwd`
 * launch protocol, the release URL) lives here so `extensions/loom/` stays
 * shell-neutral. bin/loom.js loads this extension alongside the brain; because
 * the same bin/loom.js also runs as Orbit's embedded brain, the handler no-ops
 * when it's already inside Orbit rather than handing the session off to itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findOrbit, launchOrbit } from "./orbit-launcher";

const RELEASE_URL = "https://github.com/galaxyproject/loom/releases";

export async function handleOrbitHandoff(
  _args: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  // Already inside Orbit: there's nothing to hand off to, and shutting down
  // here would just tear the embedded session down. No-op with a note.
  if (process.env.LOOM_SHELL_KIND === "orbit") {
    ctx.ui.notify("You're already in Orbit -- nothing to hand off to.", "info");
    return;
  }

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
    // ctx.shutdown() awaits the session_shutdown lifecycle (notebook summary,
    // galaxy poller stop) before quitting -- no race with process.exit.
    ctx.shutdown();
  } catch (err) {
    ctx.ui.notify(
      `Failed to launch Orbit at ${orbitPath}: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

export default function orbitHandoffExtension(pi: ExtensionAPI): void {
  pi.registerCommand("orbit", {
    description: "Hand off this session to the Orbit desktop app",
    handler: handleOrbitHandoff,
  });
}
