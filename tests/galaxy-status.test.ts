import { describe, expect, it } from "vitest";
import { resolveGalaxyStatus } from "../app/src/main/galaxy-status.js";
import type { LoomConfig } from "../shared/loom-config.js";

const noConfigKey = () => null;

function profileConfig(url: string): LoomConfig {
  return {
    galaxy: { active: "main", profiles: { main: { url } } },
  } as unknown as LoomConfig;
}

describe("resolveGalaxyStatus", () => {
  it("reports connected from exported env vars when no profile is saved (#284)", () => {
    // The env-driven / auto-connect path: tool calls work but the footer used
    // to read the (empty) config profile and show "not configured".
    const status = resolveGalaxyStatus(
      {} as LoomConfig,
      { GALAXY_URL: "https://usegalaxy.org", GALAXY_API_KEY: "k" } as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(status).toEqual({ connected: true, url: "https://usegalaxy.org" });
  });

  it("reports connected from a saved profile with no env vars", () => {
    const status = resolveGalaxyStatus(
      profileConfig("https://main.example"),
      {} as NodeJS.ProcessEnv,
      () => "decrypted-key",
    );
    expect(status).toEqual({ connected: true, url: "https://main.example" });
  });

  it("is disconnected when a profile URL exists but no key resolves anywhere", () => {
    const status = resolveGalaxyStatus(
      profileConfig("https://main.example"),
      {} as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(status).toEqual({ connected: false, url: "https://main.example" });
  });

  it("is disconnected with no profile and no env", () => {
    const status = resolveGalaxyStatus({} as LoomConfig, {} as NodeJS.ProcessEnv, noConfigKey);
    expect(status).toEqual({ connected: false, url: null });
  });

  it("prefers the active profile URL over an exported GALAXY_URL", () => {
    const status = resolveGalaxyStatus(
      profileConfig("https://profile.example"),
      { GALAXY_URL: "https://env.example", GALAXY_API_KEY: "k" } as NodeJS.ProcessEnv,
      () => "ck",
    );
    expect(status.url).toBe("https://profile.example");
  });

  it("falls back to the exported GALAXY_API_KEY when config has no resolvable key", () => {
    const status = resolveGalaxyStatus(
      profileConfig("https://main.example"),
      { GALAXY_API_KEY: "env-key" } as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(status.connected).toBe(true);
  });
});
