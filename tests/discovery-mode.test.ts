import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getDiscoveryMode, loadConfig, saveConfig } from "../shared/loom-config.js";

// Config paths derive from os.homedir() at call time. Sandbox HOME +
// USERPROFILE so each test gets its own ~/.loom/config.json.
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let sandboxHome: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-discovery-test-"));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
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

describe("getDiscoveryMode", () => {
  it("defaults to 'code' when no config exists", () => {
    expect(getDiscoveryMode()).toBe("code");
  });

  it("defaults to 'code' when config has no galaxy section", () => {
    saveConfig({ executionMode: "cloud" } as never);
    expect(getDiscoveryMode()).toBe("code");
  });

  it("returns 'full' when explicitly set", () => {
    const cfg = loadConfig();
    cfg.galaxy = { active: null, profiles: {}, discoveryMode: "full" };
    saveConfig(cfg);
    expect(getDiscoveryMode()).toBe("full");
  });

  it("returns 'code' when explicitly set to 'code'", () => {
    const cfg = loadConfig();
    cfg.galaxy = { active: null, profiles: {}, discoveryMode: "code" };
    saveConfig(cfg);
    expect(getDiscoveryMode()).toBe("code");
  });

  it("falls back to 'code' for malformed values", () => {
    // A hand-edited config with a typo shouldn't silently disable the
    // optimization -- the safer default is code-mode.
    const cfg = loadConfig();
    cfg.galaxy = {
      active: null,
      profiles: {},
      discoveryMode: "compact" as never,
    };
    saveConfig(cfg);
    expect(getDiscoveryMode()).toBe("code");
  });
});
