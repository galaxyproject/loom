import { describe, expect, it } from "vitest";
import {
  describeMissingGalaxyCredentials,
  resolveGalaxyCredentials,
} from "../shared/galaxy-credentials.js";
import type { OrbitConfig } from "../shared/orbit-config.js";

function profileConfig(profile: { url: string; apiKey?: string; apiKeyEncrypted?: string }) {
  return { galaxy: { active: "main", profiles: { main: profile } } } as unknown as OrbitConfig;
}

const ENV_PAIR = { GALAXY_URL: "https://cwic.example", GALAXY_API_KEY: "env-key" };

describe("resolveGalaxyCredentials", () => {
  it("hands back the server root whichever source pasted the API root", () => {
    const fromEnv = resolveGalaxyCredentials({
      config: null,
      env: { GALAXY_URL: "cwic.example/api/", GALAXY_API_KEY: "env-key" },
      prefer: "env",
    });
    expect(fromEnv?.url).toBe("https://cwic.example");
    const fromProfile = resolveGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example/api", apiKey: "eu-key" }),
      env: {},
      prefer: "profile",
    });
    expect(fromProfile?.url).toBe("https://eu.example");
  });

  it("doesn't let an exported URL that names no host beat a working profile", () => {
    const creds = resolveGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example", apiKey: "eu-key" }),
      env: { GALAXY_URL: "https://", GALAXY_API_KEY: "env-key" },
      prefer: "env",
    });
    expect(creds).toEqual({ url: "https://eu.example", apiKey: "eu-key", source: "profile" });
  });

  it("lets an exported pair override a plaintext profile when env is preferred", () => {
    const creds = resolveGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example", apiKey: "eu-key" }),
      env: ENV_PAIR,
      prefer: "env",
    });
    expect(creds).toEqual({ url: "https://cwic.example", apiKey: "env-key", source: "env" });
  });

  it("keeps the profile when it is preferred and has a key", () => {
    const creds = resolveGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example", apiKeyEncrypted: "ct" }),
      profileApiKey: "decrypted-eu-key",
      env: ENV_PAIR,
      prefer: "profile",
    });
    expect(creds).toEqual({
      url: "https://eu.example",
      apiKey: "decrypted-eu-key",
      source: "profile",
    });
  });

  it("falls back to the exported pair when the preferred profile has no readable key", () => {
    const creds = resolveGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example", apiKeyEncrypted: "ct" }),
      profileApiKey: null,
      env: ENV_PAIR,
      prefer: "profile",
    });
    expect(creds?.url).toBe("https://cwic.example");
  });

  it("never pairs an exported key with an encrypted profile's URL", () => {
    // The original bug: the CLI can't read apiKeyEncrypted, took GALAXY_API_KEY
    // instead, and sent it to the profile's server.
    for (const env of [ENV_PAIR, { GALAXY_API_KEY: "env-key" }]) {
      const creds = resolveGalaxyCredentials({
        config: profileConfig({ url: "https://eu.example", apiKeyEncrypted: "ct" }),
        env,
        prefer: "env",
      });
      if (creds) expect(creds).not.toMatchObject({ url: "https://eu.example", apiKey: "env-key" });
    }
  });

  it("ignores half of an env pair rather than borrowing the other half from the profile", () => {
    const config = profileConfig({ url: "https://eu.example", apiKey: "eu-key" });
    expect(
      resolveGalaxyCredentials({
        config,
        env: { GALAXY_URL: "https://cwic.example" },
        prefer: "env",
      }),
    ).toEqual({ url: "https://eu.example", apiKey: "eu-key", source: "profile" });
    expect(
      resolveGalaxyCredentials({ config, env: { GALAXY_API_KEY: "env-key" }, prefer: "env" }),
    ).toEqual({ url: "https://eu.example", apiKey: "eu-key", source: "profile" });
  });

  it("returns null with an encrypted profile and only a key exported", () => {
    expect(
      resolveGalaxyCredentials({
        config: profileConfig({ url: "https://eu.example", apiKeyEncrypted: "ct" }),
        env: { GALAXY_API_KEY: "env-key" },
        prefer: "env",
      }),
    ).toBeNull();
  });

  it("treats blank env values as unset", () => {
    expect(
      resolveGalaxyCredentials({
        config: {} as OrbitConfig,
        env: { GALAXY_URL: "  ", GALAXY_API_KEY: "k" },
        prefer: "env",
      }),
    ).toBeNull();
  });

  it("works from env alone with no config", () => {
    expect(
      resolveGalaxyCredentials({ config: undefined, env: ENV_PAIR, prefer: "env" })?.source,
    ).toBe("env");
  });
});

describe("describeMissingGalaxyCredentials", () => {
  it("names the missing half of an env pair", () => {
    expect(
      describeMissingGalaxyCredentials({ config: {} as OrbitConfig, env: { GALAXY_API_KEY: "k" } }),
    ).toMatch(/without GALAXY_URL/);
    expect(
      describeMissingGalaxyCredentials({
        config: {} as OrbitConfig,
        env: { GALAXY_URL: "https://x" },
      }),
    ).toMatch(/without GALAXY_API_KEY/);
  });

  it("explains a desktop-only encrypted profile", () => {
    const why = describeMissingGalaxyCredentials({
      config: profileConfig({ url: "https://eu.example", apiKeyEncrypted: "ct" }),
      env: {},
    });
    expect(why).toMatch(/"main" \(https:\/\/eu\.example\)/);
  });

  it("stays quiet when nothing Galaxy-related is configured", () => {
    expect(describeMissingGalaxyCredentials({ config: {} as OrbitConfig, env: {} })).toBeNull();
  });
});

describe("half-set env alongside a usable profile", () => {
  it("still resolves the profile and still has a warning to give", () => {
    const config = profileConfig({ url: "https://eu.example", apiKey: "eu-key" });
    const env = { GALAXY_URL: "https://cwic.example" };
    expect(resolveGalaxyCredentials({ config, env, prefer: "env" })?.source).toBe("profile");
    expect(describeMissingGalaxyCredentials({ config, env })).toMatch(/without GALAXY_API_KEY/);
  });

  it("has nothing to say about a plaintext profile with no env", () => {
    const config = profileConfig({ url: "https://eu.example", apiKey: "eu-key" });
    expect(describeMissingGalaxyCredentials({ config, env: {} })).toBeNull();
  });
});
