/**
 * What's-new notice -- CLI-shell glue, NOT part of the loom brain.
 *
 * On the first session after an upgrade, surfaces the running version's curated
 * highlights (from the shipped CHANGELOG.md) once via ctx.ui.notify, then stamps
 * a sidecar so it shows once per upgrade. Also registers /whatsnew to re-view on
 * demand. No-ops inside Orbit, which owns its own what's-new banner. Lives here,
 * alongside cli-update, so extensions/loom/ stays shell-neutral.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// bin/ and shared/ are siblings of extensions/.
import { getLoomVersion } from "../../bin/update-check.js";
import {
  parseChangelog,
  decideWhatsNew,
  selectEntries,
  formatHighlightsText,
  releaseUrlFor,
} from "../../shared/whats-new.js";

// This file lives at <pkg>/extensions/whats-new/index.ts, so the package root is two up.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHANGELOG_PATH = path.join(PKG_ROOT, "CHANGELOG.md");
const SEEN_FILE = path.join(os.homedir(), ".loom", "whats-new-seen.json");

function loadEntries() {
  try {
    return parseChangelog(fs.readFileSync(CHANGELOG_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function readSeen(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8"));
    return typeof parsed?.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(version: string): void {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ version }));
  } catch {}
}

export default function whatsNewExtension(pi: ExtensionAPI): void {
  let shown = false;
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (shown) return;
    shown = true;
    // Orbit owns its own what's-new banner for the embedded brain.
    if (process.env.LOOM_SHELL_KIND === "orbit") return;
    try {
      const running = getLoomVersion();
      const decision = decideWhatsNew(loadEntries(), readSeen(), running, "latest");
      if (decision.entries.length) {
        const body = formatHighlightsText(decision.entries);
        ctx.ui.notify(`${body}\n  Full notes: /whatsnew  or  ${releaseUrlFor(running)}`, "info");
      }
      // Stamp even with no entries: silently advances the sidecar for versions
      // without Highlights so we don't re-check on every later launch.
      if (decision.stamp) writeSeen(decision.stamp);
    } catch {
      // A notice must never break a session.
    }
  });

  pi.registerCommand("whatsnew", {
    description: "Show what's new in this version of loom",
    handler: async (_args: string | undefined, ctx: ExtensionContext) => {
      try {
        const running = getLoomVersion();
        const entries = selectEntries(loadEntries(), undefined, running, "latest");
        if (entries.length) {
          ctx.ui.notify(
            `${formatHighlightsText(entries)}\n  Full notes: ${releaseUrlFor(running)}`,
            "info",
          );
        } else {
          ctx.ui.notify(`No what's-new notes for loom ${running}.`, "info");
        }
      } catch {
        ctx.ui.notify("Could not load what's-new notes.", "warning");
      }
    },
  });
}
