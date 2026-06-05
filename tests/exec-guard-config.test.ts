import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadGuardianConfig, resolveBypass } from "../extensions/loom/exec-guard/guardian-config";

let prevHome: string | undefined, sandbox: string;
beforeEach(() => {
  prevHome = process.env.HOME;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "loom-guard-cfg-"));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  delete process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS;
  delete process.env.LOOM_SAFE;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("loadGuardianConfig", () => {
  it("defaults to enabled, not bypassed, secure", () => {
    const g = loadGuardianConfig();
    expect(g.enabled).toBe(true);
    expect(g.dangerouslyBypassPermissions).toBe(false);
    expect(g.trustedWorkspaces).toEqual([]);
    expect(g.consentAcknowledged).toBeNull();
  });
});

describe("resolveBypass", () => {
  it("is false by default", () => {
    expect(resolveBypass(loadGuardianConfig())).toBe(false);
  });
  it("env flag turns it on", () => {
    process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS = "1";
    expect(resolveBypass(loadGuardianConfig())).toBe(true);
  });
  it("config value turns it on", () => {
    const g = { ...loadGuardianConfig(), dangerouslyBypassPermissions: true };
    expect(resolveBypass(g)).toBe(true);
  });
  it("--safe / LOOM_SAFE wins over both", () => {
    process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS = "1";
    process.env.LOOM_SAFE = "1";
    const g = { ...loadGuardianConfig(), dangerouslyBypassPermissions: true };
    expect(resolveBypass(g)).toBe(false);
  });
});
