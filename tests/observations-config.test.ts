import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpHome: string;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-cfg-"));
  fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.ORBIT_OBSERVATIONS;
  delete process.env.LOOM_OBSERVATIONS;
  vi.resetModules();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  delete process.env.ORBIT_OBSERVATIONS;
  delete process.env.LOOM_OBSERVATIONS;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpHome, ".loom", "config.json");
}

function writeConfig(obj: unknown): void {
  fs.writeFileSync(configPath(), JSON.stringify(obj), "utf-8");
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

async function load() {
  return await import("../extensions/loom/observations-config.js");
}

describe("resolveObservationsMode", () => {
  it("defaults to ask with no config", async () => {
    writeConfig({});
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("ask");
  });

  it("reads the configured mode", async () => {
    writeConfig({ observations: { mode: "auto" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("auto");
  });

  it("falls back to ask on a junk configured mode", async () => {
    writeConfig({ observations: { mode: "yolo" } });
    const m = await load();
    expect(m.resolveObservationsMode()).toBe("ask");
  });

  it("hard-disables on either env spelling", async () => {
    writeConfig({ observations: { mode: "auto" } });
    process.env.LOOM_OBSERVATIONS = "off";
    let m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
    expect(m.isObservationsHardDisabled()).toBe(true);

    vi.resetModules();
    delete process.env.LOOM_OBSERVATIONS;
    process.env.ORBIT_OBSERVATIONS = "off";
    m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
  });

  it("honours an off under either spelling even when the other is set to something else", async () => {
    writeConfig({ observations: { mode: "auto" } });
    process.env.ORBIT_OBSERVATIONS = "auto";
    process.env.LOOM_OBSERVATIONS = "off";
    let m = await load();
    expect(m.resolveObservationsMode()).toBe("off");

    vi.resetModules();
    process.env.ORBIT_OBSERVATIONS = "OFF";
    process.env.LOOM_OBSERVATIONS = "auto";
    m = await load();
    expect(m.resolveObservationsMode()).toBe("off");
  });

  it("never lets an env value turn collection on", async () => {
    writeConfig({ observations: { mode: "off" } });
    for (const value of ["auto", "ask", "1", "on", "true"]) {
      vi.resetModules();
      process.env.ORBIT_OBSERVATIONS = value;
      const m = await load();
      expect(m.resolveObservationsMode(), value).toBe("off");
      expect(m.isObservationsHardDisabled(), value).toBe(false);
    }
  });
});

describe("setObservationsMode", () => {
  it("writes only the mode and leaves the rest of the config alone", async () => {
    writeConfig({
      testerId: "orbit-007",
      llm: { active: "anthropic", providers: { anthropic: { apiKey: "sk-secret-value" } } },
    });
    const m = await load();
    m.setObservationsMode("auto");
    const cfg = readConfig();
    expect(cfg.observations.mode).toBe("auto");
    expect(cfg.testerId).toBe("orbit-007");
    expect(cfg.llm.providers.anthropic.apiKey).toBe("sk-secret-value");
  });

  it("refuses to clobber an unparseable config", async () => {
    fs.writeFileSync(configPath(), "{ not json", "utf-8");
    const m = await load();
    expect(() => m.setObservationsMode("auto")).toThrow(/couldn't be read/i);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });

  it("refuses to change the mode while the env hard-disable is set", async () => {
    writeConfig({});
    process.env.ORBIT_OBSERVATIONS = "off";
    const m = await load();
    expect(() => m.setObservationsMode("auto")).toThrow(/hard-disabled/i);
  });
});

describe("getOrCreateInstallToken", () => {
  it("generates 32 lowercase hex once and persists it", async () => {
    writeConfig({});
    const m = await load();
    expect(m.peekInstallToken()).toBeUndefined();
    const first = m.getOrCreateInstallToken();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(readConfig().observations.installToken).toBe(first);

    vi.resetModules();
    const m2 = await load();
    expect(m2.getOrCreateInstallToken()).toBe(first);
  });

  it("replaces a malformed stored token", async () => {
    writeConfig({ observations: { installToken: "NOT-HEX" } });
    const m = await load();
    expect(m.getOrCreateInstallToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("auto-mode acknowledgement", () => {
  it("is false until marked, then persists", async () => {
    writeConfig({});
    const m = await load();
    expect(m.hasAcknowledgedAuto()).toBe(false);
    m.markAutoAcknowledged();
    expect(m.hasAcknowledgedAuto()).toBe(true);
    expect(readConfig().observations.autoAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
