import type { LoomConfig } from "./loom-config.js";

export interface ConfigSource {
  /** The raw config object; loadConfig() clones it and applies the same migrations and defaults as the file. */
  load(): Partial<LoomConfig>;
  /** Absent means the shell owns the config and nothing here may write it. */
  save?(config: LoomConfig): void;
  /** Secret values the shell holds that are in neither the config nor process.env. */
  secrets?(): string[];
}

export function setConfigSource(source: ConfigSource | null): void;
export function installedConfigSource(): ConfigSource | null;
