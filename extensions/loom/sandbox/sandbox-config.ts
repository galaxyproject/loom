import * as path from "path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

/**
 * Inputs for deriving the OS-sandbox profile. Pure: no I/O, fully testable.
 * Home-relative credential paths are passed to ASRT as `~/...` literals (it
 * expands them); cwd/tmp are absolute.
 */
export interface SandboxConfigInput {
  /** Session working directory -- the workspace. */
  cwd: string;
  /** OS temp dir (os.tmpdir()). */
  tmpDir: string;
  /** Extra silent-write roots (guardian.extraWorkspaceRoots). */
  extraWriteRoots?: string[];
  /** Galaxy base URL, if known -- its host is allowlisted for bash network. */
  galaxyUrl?: string;
  /** Additional domains a deployment wants reachable from bash. */
  extraAllowedDomains?: string[];
}

// Credential/secret locations under $HOME the sandbox blocks bash from reading,
// mirroring the exec-guard's sensitive-read set. ASRT expands the `~`.
const DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker",
  "~/Library/Keychains",
  "~/.netrc",
  "~/.pgpass",
  "~/.npmrc",
  "~/.loom/config.json",
];

// Sensitive files the sandbox blocks bash from writing even inside the
// workspace (a project `.env` or a stray key).
const DENY_WRITE = [".env", ".env.*", "*.pem", "*.key"];

export function hostFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the ASRT profile: writable = workspace + tmp + .loom (the same jail the
 * exec-guard enforces); readable = everything except the credential set; network
 * = deny-all for bash by default, allowlisting only the Galaxy host (Galaxy work
 * itself flows over MCP, not bash, so a tight bash network default is safe).
 */
export function buildSandboxConfig(input: SandboxConfigInput): SandboxRuntimeConfig {
  const allowWrite = [
    input.cwd,
    input.tmpDir,
    path.join(input.cwd, ".loom"),
    ...(input.extraWriteRoots ?? []),
  ];
  const galaxyHost = hostFromUrl(input.galaxyUrl);
  const allowedDomains = [
    ...(galaxyHost ? [galaxyHost] : []),
    ...(input.extraAllowedDomains ?? []),
  ];
  return {
    network: { allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: [...DENY_READ],
      allowWrite,
      denyWrite: [...DENY_WRITE],
    },
  };
}
