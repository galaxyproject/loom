import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "os";
import * as path from "path";
import { getNotebookPath } from "../state";
import { appendActivityEvent } from "../activity";
import { redactArgs } from "../activity-hooks";
import {
  loadGuardianConfig,
  resolveBypass,
  trustWorkspace,
  recordConsent,
} from "./guardian-config";
import { createPathResolver } from "./path-jail";
import { classifyModelTier } from "./model-tier";
import { decide } from "./policy";
import { CONSENT_VERSION, type PolicyResult } from "./types";

// In-memory "allow for this session" set, keyed by tool + raw input signature.
const sessionAllow = new Set<string>();
function sig(toolName: string, input: Record<string, unknown>): string {
  return toolName + ":" + JSON.stringify(input);
}

function audit(
  toolName: string,
  input: Record<string, unknown>,
  result: PolicyResult,
  outcome: string,
): void {
  const nb = getNotebookPath();
  if (!nb) return;
  appendActivityEvent(path.dirname(nb), {
    timestamp: new Date().toISOString(),
    kind: "guard.decision",
    source: "exec-guard",
    payload: {
      toolName,
      decision: result.decision,
      category: result.category,
      reason: result.reason,
      outcome,
      args: redactArgs(toolName, input),
    },
  });
}

export function registerExecGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const config = loadGuardianConfig();
    if (!config.enabled) return; // gate fully disabled (advanced escape hatch)
    // Fold the effective bypass back into the config the pure engine sees.
    config.dangerouslyBypassPermissions = resolveBypass(config);

    const input = event.input as Record<string, unknown>;
    const cwd = ctx.cwd;
    const roots = [cwd, os.tmpdir(), path.join(cwd, ".loom"), ...config.extraWorkspaceRoots];
    const resolver = createPathResolver(roots);

    let result: PolicyResult;
    try {
      result = decide(
        {
          toolName: event.toolName,
          toolInput: input,
          modelTier: classifyModelTier(ctx.model),
          config,
          interactive: ctx.hasUI,
          cwd,
        },
        { resolver, home: os.homedir() },
      );
    } catch {
      const reason = "exec-guard internal error; failing closed";
      audit(event.toolName, input, { decision: "deny", category: "error", reason }, "blocked");
      return { block: true, reason };
    }

    if (result.decision === "allow") {
      audit(event.toolName, input, result, "allowed");
      return;
    }
    if (result.decision === "deny") {
      audit(event.toolName, input, result, "blocked");
      return { block: true, reason: result.reason };
    }

    // ask: session memory first.
    if (sessionAllow.has(sig(event.toolName, input))) {
      audit(event.toolName, input, result, "allowed:session");
      return;
    }

    // One-time local-execution disclosure on the first gated action. Relies on
    // the persisted flag (saveConfig is synchronous), so a failed save simply
    // re-discloses rather than silently proceeding.
    if (!config.consentAcknowledged) {
      const ok = await ctx.ui.confirm(
        "Loom runs actions on your computer",
        "Loom can run shell commands and read/write files as you. Commands from the AI are gated, but no gate is perfect -- only use it in workspaces you trust. Continue?",
        {},
      );
      if (!ok) {
        audit(event.toolName, input, result, "blocked:consent-declined");
        return { block: true, reason: "Local execution not consented." };
      }
      recordConsent(CONSENT_VERSION);
    }

    const modelName = ctx.model?.id ?? "the model";
    const detail =
      event.toolName === "bash"
        ? `run: ${String(input.command ?? "").slice(0, 200)}`
        : `${event.toolName}: ${String(input.path ?? "")}`;
    const choice = await ctx.ui.select(
      `Allow ${modelName} to ${detail}?`,
      [
        "Allow once",
        "Allow for this session",
        "Trust this workspace (stop asking for routine commands)",
        "Deny",
      ],
      {},
    );
    if (choice === "Allow once") {
      audit(event.toolName, input, result, "allowed:once");
      return;
    }
    if (choice === "Allow for this session") {
      sessionAllow.add(sig(event.toolName, input));
      audit(event.toolName, input, result, "allowed:session");
      return;
    }
    if (choice && choice.startsWith("Trust this workspace")) {
      trustWorkspace(cwd);
      audit(event.toolName, input, result, "allowed:trust-workspace");
      return;
    }
    audit(event.toolName, input, result, "blocked:user");
    return { block: true, reason: "Denied by user." };
  });
}
