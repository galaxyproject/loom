export type Decision = "allow" | "ask" | "deny";
export type ModelTier = "trusted" | "weak";

export interface GuardianConfig {
  enabled: boolean;
  dangerouslyBypassPermissions: boolean;
  trustedWorkspaces: string[];
  extraWorkspaceRoots: string[];
  consentAcknowledged: { version: string; at: string } | null;
  /** Opt-in: run allowed bash inside an OS sandbox (confines bash writes + network). */
  sandbox: boolean;
}

export interface PathResolver {
  /** Realpath the target (resolving the deepest existing ancestor for not-yet-existing
   *  targets) and report whether it lands inside any allowed root. */
  contains(targetPath: string): { resolved: string; inside: boolean };
}

export interface PolicyRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  modelTier: ModelTier;
  config: GuardianConfig;
  interactive: boolean;
  cwd: string;
}

export interface PolicyDeps {
  resolver: PathResolver;
  home: string;
}

export interface PolicyResult {
  decision: Decision;
  // e.g. "bypass", "bash:safe", "bash:catastrophic", "write:in-jail", "read:sensitive",
  // "galaxy:destructive", "default:ask"
  category: string;
  reason: string; // human-facing
}

export const CONSENT_VERSION = "1";
