import { describe, expect, it } from "vitest";
import {
  resolveGalaxyStatus,
  resolveGalaxyServerUrl,
  resolveGalaxyHistoryOpenUrl,
} from "../app/src/main/galaxy-status.js";
import type { OrbitConfig } from "../shared/orbit-config.js";

const noConfigKey = () => null;

function profileConfig(url: string): OrbitConfig {
  return {
    galaxy: { active: "main", profiles: { main: { url } } },
  } as unknown as OrbitConfig;
}

describe("resolveGalaxyStatus", () => {
  it("reports connected from exported env vars when no profile is saved (#284)", () => {
    // The env-driven / auto-connect path: tool calls work but the footer used
    // to read the (empty) config profile and show "not configured".
    const status = resolveGalaxyStatus(
      {} as OrbitConfig,
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

  it("names the server root when the configured URL is the API root", () => {
    expect(
      resolveGalaxyStatus(profileConfig("main.example/api"), {} as NodeJS.ProcessEnv, () => "k"),
    ).toEqual({ connected: true, url: "https://main.example" });
    expect(
      resolveGalaxyStatus(
        {} as OrbitConfig,
        { GALAXY_URL: "https://env.example/api/" } as NodeJS.ProcessEnv,
        noConfigKey,
      ),
    ).toEqual({ connected: false, url: "https://env.example" });
  });

  it("is disconnected with no profile and no env", () => {
    const status = resolveGalaxyStatus({} as OrbitConfig, {} as NodeJS.ProcessEnv, noConfigKey);
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

  it("falls back to an exported pair when config has no resolvable key", () => {
    const status = resolveGalaxyStatus(
      profileConfig("https://main.example"),
      { GALAXY_URL: "https://env.example", GALAXY_API_KEY: "env-key" } as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(status).toEqual({ connected: true, url: "https://env.example" });
  });

  it("won't pair an exported key with the profile URL when the profile key is unreadable", () => {
    // That key may belong to another server; the brain is never handed the mix.
    const status = resolveGalaxyStatus(
      profileConfig("https://main.example"),
      { GALAXY_API_KEY: "env-key" } as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(status).toEqual({ connected: false, url: "https://main.example" });
  });
});

describe("resolveGalaxyServerUrl", () => {
  it("falls back to the exported GALAXY_URL when no profile is saved (#290)", () => {
    expect(
      resolveGalaxyServerUrl(
        {} as OrbitConfig,
        { GALAXY_URL: "https://env.example" } as NodeJS.ProcessEnv,
        noConfigKey,
      ),
    ).toBe("https://env.example");
  });

  it("uses the active profile URL with no env", () => {
    expect(
      resolveGalaxyServerUrl(
        profileConfig("https://main.example"),
        {} as NodeJS.ProcessEnv,
        noConfigKey,
      ),
    ).toBe("https://main.example");
  });

  it("prefers the active profile URL over an exported pair when its key resolves", () => {
    expect(
      resolveGalaxyServerUrl(
        profileConfig("https://profile.example"),
        { GALAXY_URL: "https://env.example", GALAXY_API_KEY: "k" } as NodeJS.ProcessEnv,
        () => "ck",
      ),
    ).toBe("https://profile.example");
  });

  it("follows the exported pair when the profile key doesn't resolve, as the brain does", () => {
    expect(
      resolveGalaxyServerUrl(
        profileConfig("https://profile.example"),
        { GALAXY_URL: "https://env.example", GALAXY_API_KEY: "k" } as NodeJS.ProcessEnv,
        noConfigKey,
      ),
    ).toBe("https://env.example");
  });

  it("is null with no profile and no env", () => {
    expect(
      resolveGalaxyServerUrl({} as OrbitConfig, {} as NodeJS.ProcessEnv, noConfigKey),
    ).toBeNull();
  });
});

describe("resolveGalaxyHistoryOpenUrl", () => {
  const HISTORY = "https://env.example/histories/view?id=h1";

  it("accepts a same-origin history URL pinned to the effective env server (#290)", () => {
    // The env-driven case: no saved profile, server URL comes from GALAXY_URL.
    const serverUrl = resolveGalaxyServerUrl(
      {} as OrbitConfig,
      { GALAXY_URL: "https://env.example" } as NodeJS.ProcessEnv,
      noConfigKey,
    );
    expect(resolveGalaxyHistoryOpenUrl(HISTORY, serverUrl)).toBe(HISTORY);
  });

  it("accepts a subpath deployment whose origin matches the server", () => {
    expect(
      resolveGalaxyHistoryOpenUrl(
        "https://example.org/galaxy/histories/view?id=h1",
        "https://example.org/galaxy",
      ),
    ).toBe("https://example.org/galaxy/histories/view?id=h1");
  });

  it("rejects a cross-origin destination even with a valid path", () => {
    expect(
      resolveGalaxyHistoryOpenUrl("https://evil.example/histories/view", "https://env.example"),
    ).toBeNull();
  });

  it("rejects when no server URL resolves at all", () => {
    expect(resolveGalaxyHistoryOpenUrl(HISTORY, null)).toBeNull();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(resolveGalaxyHistoryOpenUrl("file:///etc/passwd", "https://env.example")).toBeNull();
  });

  it("rejects a URL that does not end in /histories/view", () => {
    expect(
      resolveGalaxyHistoryOpenUrl("https://env.example/datasets/list", "https://env.example"),
    ).toBeNull();
  });

  it("rejects a non-string requested URL", () => {
    expect(resolveGalaxyHistoryOpenUrl(42, "https://env.example")).toBeNull();
    expect(resolveGalaxyHistoryOpenUrl(undefined, "https://env.example")).toBeNull();
  });

  it("rejects an unparseable requested URL", () => {
    expect(resolveGalaxyHistoryOpenUrl("not a url", "https://env.example")).toBeNull();
  });
});
