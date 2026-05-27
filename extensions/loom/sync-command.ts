/**
 * /sync command -- user-facing entry point to the three sync tools.
 *
 * Subcommands: status, push, pull, link. Same semantics as the
 * notebook_*_galaxy tools (they share the underlying helpers in
 * galaxy-pages-sync.ts); /sync just gives the user a direct way to invoke
 * them from the chat without going through the agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getNotebookPath } from "./state";
import { readNotebook } from "./notebook-writer";
import { findGalaxyPageBlocks } from "./galaxy-page-binding";
import {
  pushNotebookToGalaxy,
  pullNotebookFromGalaxy,
  linkGalaxyPage,
  resumeGalaxyPage,
} from "./galaxy-pages-sync";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | undefined>;
}

function parseFlags(input: string): ParsedFlags {
  const tokens = input.match(/(?:--[a-z-]+(?:=(?:"[^"]*"|\S+))?|"[^"]*"|\S+)/gi) ?? [];
  const positional: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq >= 0) {
        const k = t.slice(2, eq);
        const v = t.slice(eq + 1).replace(/^"|"$/g, "");
        flags[k] = v;
      } else {
        const k = t.slice(2);
        const next = tokens[i + 1];
        if (next && !next.startsWith("--")) {
          flags[k] = next.replace(/^"|"$/g, "");
          i++;
        } else {
          flags[k] = "";
        }
      }
    } else {
      positional.push(t.replace(/^"|"$/g, ""));
    }
  }
  return { positional, flags };
}

export function registerSyncCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sync", {
    description:
      "Sync notebook.md with a Galaxy page. Subcommands: status | push [--history H --title T --slug S --annotation A] | pull | link <page_id> [--history H] | resume <page_id> [--history H]",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: string, ctx: any) => {
      const trimmed = (args ?? "").trim();
      const firstSpace = trimmed.indexOf(" ");
      const subcommand = firstSpace === -1 ? trimmed || "status" : trimmed.slice(0, firstSpace);
      const tail = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
      const { positional, flags } = parseFlags(tail);

      try {
        if (subcommand === "status") {
          const nbPath = getNotebookPath();
          if (!nbPath) {
            ctx.ui.notify("No active loom session; nothing to sync.", "warning");
            return;
          }
          const content = await readNotebook(nbPath);
          const binding = findGalaxyPageBlocks(content)[0];
          if (!binding) {
            ctx.ui.notify(
              "Notebook is not bound to a Galaxy page. Use `/sync push --history <id>` to create one, or `/sync link <page_id>` to link an existing page.",
              "info",
            );
            return;
          }
          ctx.ui.notify(
            `Bound to ${binding.galaxyServerUrl} (page_id=${binding.pageId}, slug=${binding.pageSlug ?? "<none>"}, last_synced_revision=${binding.lastSyncedRevision ?? "<none>"})`,
            "info",
          );
          return;
        }

        if (subcommand === "push") {
          const result = await pushNotebookToGalaxy({
            historyId: flags.history,
            title: flags.title,
            slug: flags.slug,
            annotation: flags.annotation,
          });
          ctx.ui.notify(
            `Pushed: ${result.action} page ${result.pageId} (revision ${result.latestRevisionId}).`,
            "info",
          );
          return;
        }

        if (subcommand === "pull") {
          const result = await pullNotebookFromGalaxy();
          ctx.ui.notify(
            `Pulled page ${result.pageId} (revision ${result.latestRevisionId}). Notebook updated.`,
            "info",
          );
          return;
        }

        if (subcommand === "link") {
          const pageId = positional[0];
          if (!pageId) {
            ctx.ui.notify("Usage: /sync link <page_id> [--history <id>]", "warning");
            return;
          }
          const result = await linkGalaxyPage(pageId, {
            historyId: flags.history,
          });
          ctx.ui.notify(
            `Linked to page ${result.pageId} (revision ${result.latestRevisionId}).`,
            "info",
          );
          return;
        }

        if (subcommand === "resume") {
          const pageId = positional[0];
          if (!pageId) {
            ctx.ui.notify("Usage: /sync resume <page_id> [--history <id>]", "warning");
            return;
          }
          const result = await resumeGalaxyPage(pageId, {
            historyId: flags.history,
          });
          ctx.ui.notify(
            `Resumed page ${result.pageId} (${result.action}, revision ${result.latestRevisionId}). Notebook updated.`,
            "info",
          );
          return;
        }

        ctx.ui.notify(
          `Unknown /sync subcommand: ${subcommand}. Use status, push, pull, link, or resume.`,
          "warning",
        );
      } catch (e) {
        ctx.ui.notify(
          `/sync ${subcommand}: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });
}
