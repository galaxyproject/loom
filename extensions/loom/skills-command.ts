import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshAllCatalogs, catalogSummary } from "./skills-discovery";

export function registerSkillsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("skills", {
    description: "Manage skill catalogs. Subcommands: status (default) | refresh",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: string, ctx: any) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      try {
        if (sub === "refresh") {
          ctx.ui.notify("Refreshing skill catalogs…", "info");
          const results = await refreshAllCatalogs();
          const summary = results
            .map((r) => (r.ok ? `${r.repo}: ${r.count}` : `${r.repo}: failed (${r.error})`))
            .join(", ");
          ctx.ui.notify(`Skills refreshed (${summary}). Takes effect next session.`, "info");
          return;
        }
        // status (default)
        const summary = catalogSummary()
          .map((r) => `${r.repo}: ${r.count} skill(s) cached`)
          .join("\n");
        ctx.ui.notify(summary || "No skill repos enabled.", "info");
      } catch (err) {
        ctx.ui.notify(
          `/skills ${sub}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
