export interface CapabilityProfile {
  shell: boolean;
  files: boolean;
  notebook: "file" | "page";
  network: boolean;
  /** pi's MCP layer, for the servers Orbit brings (brc-analytics). */
  mcpServers: boolean;
  ui: "desktop" | "terminal" | "worker";
  /** An in-brain Python runtime (the browser's Pyodide); no Node shell has one. */
  python?: boolean;
  /** Whether the brain may change Galaxy; "read" withholds every Galaxy and record writer. */
  galaxy?: "read" | "write";
  /**
   * What the model should ask of the user when Galaxy refuses the credentials: an imperative
   * starting "Ask the user to ...", with no closing period, since it is followed by "; do not
   * retry until they have." Defaults to /connect.
   */
  authRemedy?: string;
}

export const DEFAULT_AUTH_REMEDY: string;
/** The installed profile's auth remedy, or the Node shells' /connect. */
export function authRemedy(): string;

export function profileFromEnv(env?: Record<string, string | undefined>): CapabilityProfile;
/** The installed profile when a shell set one and no env was passed, else profileFromEnv(env). */
export function capabilityProfile(env?: Record<string, string | undefined>): CapabilityProfile;
export function setCapabilityProfile(profile: CapabilityProfile | null): void;
/** The installed profile itself, or null when env is in charge. */
export function installedCapabilityProfile(): CapabilityProfile | null;
