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
  warnOnUnusableActiveProfile,
} from "../extensions/loom/profiles";

// All loom-config / profiles paths derive from os.homedir() at call time
// (POSIX reads HOME), so swapping HOME per test sandboxes the on-disk state
// without touching the real ~/.loom/config.json.
let prevHome: string | undefined;
let sandboxHome: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-profiles-test-"));
  process.env.HOME = sandboxHome;
  delete process.env.GALAXY_URL;
  delete process.env.GALAXY_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
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
    const got = resolveProfileApiKey("p", { url: "https://x.galaxyproject.org", apiKey: "plain-key" });
    expect(got).toBe("plain-key");
  });

  it("throws EncryptedProfileUnavailableError for encrypted-only profiles", () => {
    expect(() =>
      resolveProfileApiKey("usegalaxy", { url: "https://usegalaxy.org", apiKeyEncrypted: "ZW5j" }),
    ).toThrow(EncryptedProfileUnavailableError);
  });

  it("throws a plain Error when no key field is set", () => {
    expect(() =>
      resolveProfileApiKey("empty", { url: "https://usegalaxy.org" }),
    ).toThrow(/no API key/i);
    expect(() =>
      resolveProfileApiKey("empty", { url: "https://usegalaxy.org" }),
    ).not.toThrow(EncryptedProfileUnavailableError);
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

describe("warnOnUnusableActiveProfile", () => {
  function captureErrors(fn: () => void): string[] {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => errors.push(msg);
    try { fn(); } finally { console.error = orig; }
    return errors;
  }

  it("warns when active profile is encrypted-only and env is unset", () => {
    saveProfile("a", "https://a.galaxyproject.org", "plain-A");
    const cfgPath = path.join(sandboxHome, ".loom/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.galaxy.profiles.a = { url: "https://a.galaxyproject.org", apiKeyEncrypted: "ZW5j" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    delete process.env.GALAXY_API_KEY;
    const errors = captureErrors(() => warnOnUnusableActiveProfile());
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Active profile \"a\"");
    expect(errors[0]).toMatch(/GALAXY_API_KEY/);
  });

  it("does not warn when active profile has plaintext key", () => {
    saveProfile("a", "https://a.galaxyproject.org", "plain-A");
    delete process.env.GALAXY_API_KEY;
    const errors = captureErrors(() => warnOnUnusableActiveProfile());
    expect(errors.length).toBe(0);
  });

  it("does not warn when env injection is present (Orbit path)", () => {
    saveProfile("a", "https://a.galaxyproject.org", "plain-A");
    const cfgPath = path.join(sandboxHome, ".loom/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.galaxy.profiles.a = { url: "https://a.galaxyproject.org", apiKeyEncrypted: "ZW5j" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    process.env.GALAXY_API_KEY = "injected-by-orbit";
    const errors = captureErrors(() => warnOnUnusableActiveProfile());
    expect(errors.length).toBe(0);
  });

  it("does not warn when there is no active profile", () => {
    const errors = captureErrors(() => warnOnUnusableActiveProfile());
    expect(errors.length).toBe(0);
  });
});
