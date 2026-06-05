/**
 * CLI update notice -- terminal-CLI shell glue, NOT part of the loom brain.
 *
 * Surfaces the cached "update available" notice (computed by bin/update-check.js)
 * once per session via ctx.ui.notify. Lives here, alongside orbit-handoff, so
 * extensions/loom/ stays shell-neutral. No-ops inside Orbit (which owns its own
 * updates) and when update checks are disabled.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// bin/ is a sibling of extensions/; this resolves to <pkg>/bin/update-check.js.
import { readNotice } from "../../bin/update-check.js";

export default function cliUpdateExtension(pi: ExtensionAPI): void {
  let shown = false;
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (shown) return;
    shown = true;
    // Orbit owns updates for its embedded brain; the bundled CLI copy can't be
    // npm-updated. LOOM_NO_UPDATE_CHECK is set by bin/loom.js from the config
    // flag / --no-update-check.
    if (process.env.LOOM_SHELL_KIND === "orbit") return;
    if (process.env.LOOM_NO_UPDATE_CHECK === "1") return;
    try {
      const notice = readNotice();
      if (notice) ctx.ui.notify(notice, "info");
    } catch {
      // A notice must never break a session.
    }
  });
}
