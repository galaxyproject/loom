export interface CapabilityProfile {
  shell: boolean;
  files: boolean;
  notebook: "file" | "page";
  network: boolean;
  galaxyTools: "mcp" | "bare";
  /** pi's MCP layer, for the servers Loom brings (brc-analytics; galaxy-mcp too under mcp). */
  mcpServers: boolean;
  ui: "desktop" | "terminal" | "worker";
}

export function profileFromEnv(env?: Record<string, string | undefined>): CapabilityProfile;
/** The installed profile when a shell set one and no env was passed, else profileFromEnv(env). */
export function capabilityProfile(env?: Record<string, string | undefined>): CapabilityProfile;
/** `owner` tags an install the brain made itself; a shell's install leaves it null. */
export function setCapabilityProfile(
  profile: CapabilityProfile | null,
  owner?: string | null,
): void;
/** The owner tag the installed profile was set with, or null. */
export function installedCapabilityProfileOwner(): string | null;
/** The installed profile itself, or null when env is in charge. */
export function installedCapabilityProfile(): CapabilityProfile | null;
