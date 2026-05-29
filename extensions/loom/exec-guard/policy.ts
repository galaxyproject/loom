import { classifyBash } from "./bash-risk";
import { isSensitivePath } from "./sensitive-read";
import type { PolicyDeps, PolicyRequest, PolicyResult } from "./types";

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

function pick(toolInput: Record<string, unknown>, key: string): string | undefined {
  const v = toolInput[key];
  return typeof v === "string" ? v : undefined;
}

// Apply the weak-model + non-interactive modifiers to an `ask`.
function finalizeAsk(req: PolicyRequest, category: string, reason: string): PolicyResult {
  if (req.modelTier === "weak") {
    return { decision: "deny", category, reason: `${reason} (denied: low-capability model)` };
  }
  if (!req.interactive) {
    return {
      decision: "deny",
      category,
      reason: `${reason} (denied: no interactive session to approve)`,
    };
  }
  return { decision: "ask", category, reason };
}

export function decide(req: PolicyRequest, deps: PolicyDeps): PolicyResult {
  // 1. Bypass short-circuit (human-only; see guardian-config.resolveBypass).
  if (req.config.dangerouslyBypassPermissions) {
    return { decision: "allow", category: "bypass", reason: "permissions bypassed" };
  }

  if (req.toolName === "bash") {
    const command = pick(req.toolInput, "command") ?? "";
    const c = classifyBash(command);
    if (c.kind === "catastrophic") {
      return { decision: "deny", category: "bash:catastrophic", reason: c.reason };
    }
    // Floor: detectable read-args of a "safe" command still face sensitive-read + jail.
    // This floor is never lifted by a trusted workspace.
    for (const p of c.readPaths) {
      const resolved = deps.resolver.contains(p).resolved;
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `read of sensitive path ${p}`);
      }
    }
    if (c.kind === "safe") {
      return { decision: "allow", category: "bash:safe", reason: c.reason };
    }
    // Unknown command. A trusted workspace relaxes by one notch only, and only
    // for this category: trusted model ask->allow, weak model deny->ask (the
    // human stays in the loop). It never lifts the catastrophic/jail/sensitive
    // floor above.
    if (req.config.trustedWorkspaces.includes(req.cwd)) {
      if (req.modelTier === "trusted") {
        return {
          decision: "allow",
          category: "bash:trusted-workspace",
          reason: "unknown command in trusted workspace",
        };
      }
      if (!req.interactive) {
        return {
          decision: "deny",
          category: "bash:unknown",
          reason: `${c.reason} (denied: no interactive session to approve)`,
        };
      }
      return { decision: "ask", category: "bash:trusted-workspace", reason: c.reason };
    }
    return finalizeAsk(req, "bash:unknown", c.reason);
  }

  if (req.toolName === "read") {
    const p = pick(req.toolInput, "path");
    if (p) {
      const resolved = deps.resolver.contains(p).resolved;
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `read of sensitive path ${p}`);
      }
    }
    return { decision: "allow", category: "read:ok", reason: "non-sensitive read" };
  }

  if (FILE_WRITE_TOOLS.has(req.toolName)) {
    const p = pick(req.toolInput, "path");
    if (!p) return finalizeAsk(req, "write:no-path", "write with no resolvable path");
    const { inside } = deps.resolver.contains(p);
    if (inside)
      return { decision: "allow", category: "write:in-jail", reason: "write inside workspace" };
    return finalizeAsk(req, "write:escape", `write outside workspace: ${p}`);
  }

  // Everything else (Galaxy/notebook tools, grep/find/ls) is allowed.
  return { decision: "allow", category: "other", reason: "non-local-execution tool" };
}
