import { classifyBash } from "./bash-risk";
import {
  isSensitivePath,
  isCredentialStore,
  isProtectedWritePath,
  isLoomStatePath,
} from "./sensitive-read";
import type { PolicyDeps, PolicyRequest, PolicyResult } from "./types";
import {
  classifyGalaxyDestructive,
  describeGalaxyDestructive,
  isGalaxyDestructiveCurl,
} from "../../../shared/galaxy-destructive.js";
import type { GalaxyDestructiveOp } from "../../../shared/galaxy-destructive.js";

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

// pi declares its file tools with a `path` parameter, but every one of their
// renderers resolves `file_path ?? path` (dist/core/tools/{edit,write,read}.js):
// the Anthropic spelling arrives often enough that pi displays it. A floor must
// not assume one spelling, so both keys are collected and each check below runs
// across all of them -- a benign `path` cannot launder a sensitive `file_path`,
// and the path the human is asked about is one the tool could actually touch.
const PATH_KEYS = ["path", "file_path"];

interface PathTarget {
  raw: string;
  resolved: string;
  inside: boolean;
}

function pathTargets(req: PolicyRequest, deps: PolicyDeps): PathTarget[] {
  const out: PathTarget[] = [];
  for (const key of PATH_KEYS) {
    const raw = pick(req.toolInput, key);
    if (!raw || out.some((t) => t.raw === raw)) continue;
    out.push({ raw, ...deps.resolver.contains(raw) });
  }
  return out;
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

// A destructive, irreversible Galaxy operation (#338). Always confirm -- regardless of
// model tier, so it deliberately does NOT go through finalizeAsk (no weak->deny downgrade).
// A non-interactive session has no one to approve, so it denies rather than running silently.
function destructiveGalaxy(req: PolicyRequest, op: GalaxyDestructiveOp): PolicyResult {
  const headline = describeGalaxyDestructive(op).headline;
  if (!req.interactive) {
    return {
      decision: "deny",
      category: "galaxy:destructive",
      reason: `${headline} (denied: no interactive session to approve)`,
    };
  }
  return { decision: "ask", category: "galaxy:destructive", reason: headline };
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
    // The classifier judges the command string; only this layer has a resolver.
    // A write target that looks like ordinary work product in the analysis
    // workspace but realpaths into Loom's own state is still Loom's own state.
    for (const p of c.loomWriteTargets) {
      if (isLoomStatePath(deps.resolver.contains(p).resolved, deps.home)) {
        return {
          decision: "deny",
          category: "bash:catastrophic",
          reason: "write to the Loom config directory",
        };
      }
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
    // Destructive Galaxy API call via raw curl/wget (DELETE /api/histories/{id}). A
    // guardrail, not a boundary -- routes the unknown command to the same destructive
    // confirm as the MCP path (asks even a weak model) instead of a generic "unknown" ask.
    // Catastrophic pipes were already denied above, so they never reach here.
    {
      const op = isGalaxyDestructiveCurl(command);
      if (op) return destructiveGalaxy(req, op);
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
    // Unrecognized command in an untrusted workspace. Both tiers get a human
    // approval prompt when interactive -- a weak model is no longer hard-denied
    // here, so a user who explicitly chose local execution can approve routine
    // local work (run a script it just wrote, a compound/redirected command)
    // instead of being stuck (#232). Nothing is auto-allowed: the silent pass
    // stays reserved for a trusted model in a trusted workspace (above), and the
    // catastrophic / credential-store / sensitive-read / jail floors are all
    // enforced before this point, so this branch only governs the residual
    // "command we can't reason about" case. A headless session still denies --
    // there is no one to approve.
    if (!req.interactive) {
      return {
        decision: "deny",
        category: "bash:unknown",
        reason: `${c.reason} (denied: no interactive session to approve)`,
      };
    }
    return { decision: "ask", category: "bash:unknown", reason: c.reason };
  }

  if (FILE_READ_TOOLS.has(toolName)) {
    // Each floor sweeps every target before the next one runs, so the strictest
    // verdict wins no matter which key carries the offending path.
    const targets = pathTargets(req, deps);
    for (const t of targets) {
      if (isCredentialStore(t.resolved, deps.home)) return denyCredentialStore(t.raw);
    }
    for (const t of targets) {
      if (isSensitivePath(t.resolved, deps.home)) {
        return finalizeAsk(req, "read:sensitive", `${req.toolName} of sensitive path ${t.raw}`);
      }
    }
    // Out-of-workspace reads prompt. Sensitive paths are floored above.
    for (const t of targets) {
      if (!t.inside) {
        return finalizeAsk(req, "read:escape", `${req.toolName} outside workspace: ${t.raw}`);
      }
    }
    return { decision: "allow", category: "read:ok", reason: "non-sensitive read" };
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const targets = pathTargets(req, deps);
    if (targets.length === 0) {
      return finalizeAsk(req, "write:no-path", "write with no resolvable path");
    }
    // Credential-shaped writes are floored regardless of jail membership, mirroring
    // the read branch -- a secret dropped inside the workspace is still a secret.
    for (const t of targets) {
      if (isSensitivePath(t.resolved, deps.home)) {
        return finalizeAsk(req, "write:sensitive", `write to sensitive path ${t.raw}`);
      }
    }
    // Gated even inside the jail: a script under .git/hooks runs on the next git
    // operation, and .loom/ is Loom's own state -- these always prompt, regardless
    // of being in the workspace. The lone carve-out is the $HOME/.loom/analyses
    // tree (Orbit's default cwd), where the analysis's own files are work product;
    // a .git/.loom nested inside an analysis still gates. See isProtectedWritePath.
    for (const t of targets) {
      if (isProtectedWritePath(t.resolved, deps.home)) {
        return finalizeAsk(req, "write:protected", `write to protected path ${t.raw}`);
      }
    }
    for (const t of targets) {
      if (!t.inside) {
        return finalizeAsk(req, "write:escape", `write outside workspace: ${t.raw}`);
      }
    }
    return { decision: "allow", category: "write:in-jail", reason: "write inside workspace" };
  }

  // Destructive Galaxy MCP operations (whole-history delete/purge) -- called directly or
  // dispatched through the code-mode run_galaxy_tool envelope -- must be confirmed
  // regardless of tier (#338). Non-destructive Galaxy/MCP tools fall through to the allow.
  {
    const op = classifyGalaxyDestructive(toolName, req.toolInput);
    if (op) return destructiveGalaxy(req, op);
  }

  // Everything else is allowed: Galaxy/notebook tools, web fetchers, MCP. These are
  // the remote/egress surface (notebook_push_to_galaxy, galaxy_upload_*/run_user_tool,
  // skills_fetch's ~/.loom cache write, the mcp.json sync) and are deliberately OUT of scope
  // for the working-dir write-jail -- a local write boundary cannot and does not
  // promise anything about data leaving the machine. Gating egress is separate future
  // work; do not let this fallthrough be read as "confined".
  return { decision: "allow", category: "other", reason: "non-local-execution tool" };
}
