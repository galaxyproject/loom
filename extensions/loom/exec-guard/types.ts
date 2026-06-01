export type Decision = "allow" | "ask" | "deny";
export type ModelTier = "trusted" | "weak";

export interface GuardianConfig {
  enabled: boolean;
  dangerouslyBypassPermissions: boolean;
  trustedWorkspaces: string[];
  extraWorkspaceRoots: string[];
  consentAcknowledged: { version: string; at: string } | null;
  /** Run allowed bash inside an OS sandbox so the gate can prompt less. */
  autoMode: boolean;
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
  /**
   * Auto mode's OS sandbox is live. Lets the gate relax the escape-shaped asks
   * the sandbox backstops (out-of-workspace non-sensitive reads, where bash's
   * network-deny closes the exfil path). Never lifts the sensitive/jail floor or
   * auto-runs unknown/destructive bash.
   */
  autoSandbox?: boolean;
}

export interface PolicyDeps {
  resolver: PathResolver;
  home: string;
}

export interface PolicyResult {
  decision: Decision;
  // e.g. "bypass", "bash:safe", "bash:catastrophic", "write:in-jail", "read:sensitive", "default:ask"
  category: string;
  reason: string; // human-facing
}

export const CONSENT_VERSION = "1";
