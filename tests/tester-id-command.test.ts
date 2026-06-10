import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateTesterId,
  setTesterId,
  getCurrentTesterId,
  registerTesterIdCommand,
} from "../extensions/loom/tester-id-command";

describe("validateTesterId", () => {
  it("accepts a normal tester code", () => {
    expect(validateTesterId("orbit-007")).toEqual({ ok: true, id: "orbit-007" });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateTesterId("  orbit-007  ")).toEqual({ ok: true, id: "orbit-007" });
  });

  it("rejects an empty / whitespace-only id", () => {
    expect(validateTesterId("").ok).toBe(false);
    expect(validateTesterId("   ").ok).toBe(false);
  });

  it("rejects ids with spaces, newlines, or path/JSON characters", () => {
    for (const bad of ["a b", "a\nb", "a/b", "a;b", '{"x":1}', "../etc"]) {
      expect(validateTesterId(bad).ok).toBe(false);
    }
  });

  it("rejects a leading separator (first char must be alphanumeric)", () => {
    expect(validateTesterId("-orbit").ok).toBe(false);
    expect(validateTesterId(".orbit").ok).toBe(false);
  });

  it("rejects an over-long id", () => {
    expect(validateTesterId("a".repeat(65)).ok).toBe(false);
  });
});

describe("setTesterId (disk round-trip)", () => {
  let tmp: string;
  const configFile = () => path.join(tmp, ".loom", "config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(configFile(), "utf-8"));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-testerid-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes only the testerId key and preserves existing secrets", () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        llm: {
          active: "anthropic",
          providers: { anthropic: { apiKey: "sk-SECRET-keep-me", model: "claude" } },
        },
      }),
    );

    setTesterId("orbit-007");

    const cfg = readConfig();
    expect(cfg.testerId).toBe("orbit-007");
    // The existing API key must survive untouched.
    expect(cfg.llm.providers.anthropic.apiKey).toBe("sk-SECRET-keep-me");
  });

  it("creates the config when none exists yet", () => {
    setTesterId("orbit-042");
    expect(readConfig().testerId).toBe("orbit-042");
  });

  it("overwrites a previously-set testerId", () => {
    setTesterId("orbit-001");
    setTesterId("orbit-002");
    expect(readConfig().testerId).toBe("orbit-002");
  });

  it("fails closed on an unreadable config instead of clobbering secrets", () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    // Invalid JSON that still holds a secret-shaped value loadConfig would drop.
    const corrupt = '{ "llm": broken, "apiKey": "sk-SECRET-keep-me"';
    fs.writeFileSync(configFile(), corrupt);

    expect(() => setTesterId("orbit-007")).toThrow(/couldn't be read/i);
    // The file is left byte-for-byte intact -- the secret survives.
    expect(fs.readFileSync(configFile(), "utf-8")).toBe(corrupt);
  });

  it("rewraps a save failure in a fixed message, never reflecting the raw error", () => {
    // Make ~/.loom a regular file so saveConfig's mkdir fails for real.
    fs.writeFileSync(path.join(tmp, ".loom"), "not a directory");

    let caught: unknown;
    try {
      setTesterId("orbit-007");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/couldn't write .*config\.json/i);
    // No raw fs error leaks through: no errno, no real on-disk path.
    expect(msg).not.toMatch(/ENOTDIR|EEXIST|EACCES|ENOSPC/);
    expect(msg).not.toContain(tmp);
  });
});

describe("registerTesterIdCommand handler", () => {
  let tmp: string;
  const readConfig = () =>
    JSON.parse(fs.readFileSync(path.join(tmp, ".loom", "config.json"), "utf-8"));

  // Capture the registered handler + every notify call.
  function harness() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const notifications: { msg: string; level: string }[] = [];
    const pi = {
      registerCommand: (
        name: string,
        def: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => commands.set(name, def),
    };
    const ctx = {
      hasUI: true,
      ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
    };
    registerTesterIdCommand(pi as never);
    return { commands, notifications, ctx };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-testerid-cmd-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registers the tester-id command", () => {
    const { commands } = harness();
    expect(commands.has("tester-id")).toBe(true);
  });

  it("sets the id from args and confirms with an info notification", async () => {
    const { commands, notifications, ctx } = harness();
    await commands.get("tester-id")!.handler("orbit-007", ctx);

    expect(readConfig().testerId).toBe("orbit-007");
    expect(notifications.some((n) => n.level === "info" && n.msg.includes("orbit-007"))).toBe(true);
  });

  it("with no argument, reports the current tester ID", async () => {
    setTesterId("orbit-099");
    const { commands, notifications, ctx } = harness();
    await commands.get("tester-id")!.handler("", ctx);

    expect(notifications.some((n) => n.level === "info" && n.msg.includes("orbit-099"))).toBe(true);
  });

  it("with no argument and none set, says so without erroring", async () => {
    const { commands, notifications, ctx } = harness();
    await commands.get("tester-id")!.handler(undefined as never, ctx);

    expect(notifications.length).toBe(1);
    expect(notifications[0].level).toBe("info");
    expect(notifications[0].msg).toMatch(/no tester id set/i);
  });

  it("rejects an invalid id without writing config", async () => {
    const { commands, notifications, ctx } = harness();
    await commands.get("tester-id")!.handler("not valid!!", ctx);

    expect(fs.existsSync(path.join(tmp, ".loom", "config.json"))).toBe(false);
    expect(notifications.some((n) => n.level === "error")).toBe(true);
  });

  it("never echoes another config value in its confirmation (#183)", async () => {
    fs.mkdirSync(path.join(tmp, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".loom", "config.json"),
      JSON.stringify({
        llm: {
          active: "anthropic",
          providers: { anthropic: { apiKey: "sk-SECRET-should-never-appear" } },
        },
      }),
    );

    const { commands, notifications, ctx } = harness();
    await commands.get("tester-id")!.handler("orbit-007", ctx);

    // The key is preserved on disk...
    expect(readConfig().llm.providers.anthropic.apiKey).toBe("sk-SECRET-should-never-appear");
    // ...but never surfaced back to the user/model in any notification.
    for (const n of notifications) {
      expect(n.msg).not.toContain("sk-SECRET-should-never-appear");
    }
  });
});

describe("getCurrentTesterId", () => {
  let tmp: string;
  const savedEnv = process.env.LOOM_TESTER_ID;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-testerid-get-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    delete process.env.LOOM_TESTER_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.LOOM_TESTER_ID;
    else process.env.LOOM_TESTER_ID = savedEnv;
  });

  it("returns null when nothing is set", () => {
    expect(getCurrentTesterId()).toBeNull();
  });

  it("reads the configured id (source: config)", () => {
    setTesterId("orbit-007");
    expect(getCurrentTesterId()).toEqual({ id: "orbit-007", source: "config" });
  });

  it("falls back to the env override when config is empty (source: env)", () => {
    process.env.LOOM_TESTER_ID = "orbit-env";
    expect(getCurrentTesterId()).toEqual({ id: "orbit-env", source: "env" });
  });

  it("prefers the configured id over the env override", () => {
    process.env.LOOM_TESTER_ID = "orbit-env";
    setTesterId("orbit-config");
    expect(getCurrentTesterId()).toEqual({ id: "orbit-config", source: "config" });
  });
});
