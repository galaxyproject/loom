import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSecretValues, SECRET_ENV_VARS } from "../extensions/loom/secret-redaction.js";
import { resolveBypass, resolveSandbox } from "../extensions/loom/exec-guard/guardian-config.js";
import type { GuardianConfig } from "../shared/loom-config.js";
import { BRAIN_ENV_PREFIXES, buildBrainEnv } from "../shared/brain-env.js";
import { writeEnv } from "../shared/orbit-env.js";
import { isLocalExecDisabled } from "../extensions/loom/local-exec.js";
import gate from "../web/extensions/web-mode-gate.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// A security list that names only one spelling lets the other one walk past it.
describe("security lists name both spellings", () => {
  it("every LOOM_ secret env var has its ORBIT_ twin, and vice versa", () => {
    const names = new Set(SECRET_ENV_VARS);
    const missing: string[] = [];
    for (const n of names) {
      if (n.startsWith("LOOM_") && !names.has(n.replace(/^LOOM_/, "ORBIT_"))) missing.push(n);
      if (n.startsWith("ORBIT_") && !names.has(n.replace(/^ORBIT_/, "LOOM_"))) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it("redacts a custom-endpoint key carried under either spelling", () => {
    const cfg = {};
    expect(collectSecretValues(cfg, { LOOM_ACTIVE_LLM_API_KEY: "loom-key-123456" })).toContain(
      "loom-key-123456",
    );
    expect(collectSecretValues(cfg, { ORBIT_ACTIVE_LLM_API_KEY: "orbit-key-123456" })).toContain(
      "orbit-key-123456",
    );
  });

  it("brain-env forwards both prefixes", () => {
    expect(BRAIN_ENV_PREFIXES).toContain("LOOM_");
    expect(BRAIN_ENV_PREFIXES).toContain("ORBIT_");
  });
});

describe("exec-guard env gates behave the same under ORBIT_", () => {
  const cfg = { dangerouslyBypassPermissions: false, sandbox: false } as GuardianConfig;

  it.each(["LOOM_", "ORBIT_"])("%sDANGEROUSLY_BYPASS_PERMISSIONS turns bypass on", (p) => {
    vi.stubEnv("LOOM_DANGEROUSLY_BYPASS_PERMISSIONS", undefined);
    vi.stubEnv("ORBIT_DANGEROUSLY_BYPASS_PERMISSIONS", undefined);
    vi.stubEnv(`${p}DANGEROUSLY_BYPASS_PERMISSIONS`, "1");
    expect(resolveBypass(cfg)).toBe(true);
  });

  it.each([
    ["LOOM_", "ORBIT_"],
    ["ORBIT_", "LOOM_"],
  ])("%sSAFE wins over %sDANGEROUSLY_BYPASS_PERMISSIONS", (safe, bypass) => {
    vi.stubEnv(`${bypass}DANGEROUSLY_BYPASS_PERMISSIONS`, "1");
    vi.stubEnv(`${safe}SAFE`, "1");
    expect(resolveBypass({ ...cfg, dangerouslyBypassPermissions: true })).toBe(false);
  });

  it("--safe written by the CLI beats an ambient ORBIT_SAFE=0", () => {
    vi.stubEnv("LOOM_SAFE", undefined);
    vi.stubEnv("ORBIT_SAFE", "0");
    vi.stubEnv("ORBIT_DANGEROUSLY_BYPASS_PERMISSIONS", "1");
    writeEnv(process.env, "SAFE", "1");
    expect(resolveBypass(cfg)).toBe(false);
  });

  it.each(["LOOM_", "ORBIT_"])("%sSANDBOX turns the sandbox on", (p) => {
    vi.stubEnv("LOOM_SANDBOX", undefined);
    vi.stubEnv("ORBIT_SANDBOX", undefined);
    vi.stubEnv(`${p}SANDBOX`, "1");
    expect(resolveSandbox(cfg)).toBe(true);
  });

  it("a shell pinning LOCAL_EXEC=on can't be undone by an ambient ORBIT_LOCAL_EXEC=off", () => {
    const env = buildBrainEnv({ ORBIT_LOCAL_EXEC: "off", LOOM_LOCAL_EXEC: "off" });
    writeEnv(env, "LOCAL_EXEC", "on");
    expect(isLocalExecDisabled(env)).toBe(false);
  });
});

describe("web-mode-gate honors ORBIT_NOTEBOOK_ALLOWLIST", () => {
  type ToolEvent = { toolName: string; input: Record<string, unknown> };
  const NOTEBOOK = "/tmp/loom-session/notebook.md";

  it("confines writes to the ORBIT_-spelled allowlist", async () => {
    vi.stubEnv("LOOM_NOTEBOOK_ALLOWLIST", undefined);
    vi.stubEnv("ORBIT_NOTEBOOK_ALLOWLIST", NOTEBOOK);
    let handler: ((event: ToolEvent) => Promise<unknown>) | undefined;
    gate({
      on: (event: string, h: (event: ToolEvent) => Promise<unknown>) => {
        if (event === "tool_call") handler = h;
      },
    } as unknown as Parameters<typeof gate>[0]);
    expect(await handler!({ toolName: "edit", input: { path: NOTEBOOK } })).toBeUndefined();
    expect(
      await handler!({ toolName: "write", input: { path: "/tmp/loom-session/secret.txt" } }),
    ).toMatchObject({ block: true });
  });
});

// The image pins remote mode; an inherited twin must not talk the server out of it.
describe("remote mode pinning", () => {
  it("the image sets both spellings of MODE", async () => {
    const { readFileSync } = await import("node:fs");
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf-8");
    expect(docker).toMatch(/^ENV LOOM_MODE=remote$/m);
    expect(docker).toMatch(/^ENV ORBIT_MODE=remote$/m);
  });

  it("the server goes remote if any spelling says so", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../web/server.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/IS_REMOTE_MODE = envNames\("MODE"\)\.some\(/);
    expect(src).toMatch(/toLowerCase\(\) === "remote"/);
  });
});
