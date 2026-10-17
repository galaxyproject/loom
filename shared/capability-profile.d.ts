export interface CapabilityProfile {
  shell: boolean;
  files: boolean;
  notebook: "file" | "page";
  network: boolean;
  galaxyTools: "mcp" | "bare";
  ui: "desktop" | "terminal";
}

export function profileFromEnv(env?: Record<string, string | undefined>): CapabilityProfile;
