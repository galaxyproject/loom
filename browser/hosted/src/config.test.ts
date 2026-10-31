import { describe, expect, it } from "vitest";

import { ConfigError, describeConfig, loadConfig } from "./config";

const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
const CLIENT_SECRET = "client-secret-value-xyz";
const DB_PASSWORD = "db-password-value-xyz";
const MODEL_KEY = "sk-model-service-value-xyz";

const DEV = {
  ORBIT_PUBLIC_URL: "http://localhost:7878",
  ORBIT_DATABASE_URL: "postgres://orbit@localhost:5432/orbit",
  ORBIT_GALAXY_URL: "https://test.galaxyproject.org",
  ORBIT_OIDC_ISSUER: "https://login.galaxyproject.org/realms/galaxy-test",
  ORBIT_OIDC_CLIENT_ID: "orbit-dev",
  ORBIT_TOKEN_KEY: TOKEN_KEY,
  ORBIT_MODEL_URL: "https://litellm.galaxyproject.org",
  ORBIT_MODEL_KEY: MODEL_KEY,
  ORBIT_MODEL: "minimax",
};

const DEPLOYED = {
  ...DEV,
  ORBIT_PUBLIC_URL: "https://orbit.galaxyproject.org",
  ORBIT_DATABASE_URL: `postgres://orbit:${DB_PASSWORD}@db:5432/orbit`,
  ORBIT_OIDC_CLIENT_ID: "orbit",
  ORBIT_OIDC_CLIENT_SECRET: CLIENT_SECRET,
};

const problems = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe("loadConfig", () => {
  it("refuses to boot with nothing set, naming every required setting at once", () => {
    expect(problems({})).toEqual([
      "ORBIT_PUBLIC_URL is not set",
      "ORBIT_DATABASE_URL is not set",
      "ORBIT_GALAXY_URL is not set",
      "ORBIT_OIDC_ISSUER is not set",
      "ORBIT_OIDC_CLIENT_ID is not set",
      "ORBIT_TOKEN_KEY is not set",
      "ORBIT_MODEL_URL is not set",
      "ORBIT_MODEL_KEY is not set",
      "ORBIT_MODEL is not set",
    ]);
  });

  it("treats a blank setting as unset", () => {
    expect(problems({ ...DEV, ORBIT_GALAXY_URL: "  " })).toEqual(["ORBIT_GALAXY_URL is not set"]);
  });

  it("boots a localhost dev host on the public client, with the lease defaults", () => {
    const config = loadConfig(DEV);
    expect(config.port).toBe(7878);
    expect(config.oidc.clientSecret).toBeUndefined();
    expect(config.tokenKey.length).toBe(32);
    expect(config.lease).toEqual({ ttlMs: 60_000, renewMs: 15_000, maxTurnMs: 1_800_000 });
    expect(config.idle).toEqual({ releaseMs: 600_000, askPauseMs: 600_000 });
  });

  it("takes the idle release and confirm pause times in seconds, fractions included", () => {
    const config = loadConfig({ ...DEV, ORBIT_IDLE_RELEASE_SECONDS: "90", ORBIT_ASK_PAUSE_SECONDS: "2.5" });
    expect(config.idle).toEqual({ releaseMs: 90_000, askPauseMs: 2_500 });
    expect(problems({ ...DEV, ORBIT_IDLE_RELEASE_SECONDS: "0", ORBIT_ASK_PAUSE_SECONDS: "soon" })).toEqual([
      "ORBIT_IDLE_RELEASE_SECONDS must be a positive number of seconds",
      "ORBIT_ASK_PAUSE_SECONDS must be a positive number of seconds",
    ]);
  });

  it("takes a socket-style database URL, which pg accepts and WHATWG doesn't", () => {
    const config = loadConfig({ ...DEV, ORBIT_DATABASE_URL: "postgres://orbit@/orbit?host=%2Fvar%2Frun%2Fpostgresql" });
    expect(describeConfig(config)).toContain("/var/run/postgresql/orbit (password not set)");
  });

  it("boots a deployed host with a client secret", () => {
    expect(loadConfig(DEPLOYED).oidc.clientSecret).toBe(CLIENT_SECRET);
  });

  it("requires TLS and a confidential client anywhere but localhost", () => {
    expect(
      problems({ ...DEV, ORBIT_PUBLIC_URL: "http://orbit.galaxyproject.org" }),
    ).toEqual([
      "ORBIT_PUBLIC_URL must be https unless it is localhost",
      "ORBIT_OIDC_CLIENT_SECRET is not set; only a localhost host may use a public client",
    ]);
  });

  it("sends tokens and the model key only over TLS beyond localhost", () => {
    expect(problems({ ...DEV, ORBIT_GALAXY_URL: "http://galaxy.example.org", ORBIT_MODEL_URL: "http://litellm.example.org" })).toEqual([
      "ORBIT_GALAXY_URL must be https unless it is localhost",
      "ORBIT_MODEL_URL must be https unless it is localhost",
    ]);
  });

  it("checks the shape of what is set", () => {
    expect(
      problems({
        ...DEV,
        ORBIT_PORT: "70000",
        ORBIT_DATABASE_URL: "postgres://db:abc/orbit",
        ORBIT_GALAXY_URL: "test.galaxyproject.org",
        ORBIT_TOKEN_KEY: Buffer.alloc(16).toString("base64"),
        ORBIT_LEASE_RENEW_SECONDS: "45",
      }),
    ).toEqual([
      "ORBIT_PORT must be a port number",
      "ORBIT_DATABASE_URL must be a postgres:// URL",
      "ORBIT_GALAXY_URL is not an http(s) URL",
      "ORBIT_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)",
      "ORBIT_LEASE_RENEW_SECONDS must be at most half of ORBIT_LEASE_TTL_SECONDS",
    ]);
  });

  it("says why it can't start in the error message", () => {
    expect(() => loadConfig({})).toThrow(/Orbit can't start:\n {2}- ORBIT_PUBLIC_URL is not set/);
  });
});

describe("describeConfig", () => {
  it("names which secrets are set and never shows them", () => {
    const summary = describeConfig(loadConfig(DEPLOYED));
    for (const secret of [CLIENT_SECRET, DB_PASSWORD, TOKEN_KEY, MODEL_KEY]) expect(summary).not.toContain(secret);
    expect(summary).toContain("db:5432/orbit (password set)");
    expect(summary).toContain("as orbit (client secret set)");
    expect(summary).toContain("token key   set");
    expect(summary).toContain("released after 600 s quiet with no page open; an unanswered confirm pauses after 600 s");
  });

  it("says when the dev host signs in as a public client", () => {
    expect(describeConfig(loadConfig(DEV))).toContain("as orbit-dev (client secret not set, public client)");
  });
});
