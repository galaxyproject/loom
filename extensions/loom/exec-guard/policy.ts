import { classifyBash } from "./bash-risk";
import { isSensitivePath, isCredentialStore, isProtectedWritePath } from "./sensitive-read";
import type { PolicyDeps, PolicyRequest, PolicyResult } from "./types";

// A dedicated credential store's CONTENTS are never readable by the agent --
// denied for every tier, not downgraded to an ask. This is the floor that closes
// #183: a capable model that gets to read ~/.loom/config.json echoes the keys
// straight into the provider's request logs. Approval can't override it.
function denyCredentialStore(p: string): PolicyResult {
  return {
    decision: "deny",
    category: "read:credential-store",
    reason: `access to credential store ${p} blocked for all models`,
  };
}

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

  // pi emits its built-in file tools lowercase ("bash"/"read"/"write"/"edit"); we
  // normalize so a future capitalized or renamed emission can't slip past the jail
  // into the "other -> allow" bucket. (Verified: pi has exactly write+edit, lowercase.)
  const toolName = req.toolName.toLowerCase();

  if (toolName === "bash") {
    const command = pick(req.toolInput, "command") ?? "";
    const c = classifyBash(command, deps.home);
    if (c.kind === "catastrophic") {
      return { decision: "deny", category: "bash:catastrophic", reason: c.reason };
    }
    // Sensitive-read floor: every content-read target, including inside a pipe or
    // compound command (closes the `cat secret | tool` evasion). A dedicated
    // credential store is denied for ALL tiers; any other sensitive path
    // downgrades to an ask (deny for weak / non-interactive).
    for (const p of c.sensitiveReadPaths) {
      const { resolved } = deps.resolver.contains(p);
      if (isCredentialStore(resolved, deps.home)) {
        return denyCredentialStore(p);
      }
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `read of sensitive path ${p}`);
      }
    }
    // Workspace-jail floor: only confidently-parsed simple read commands, so a
    // compound command's jail semantics stay unchanged (it falls to "unknown").
    for (const p of c.readPaths) {
      const { inside } = deps.resolver.contains(p);
      if (!inside) {
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

  if (FILE_READ_TOOLS.has(toolName)) {
    const p = pick(req.toolInput, "path");
    if (p) {
      const { inside, resolved } = deps.resolver.contains(p);
      if (isCredentialStore(resolved, deps.home)) {
        return denyCredentialStore(p);
      }
      if (isSensitivePath(resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `${req.toolName} of sensitive path ${p}`);
      }
      // Out-of-workspace reads prompt. Sensitive paths are floored above.
      if (!inside) {
        return finalizeAsk(req, "read:escape", `${req.toolName} outside workspace: ${p}`);
      }
    }
    return { decision: "allow", category: "read:ok", reason: "non-sensitive read" };
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const p = pick(req.toolInput, "path");
    if (!p) return finalizeAsk(req, "write:no-path", "write with no resolvable path");
    const { inside, resolved } = deps.resolver.contains(p);
    // Credential-shaped writes are floored regardless of jail membership, mirroring
    // the read branch -- a secret dropped inside the workspace is still a secret.
    if (isSensitivePath(resolved, deps.home)) {
      return finalizeAsk(req, "write:sensitive", `write to sensitive path ${p}`);
    }
    // Gated even inside the jail: a script under .git/hooks runs on the next git
    // operation, and .loom/ is Loom's own state -- these always prompt, regardless
    // of being in the workspace. The lone carve-out is the $HOME/.loom/analyses
    // tree (Orbit's default cwd), where the analysis's own files are work product;
    // a .git/.loom nested inside an analysis still gates. See isProtectedWritePath.
    if (isProtectedWritePath(resolved, deps.home)) {
      return finalizeAsk(req, "write:protected", `write to protected path ${p}`);
    }
    if (inside)
      return { decision: "allow", category: "write:in-jail", reason: "write inside workspace" };
    return finalizeAsk(req, "write:escape", `write outside workspace: ${p}`);
  }

  // Everything else is allowed: Galaxy/notebook tools, web fetchers, MCP. These are
  // the remote/egress surface (notebook_push_to_galaxy, galaxy_upload_*/run_user_tool,
  // skills_fetch's ~/.loom cache write, the mcp.json sync) and are deliberately OUT of scope
  // for the working-dir write-jail -- a local write boundary cannot and does not
  // promise anything about data leaving the machine. Gating egress is separate future
  // work; do not let this fallthrough be read as "confined".
  return { decision: "allow", category: "other", reason: "non-local-execution tool" };
}
