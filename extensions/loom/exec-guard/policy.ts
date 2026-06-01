import { classifyBash } from "./bash-risk";
import { isSensitivePath, isProtectedWritePath } from "./sensitive-read";
import type { PolicyDeps, PolicyRequest, PolicyResult } from "./types";

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
// Read-like pi tools that take an optional `path`. grep reads file CONTENTS, so
// `grep <pat> ~/.ssh/id_rsa` is a credential-leak vector; ls/find/glob enumerate
// names under a path. All face the sensitive-path floor AND the workspace jail --
// a read pointed outside the work dir prompts, same as a write. A path-less call
// (e.g. grep with just a pattern) searches the cwd and is allowed.
const FILE_READ_TOOLS = new Set(["read", "grep", "ls", "find", "glob"]);

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
    const c = classifyBash(command, deps.home);
    if (c.kind === "catastrophic") {
      return { decision: "deny", category: "bash:catastrophic", reason: c.reason };
    }
    // Floor: detectable read-args of a "safe" command still face sensitive-read +
    // the workspace jail. The sensitive floor is never lifted. The out-of-workspace
    // ask IS relaxed under an active Auto sandbox (trusted models only): the sandbox
    // denies credential reads and bash network, so a non-sensitive read can't be
    // exfiltrated -- no need to prompt.
    for (const p of c.readPaths) {
      const { inside, resolved } = deps.resolver.contains(p);
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `read of sensitive path ${p}`);
      }
      if (!inside && !(req.autoSandbox && req.modelTier === "trusted")) {
        return finalizeAsk(req, "read:escape", `read outside workspace: ${p}`);
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

  if (FILE_READ_TOOLS.has(req.toolName)) {
    const p = pick(req.toolInput, "path");
    if (p) {
      const { inside, resolved } = deps.resolver.contains(p);
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `${req.toolName} of sensitive path ${p}`);
      }
      // Out-of-workspace reads prompt -- unless an active Auto sandbox has the
      // exfil path closed (trusted models only). Sensitive paths still floored above.
      if (!inside && !(req.autoSandbox && req.modelTier === "trusted")) {
        return finalizeAsk(req, "read:escape", `${req.toolName} outside workspace: ${p}`);
      }
    }
    return { decision: "allow", category: "read:ok", reason: "non-sensitive read" };
  }

  if (FILE_WRITE_TOOLS.has(req.toolName)) {
    const p = pick(req.toolInput, "path");
    if (!p) return finalizeAsk(req, "write:no-path", "write with no resolvable path");
    const { inside, resolved } = deps.resolver.contains(p);
    // Gated even inside the jail: a script under .git/hooks runs on the next git
    // operation, and .loom/ is Loom's own state -- the README promises these
    // always prompt, so they must, regardless of being in the workspace.
    if (isProtectedWritePath(resolved)) {
      return finalizeAsk(req, "write:protected", `write to protected path ${p}`);
    }
    if (inside)
      return { decision: "allow", category: "write:in-jail", reason: "write inside workspace" };
    return finalizeAsk(req, "write:escape", `write outside workspace: ${p}`);
  }

  // Everything else (Galaxy/notebook tools, etc.) is allowed.
  return { decision: "allow", category: "other", reason: "non-local-execution tool" };
}
