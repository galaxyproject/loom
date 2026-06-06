import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  EncryptedProfileUnavailableError,
  resolveProfileApiKey,
  saveProfile,
  switchProfile,
  loadProfiles,
  getActiveGalaxyStatus,
} from "../extensions/loom/profiles";

// All loom-config / profiles paths derive from os.homedir() at call time.
// POSIX reads HOME; Windows reads USERPROFILE. Override both so the on-disk
// state lives entirely in the sandbox dir on every runner.
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let sandboxHome: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-profiles-test-"));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  delete process.env.GALAXY_URL;
  delete process.env.GALAXY_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  } catch {}
});

describe("EncryptedProfileUnavailableError", () => {
  it("names the profile in the message and tags the error name", () => {
    const err = new EncryptedProfileUnavailableError("usegalaxy");
    expect(err.profileName).toBe("usegalaxy");
    expect(err.name).toBe("EncryptedProfileUnavailableError");
    expect(err.message).toContain("usegalaxy");
    expect(err.message).toMatch(/orbit|GALAXY_API_KEY/i);
  });
});

describe("resolveProfileApiKey", () => {
  it("returns plaintext when apiKey is set", () => {
    const got = resolveProfileApiKey("p", {
      url: "https://x.galaxyproject.org",
      apiKey: "plain-key",
    });
    expect(got).toBe("plain-key");
  });

  it("throws EncryptedProfileUnavailableError for encrypted-only profiles", () => {
    expect(() =>
      resolveProfileApiKey("usegalaxy", { url: "https://usegalaxy.org", apiKeyEncrypted: "ZW5j" }),
    ).toThrow(EncryptedProfileUnavailableError);
  });

  it("throws a plain Error when no key field is set", () => {
    expect(() => resolveProfileApiKey("empty", { url: "https://usegalaxy.org" })).toThrow(
      /no API key/i,
    );
    expect(() => resolveProfileApiKey("empty", { url: "https://usegalaxy.org" })).not.toThrow(
      EncryptedProfileUnavailableError,
    );
  });
});

describe("switchProfile env handling", () => {
  it("sets GALAXY_API_KEY from plaintext profile", () => {
    saveProfile("a", "https://a.galaxyproject.org", "key-A");
    delete process.env.GALAXY_API_KEY;
    expect(switchProfile("a")).toBe(true);
    expect(process.env.GALAXY_URL).toBe("https://a.galaxyproject.org");
    expect(process.env.GALAXY_API_KEY).toBe("key-A");
  });

  it("returns false for an unknown profile", () => {
    expect(switchProfile("does-not-exist")).toBe(false);
  });

  it("does not reuse a stale env key when switching to an encrypted-only profile with no env injection", () => {
    saveProfile("a", "https://a.galaxyproject.org", "key-A");
    const cfgPath = path.join(sandboxHome, ".loom/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.galaxy.profiles.b = { url: "https://b.galaxyproject.org", apiKeyEncrypted: "ZW5jLWZvci1i" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    expect(switchProfile("a")).toBe(true);
    expect(process.env.GALAXY_API_KEY).toBe("key-A");
    delete process.env.GALAXY_API_KEY;
    expect(switchProfile("b")).toBe(true);
    expect(process.env.GALAXY_URL).toBe("https://b.galaxyproject.org");
    expect(process.env.GALAXY_API_KEY).toBeUndefined();
    expect(loadProfiles().active).toBe("b");
  });

  it("clears GALAXY_API_KEY even when env was previously injected (forces shell-side re-injection)", () => {
    // Brain can't verify a pre-injected env matches THIS profile's
    // ciphertext, so the safer move is to fail loud and require a
    // restart. This is the security-sensitive path.
    saveProfile("a", "https://a.galaxyproject.org", "key-A");
    const cfgPath = path.join(sandboxHome, ".loom/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.galaxy.profiles.b = { url: "https://b.galaxyproject.org", apiKeyEncrypted: "ZW5jLWZvci1i" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    process.env.GALAXY_API_KEY = "stale-from-previous-profile";
    expect(switchProfile("b")).toBe(true);
    expect(process.env.GALAXY_API_KEY).toBeUndefined();
    expect(process.env.GALAXY_URL).toBe("https://b.galaxyproject.org");
  });
});

describe("syncMcpConfig", () => {
  it("writes ${GALAXY_API_KEY} as a literal env reference, never plaintext", () => {
    const agentDir = path.join(sandboxHome, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const mcpPath = path.join(agentDir, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { galaxy: { command: "x", env: {} } } }, null, 2),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    saveProfile("a", "https://a.galaxyproject.org", "should-not-leak");
    const written = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    expect(written.mcpServers.galaxy.env.GALAXY_URL).toBe("https://a.galaxyproject.org");
    expect(written.mcpServers.galaxy.env.GALAXY_API_KEY).toBe("${GALAXY_API_KEY}");
    const raw = fs.readFileSync(mcpPath, "utf-8");
    expect(raw).not.toContain("should-not-leak");
  });
});

describe("getActiveGalaxyStatus", () => {
  const withDefault = (p: Record<string, unknown>) => ({
    active: "default",
    profiles: { default: p as never },
  });

  it("is usable when GALAXY_URL and GALAXY_API_KEY are both in env", () => {
    const status = getActiveGalaxyStatus(withDefault({ url: "u", apiKeyEncrypted: "ZW5j" }), {
      GALAXY_URL: "u",
      GALAXY_API_KEY: "k",
    });
    expect(status).toBe("usable");
  });

  it("is configured-unusable for an encrypted-only active profile with no env key", () => {
    const status = getActiveGalaxyStatus(withDefault({ url: "u", apiKeyEncrypted: "ZW5j" }), {});
    expect(status).toBe("configured-unusable");
  });

  it("is usable (not configured-unusable) once Orbit injects the env key", () => {
    const status = getActiveGalaxyStatus(withDefault({ url: "u", apiKeyEncrypted: "ZW5j" }), {
      GALAXY_URL: "u",
      GALAXY_API_KEY: "injected-by-orbit",
    });
    expect(status).toBe("usable");
  });

  it("is none when there is no active profile", () => {
    expect(getActiveGalaxyStatus({ active: null, profiles: {} }, {})).toBe("none");
  });

  it("is none when the active name points at a missing profile", () => {
    expect(getActiveGalaxyStatus({ active: "ghost", profiles: {} }, {})).toBe("none");
  });

  it("is none for a plaintext-key profile not yet wired into env", () => {
    // Has a usable key on disk, so it's not the encrypted-unusable case; env
    // just isn't set, which bin/loom.js wouldn't allow in practice. Documents
    // the boundary.
    const status = getActiveGalaxyStatus(withDefault({ url: "u", apiKey: "plain" }), {});
    expect(status).toBe("none");
  });
});
