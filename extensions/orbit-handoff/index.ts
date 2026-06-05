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
    // We deliberately do NOT auto-close the CLI. ctx.shutdown() only sets a flag
    // that pi's interactive mode reads at agent_end, so a slash command can't
    // trigger a graceful exit (terminal restore + the session_shutdown lifecycle),
    // and a bare process.exit() would leave the terminal in raw mode. So we launch
    // and ask the user to close the CLI themselves. (Orbit's embedded RPC brain
    // honors shutdown-from-command; the terminal CLI doesn't yet -- once it does,
    // this can move the launch into a session_shutdown handler and exit cleanly.)
    ctx.ui.notify(
      `Orbit is opening on ${ctx.cwd} (pid ${result.pid ?? "?"}). Your work continues there -- ` +
        `press Ctrl-D or type /exit to close this CLI so both don't write the same notebook.`,
      "info",
    );
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
