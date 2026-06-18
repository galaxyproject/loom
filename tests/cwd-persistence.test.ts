import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// agent.ts -> secure-config.ts imports `electron` at module top. Stub the
// small surface area so the root vitest run never needs app/node_modules/electron.
vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
}));

// loadConfig/saveConfig resolve ~/.loom via os.homedir(). Point homedir at a
// temp dir so the test exercises a real read/write round-trip without touching
// the developer's actual config.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cwd-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(obj: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".loom", "config.json"), JSON.stringify(obj));
}
function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(tmp, ".loom", "config.json"), "utf-8"));
}
function makeWindow() {
  return { isDestroyed: () => false, setTitle: vi.fn(), webContents: { send: vi.fn() } };
}

describe("switchCwd persists the active analysis directory (#312)", () => {
  it("writes the new directory to config.defaultCwd", async () => {
    const { AgentManager } = await import("../app/src/main/agent.js");
    const manager = new AgentManager(makeWindow() as any, path.join(tmp, "old"));

    expect(manager.switchCwd(path.join(tmp, "new"))).toBe(true);

    const { loadConfig } = await import("../shared/loom-config.js");
    expect(loadConfig().defaultCwd).toBe(path.join(tmp, "new"));
  });

  it("preserves stored credentials and other keys when persisting the cwd", async () => {
    writeConfig({
      testerId: "orbit-007",
      llm: {
        active: "anthropic",
        providers: { anthropic: { apiKeyEncrypted: "ENC", model: "x" } },
      },
      defaultCwd: path.join(tmp, "old"),
    });
    const { AgentManager } = await import("../app/src/main/agent.js");
    const manager = new AgentManager(makeWindow() as any, path.join(tmp, "old"));

    manager.switchCwd(path.join(tmp, "new"));

    const cfg = readConfig();
    expect(cfg.defaultCwd).toBe(path.join(tmp, "new"));
    expect(cfg.testerId).toBe("orbit-007");
    expect(cfg.llm.providers.anthropic.apiKeyEncrypted).toBe("ENC");
  });

  it("does not rewrite config when the cwd is unchanged", async () => {
    // Config drift: disk says "/stale" while the manager sits at "/same". A
    // no-op switch must not touch config, so the stale value is left intact.
    writeConfig({ defaultCwd: path.join(tmp, "stale") });
    const { AgentManager } = await import("../app/src/main/agent.js");
    const manager = new AgentManager(makeWindow() as any, path.join(tmp, "same"));

    expect(manager.switchCwd(path.join(tmp, "same"))).toBe(false);
    expect(readConfig().defaultCwd).toBe(path.join(tmp, "stale"));
  });

  it("does not persist a transient --cwd override (persist: false)", async () => {
    // A second-instance `Orbit --cwd X` is a one-off session choice, not a new
    // default -- it must switch the directory without rewriting config.
    writeConfig({ defaultCwd: path.join(tmp, "saved") });
    const { AgentManager } = await import("../app/src/main/agent.js");
    const manager = new AgentManager(makeWindow() as any, path.join(tmp, "saved"));

    expect(manager.switchCwd(path.join(tmp, "scratch"), { persist: false })).toBe(true);
    expect(readConfig().defaultCwd).toBe(path.join(tmp, "saved"));
  });

  it("fails closed: a corrupt config.json is switched against but never clobbered", async () => {
    // loadConfig() returns {} on a parse error, so a naive write-back would wipe
    // the user's credentials. The switch still happens in-memory; the file is left
    // untouched for the user to repair.
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    const cfgPath = path.join(tmp, ".loom", "config.json");
    fs.writeFileSync(cfgPath, "{ not valid json");
    const { AgentManager } = await import("../app/src/main/agent.js");
    const manager = new AgentManager(makeWindow() as any, path.join(tmp, "old"));

    expect(manager.switchCwd(path.join(tmp, "new"))).toBe(true);
    expect(fs.readFileSync(cfgPath, "utf-8")).toBe("{ not valid json");
  });
});

describe("resolveStartupCwd precedence", () => {
  it("prefers the --cwd CLI arg above everything", async () => {
    const { resolveStartupCwd } = await import("../app/src/main/startup-cwd.js");
    expect(
      resolveStartupCwd({
        cliCwd: "/cli",
        envCwd: "/env",
        configDefaultCwd: "/cfg",
        fallback: "/fb",
      }),
    ).toBe("/cli");
  });

  it("falls back to LOOM_CWD env when there is no CLI arg", async () => {
    const { resolveStartupCwd } = await import("../app/src/main/startup-cwd.js");
    expect(resolveStartupCwd({ envCwd: "/env", configDefaultCwd: "/cfg", fallback: "/fb" })).toBe(
      "/env",
    );
  });

  it("restores the persisted config.defaultCwd when no CLI arg or env is set", async () => {
    const { resolveStartupCwd } = await import("../app/src/main/startup-cwd.js");
    expect(resolveStartupCwd({ configDefaultCwd: "/cfg", fallback: "/fb" })).toBe("/cfg");
  });

  it("uses the hardcoded fallback when nothing else is set", async () => {
    const { resolveStartupCwd } = await import("../app/src/main/startup-cwd.js");
    expect(resolveStartupCwd({ fallback: "/fb" })).toBe("/fb");
  });
});
