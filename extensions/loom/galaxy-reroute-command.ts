/** Human controls for routing. Slash commands are not expanded by model tools. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getNotebookPath } from "./state.js";
import { getSessionRegistry } from "./registry-runtime.js";
import {
  listGalaxyConnections,
  resolveGalaxyConnection,
  verifyGalaxyAccount,
} from "./galaxy-connections.js";
import { GalaxyRerouter, type ReroutePlan } from "./galaxy-reroute.js";

const tasks = new Map<string, AbortController>();
function preflight(plan: ReroutePlan): string {
  return [
    `Run: ${plan.label || plan.sourceId}`,
    `From: ${plan.source.name} (${plan.source.url}) · account ${plan.source.accountId}`,
    `To: ${plan.destination.name} (${plan.destination.url}) · account ${plan.destination.accountId}`,
    `Target: ${plan.target.tool_id || plan.target.tool_uuid || "workflow"} · version ${plan.target.version}`,
    `Inputs: ${plan.inputs.length}; ${(plan.transferBytes / 1024 ** 3).toFixed(3)} GiB before checksum verification reads.`,
    `Original parameters: ${JSON.stringify(plan.kind === "job" ? plan.request.inputs : { inputs: plan.request.inputs, parameters: plan.request.parameters })}`,
    "Private inputs use an authenticated relay with temporary local storage. Dataset content and collection pairing are verified.",
    "A new history and a new execution attempt will be created. Original histories and outputs are preserved.",
    "Outputs still need verification before the analysis continues.",
  ].join("\n");
}

export function registerGalaxyRerouting(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "galaxy_connections",
    label: "Galaxy connections",
    description:
      "List simultaneous named Galaxy connections, their verified accounts, and explicit MCP tool namespaces. Other servers' runs must keep their origin; changing the default affects new work only.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const connections = await Promise.all(
        listGalaxyConnections().map(async (c) => {
          try {
            const verified = await verifyGalaxyAccount(c, signal);
            return {
              id: c.id,
              name: c.name,
              url: c.url,
              mcpServer: c.mcpServer,
              accountId: verified.accountId,
              username: verified.username,
              available: true,
            };
          } catch (error) {
            return {
              id: c.id,
              name: c.name,
              url: c.url,
              mcpServer: c.mcpServer,
              available: false,
              error: (error as Error).message,
            };
          }
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ connections }) }],
        details: { connections },
      };
    },
  });
  pi.registerCommand("reroute", {
    description:
      "Run a recorded Galaxy job/workflow on another instance; preflight and human approval precede transfer or submission.",
    async handler(args, ctx) {
      const registry = getSessionRegistry();
      const notebook = getNotebookPath();
      if (!registry || registry.store.mode !== "writer" || !notebook) {
        ctx.ui.notify("The analysis registry is not writable.", "error");
        return;
      }
      const reconcile = args.trim().match(/^reconcile\s+([A-Z0-9]+)(?:\s+([a-zA-Z0-9_,:-]+))?$/);
      if (reconcile) {
        try {
          const result = await new GalaxyRerouter(registry.store, notebook).reconcile(
            reconcile[1],
            reconcile[2]?.split(","),
          );
          ctx.ui.notify(
            `Reroute ${result.id}: verified receipt restored. No new submission was sent.`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
        return;
      }
      const status = args.trim().match(/^status\s+([A-Z0-9]+)$/);
      if (status) {
        const route = registry.store.snapshot().reroutes?.[status[1]];
        ctx.ui.notify(
          route
            ? `Reroute ${route.id}: ${route.phase}. ${route.error || ""}${route.history_id ? ` Destination history: ${route.history_id}.` : ""} For an uncertain receipt, use /reroute reconcile <reroute-id> <destination-run-id>. This never resubmits.`
            : "Reroute not found.",
          route?.error ? "warning" : "info",
        );
        return;
      }
      const cancel = args.trim().match(/^cancel\s+([A-Z0-9]+)$/);
      if (cancel) {
        const task = tasks.get(cancel[1]);
        if (task) task.abort();
        else new GalaxyRerouter(registry.store, notebook).cancelPrepared(cancel[1]);
        ctx.ui.notify(
          "Reroute cancellation requested. Any accepted remote work remains recorded.",
          "info",
        );
        return;
      }
      try {
        if (!ctx.hasUI) throw new Error("Rerouting requires an interactive destination review.");
        const input = JSON.parse(args) as {
          kind: "job" | "invocation";
          id: string;
          source: string;
        };
        if (
          !["job", "invocation"].includes(input.kind) ||
          typeof input.id !== "string" ||
          typeof input.source !== "string"
        )
          throw new Error(
            "Use the Activity panel's Run elsewhere button, or /reroute with {kind,id,source} JSON.",
          );
        const source = resolveGalaxyConnection(input.source);
        const candidates = listGalaxyConnections().filter((c) => c.id !== source.id);
        if (!candidates.length)
          throw new Error("Add another Galaxy connection in Preferences first.");
        const choices = candidates.map((c) => `${c.name} — ${c.url}`);
        const selected = await ctx.ui.select("Run elsewhere — destination", choices);
        if (!selected) return;
        const destination = candidates[choices.indexOf(selected)];
        const rerouter = new GalaxyRerouter(registry.store, notebook, {
          progress: (message) => ctx.ui.notify(message, "info"),
        });
        ctx.ui.notify("Checking accounts, exact tool versions and source inputs…", "info");
        const { route, plan } = await rerouter.prepare(
          input.kind,
          input.id,
          source.id,
          destination.id,
        );
        const policy = await ctx.ui.select("Original attempt", [
          "Cancel and confirm before submitting the replacement",
          "Allow both attempts to run; use the replacement after verification",
        ]);
        if (!policy) {
          rerouter.cancelPrepared(route.id);
          return;
        }
        const allowOverlap = policy.startsWith("Allow");
        const approved = await ctx.ui.confirm(
          "Approve reroute",
          preflight(plan) +
            `\n\nOriginal attempt: ${allowOverlap ? "overlapping execution explicitly allowed" : "cancel and confirm before replacement"}.`,
        );
        if (!approved) {
          rerouter.cancelPrepared(route.id);
          return;
        }
        const controller = new AbortController();
        tasks.set(route.id, controller);
        ctx.ui.notify(
          `Reroute ${route.id} started. Stop staging with /reroute cancel ${route.id}.`,
          "info",
        );
        // Keep chat usable while bytes move. The registry is the recovery record;
        // a restart never automatically replays this transaction.
        void rerouter
          .execute(route.id, { allowOverlap, signal: controller.signal })
          .then((result) => {
            pi.sendMessage({
              customType: "galaxy-reroute",
              content: `Reroute ${result.id}: replacement submitted on ${destination.name}. Outputs require verification.`,
              display: true,
            });
          })
          .catch((error) => {
            ctx.ui.notify(`Reroute ${route.id}: ${(error as Error).message}`, "error");
          })
          .finally(() => tasks.delete(route.id));
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
  pi.on("session_shutdown", () => {
    for (const controller of tasks.values()) controller.abort();
    tasks.clear();
  });
}
