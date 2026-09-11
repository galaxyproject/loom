/**
 * /instructions -- show which LOOM.md files this session actually loaded.
 *
 * Without this, "why isn't it listening to me" is undebuggable: the ancestor
 * walk means a LOOM.md three directories up can be steering the session with
 * nothing on screen to say so.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./agent-dir.js";
import {
  discoverInstructionFiles,
  INSTRUCTIONS_FILENAME,
  type InstructionFile,
} from "./user-instructions.js";

/**
 * Shown in the terminal after `init`, deliberately NOT written into the file.
 *
 * An earlier design seeded the file with `#`-prefixed example lines and called
 * them comments. Markdown has no comment syntax -- those are headings, and the
 * loader injects whatever is in the file -- so an untouched template would have
 * silently activated "prefer IWC workflows" and the rest as real preferences.
 * The file starts empty; the guidance lives here.
 */
export const AUTHORING_GUIDANCE = [
  "Write one preference per line, in plain sentences. For example:",
  "",
  "  Always end an analysis with a visualization.",
  "  Prefer IWC workflows over hand-assembled tool chains.",
  "  Use HISAT2 for RNA-seq alignment, not bowtie.",
  "",
  "Edits load on your next message -- no restart needed.",
].join("\n");

function label(scope: InstructionFile["scope"]): string {
  return scope === "global" ? "Global " : "Project";
}

export function formatInstructionsListing(files: InstructionFile[]): string {
  if (files.length === 0) {
    return [
      "No standing instructions loaded.",
      "",
      `Create one with  /instructions init          -> ${path.join(piAgentDir(), INSTRUCTIONS_FILENAME)}`,
      `or               /instructions init project  -> ${INSTRUCTIONS_FILENAME} in this directory`,
    ].join("\n");
  }

  const lines: string[] = ["Standing instructions loaded this session:", ""];
  for (const file of files) {
    if (file.error) {
      lines.push(`${label(file.scope)}  ${file.path}`);
      lines.push(`  !! could not be read: ${file.error}`);
      lines.push("");
      continue;
    }
    const count = file.content.split("\n").length;
    const suffix = file.truncated ? ", truncated at the size cap" : "";
    lines.push(
      `${label(file.scope)}  ${file.path}  (${count} line${count === 1 ? "" : "s"}${suffix})`,
    );
    for (const line of file.content.split("\n")) lines.push(`  ${line}`);
    lines.push("");
  }

  if (files.some((f) => f.scope === "workspace")) {
    lines.push(
      "Project files travel with the directory, so they steer preferences only --",
      "they cannot grant permissions or skip confirmations.",
    );
  }

  return lines.join("\n").trimEnd();
}

/** Create an EMPTY file if it isn't there. Returns what happened so the caller
 *  can tell the user rather than silently doing nothing. */
export function ensureInstructionsFile(filePath: string): { created: boolean; error?: string } {
  try {
    if (fs.existsSync(filePath)) return { created: false };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
    return { created: true };
  } catch (err) {
    return { created: false, error: String(err) };
  }
}

export function registerInstructionsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("instructions", {
    description: "Show the LOOM.md standing instructions loaded this session (init to create one).",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);

      if (argv.length === 0) {
        ctx.ui.notify(formatInstructionsListing(discoverInstructionFiles()), "info");
        return;
      }

      if (argv[0] !== "init") {
        ctx.ui.notify(
          "Usage: /instructions                   show what's loaded\n" +
            "       /instructions init            create your global LOOM.md\n" +
            "       /instructions init project    create LOOM.md in this directory",
          "warning",
        );
        return;
      }

      const target =
        argv[1] === "project"
          ? path.join(process.cwd(), INSTRUCTIONS_FILENAME)
          : path.join(piAgentDir(), INSTRUCTIONS_FILENAME);

      const result = ensureInstructionsFile(target);
      if (result.error) {
        ctx.ui.notify(`Could not create ${target}: ${result.error}`, "error");
        return;
      }
      const opener = result.created ? `Created ${target} (empty).` : `${target} already exists.`;
      ctx.ui.notify(`${opener}\n\n${AUTHORING_GUIDANCE}`, "info");
    },
  });
}
