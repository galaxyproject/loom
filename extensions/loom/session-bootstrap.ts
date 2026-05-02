import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resetState, initSessionArtifacts, getNotebookPath } from "./state.js";
import { startGalaxyPoller, stopGalaxyPoller } from "./galaxy-poller.js";
import * as fs from "fs";
import * as path from "path";

export function registerSessionLifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setToolsExpanded(false);

    resetState();

    syncSessionJsonlSymlink(ctx);

    initSessionArtifacts(process.cwd());

    // Background poller for in-flight Galaxy invocations (#67 part 2).
    // Idempotent — start() stops any prior timer first.
    startGalaxyPoller();

    const freshSession = process.env.LOOM_FRESH_SESSION === "1";

    if (freshSession || process.argv.includes("--continue")) {
      return;
    }

    sendStartupGreeting(pi);
  });

  // Compaction recovery: snapshot the notebook so the post-compact agent can
  // re-orient by re-reading. Notebook is the source of truth — no plan struct
  // to persist.
  pi.on("session_before_compact", async () => {
    snapshotNotebook(pi);
    return {};
  });

  pi.on("session_shutdown", async () => {
    stopGalaxyPoller();
    snapshotNotebook(pi);
  });
}

function snapshotNotebook(pi: ExtensionAPI): void {
  const nbPath = getNotebookPath();
  if (!nbPath) return;
  try {
    const content = fs.readFileSync(nbPath, "utf-8");
    pi.appendEntry("notebook_snapshot", { path: nbPath, content });
  } catch (err) {
    console.error("notebook snapshot failed:", err);
  }
}

/**
 * Drop a `session.jsonl` symlink in the cwd pointing at pi's authoritative
 * session file (~/.pi/agent/sessions/<encoded-cwd>/). Best-effort.
 */
function syncSessionJsonlSymlink(ctx: ExtensionContext): void {
  try {
    const target = ctx.sessionManager?.getSessionFile?.();
    if (!target) return;
    const linkPath = path.join(process.cwd(), "session.jsonl");
    try {
      const existing = fs.lstatSync(linkPath);
      if (!existing.isSymbolicLink()) {
        console.warn("session.jsonl exists and is not a Loom symlink; leaving it untouched");
        return;
      }
      fs.unlinkSync(linkPath);
    } catch {
      // link didn't exist -- fall through to create
    }
    fs.symlinkSync(target, linkPath);
  } catch (err) {
    console.error("session.jsonl symlink failed:", err);
  }
}

function sendStartupGreeting(pi: ExtensionAPI): void {
  const hasCredentials = Boolean(process.env.GALAXY_URL && process.env.GALAXY_API_KEY);
  const isOrbit = process.env.LOOM_SHELL_KIND === "orbit";

  // Note: Galaxy MCP gets credentials via env vars; agent calls
  // galaxy_connect() if needed. Just nudge it.
  const connectInstr = hasCredentials
    ? ` Galaxy credentials are configured -- call galaxy_connect() to establish the connection.` +
      ` Do NOT call other Galaxy tools until connected.`
    : "";

  if (hasCredentials) {
    pi.sendUserMessage(
      `Session started in this project directory. Read \`notebook.md\` to see prior work. ` +
      (isOrbit
        ? `Reply with one short sentence: "What do you want to work on next?" ` +
          `No greeting, no emojis, no product branding.`
        : `Give a brief welcome, then ask what to work on next, referencing the notebook contents if there is prior work. ` +
          `Keep it to 2-3 sentences.`) +
      connectInstr
    );
    return;
  }

  pi.sendUserMessage(
    `Session started in this project directory. No Galaxy server configured. ` +
    (isOrbit
      ? `Reply with two short sentences: mention /connect for Galaxy, then ask "What do you want to work on?". ` +
        `No greeting, no emojis, no product branding.`
      : `Give a brief welcome, mention /connect to set up a Galaxy server, and ask what to work on. ` +
        `Keep it to 2-3 sentences.`)
  );
}
