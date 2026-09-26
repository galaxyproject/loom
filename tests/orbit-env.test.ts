import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _setLegacyEnvWarnings,
  envNames,
  isDesktopShell,
  readEnv,
  writeEnv,
} from "../shared/orbit-env.js";
import { isLocalExecDisabled, isLocalShellDisabled } from "../extensions/loom/local-exec.js";
import { parsePageSyncMode } from "../extensions/loom/galaxy-page-sync.js";
import { resolveShutdownGraceMs } from "../web/shutdown-grace.js";
import { findOrbit } from "../extensions/orbit-handoff/orbit-launcher.js";
import { resolveActiveLlmApiKey } from "../shared/custom-provider.js";
import { buildBrainEnv } from "../shared/brain-env.js";

const REPO = resolve(import.meta.dirname, "..");

afterEach(() => {
  _setLegacyEnvWarnings(false);
  vi.restoreAllMocks();
});

describe("readEnv", () => {
  it("prefers the ORBIT_ spelling", () => {
    expect(readEnv("MODE", { ORBIT_MODE: "remote", LOOM_MODE: "local" })).toBe("remote");
  });

  it("falls back to the LOOM_ spelling", () => {
    expect(readEnv("MODE", { LOOM_MODE: "remote" })).toBe("remote");
  });

  it("treats an empty ORBIT_ value as set", () => {
    expect(readEnv("MODE", { ORBIT_MODE: "", LOOM_MODE: "remote" })).toBe("");
  });

  it("returns undefined when neither is set", () => {
    expect(readEnv("MODE", {})).toBeUndefined();
  });

  it("maps the desktop binary to ORBIT_DESKTOP_BIN with ORBIT_BIN as the legacy alias", () => {
    expect(envNames("DESKTOP_BIN")).toEqual(["ORBIT_DESKTOP_BIN", "ORBIT_BIN"]);
    expect(readEnv("DESKTOP_BIN", { ORBIT_BIN: "/old" })).toBe("/old");
    expect(readEnv("DESKTOP_BIN", { ORBIT_BIN: "/old", ORBIT_DESKTOP_BIN: "/new" })).toBe("/new");
  });

  it("maps the core entry to ORBIT_CORE_BIN with LOOM_BIN as the legacy alias", () => {
    expect(envNames("CORE_BIN")).toEqual(["ORBIT_CORE_BIN", "LOOM_BIN"]);
    expect(readEnv("CORE_BIN", { LOOM_BIN: "/x/loom.js" })).toBe("/x/loom.js");
  });

  it("warns once per legacy name when warnings are on", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    _setLegacyEnvWarnings(true);
    readEnv("MODE", { LOOM_MODE: "remote" });
    readEnv("MODE", { LOOM_MODE: "remote" });
    readEnv("MODE", { ORBIT_MODE: "remote", LOOM_MODE: "remote" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("LOOM_MODE");
    expect(String(write.mock.calls[0][0])).toContain("ORBIT_MODE");
  });

  it("stays silent by default in the compatibility release", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    readEnv("MODE", { LOOM_MODE: "remote" });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("writeEnv", () => {
  it("sets both spellings so old bundles and new readers agree", () => {
    const env: Record<string, string | undefined> = { ORBIT_LOCAL_EXEC: "off" };
    writeEnv(env, "LOCAL_EXEC", "on");
    expect(env).toEqual({ ORBIT_LOCAL_EXEC: "on", LOOM_LOCAL_EXEC: "on" });
    expect(isLocalExecDisabled(env)).toBe(false);
  });
});

describe("SHELL_KIND", () => {
  it.each([
    [{ LOOM_SHELL_KIND: "orbit" }, true],
    [{ ORBIT_SHELL_KIND: "orbit" }, true],
    [{ ORBIT_SHELL_KIND: "desktop" }, true],
    [{ LOOM_SHELL_KIND: "desktop" }, true],
    [{ ORBIT_SHELL_KIND: "cli", LOOM_SHELL_KIND: "orbit" }, false],
    [{}, false],
  ])("isDesktopShell(%p) is %p", (env, expected) => {
    expect(isDesktopShell(env)).toBe(expected);
  });
});

describe("user-facing vars work under both names", () => {
  it.each(["LOOM_", "ORBIT_"])("%s spelling", (prefix) => {
    expect(isLocalExecDisabled({ [`${prefix}LOCAL_EXEC`]: "off" })).toBe(true);
    expect(isLocalShellDisabled({ [`${prefix}LOCAL_SHELL`]: "off" })).toBe(true);
    expect(parsePageSyncMode({ [`${prefix}GALAXY_PAGE_SYNC`]: "auto" })).toBe("auto");
    expect(resolveShutdownGraceMs({ [`${prefix}SHUTDOWN_GRACE_MS`]: "42" })).toBe(42);
    expect(resolveActiveLlmApiKey({}, { [`${prefix}ACTIVE_LLM_API_KEY`]: "k" })).toBe("k");
    expect(buildBrainEnv({ [`${prefix}MODE`]: "remote" })[`${prefix}MODE`]).toBe("remote");
  });

  it.each(["ORBIT_DESKTOP_BIN", "ORBIT_BIN"])("findOrbit honors %s", (name) => {
    const found = findOrbit({
      platform: "linux",
      homedir: "/home/u",
      env: { [name]: "/opt/orbit" },
      existsSync: (p: string) => p === "/opt/orbit",
    });
    expect(found).toBe("/opt/orbit");
  });
});

// Every LOOM_/ORBIT_ read has to go through the helper, or the other spelling
// silently stops working for that one var.
describe("no raw LOOM_/ORBIT_ env access outside the helper", () => {
  const RAW = /\benv(?:\.|\[\s*["'`])(?:LOOM|ORBIT)_[A-Z]/;

  it("finds none in shipped code", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--", "bin", "extensions", "shared", "app/src", "web"],
      { cwd: REPO, encoding: "utf-8" },
    )
      .split("\n")
      .filter((f) => /\.(ts|js|mjs|cjs)$/.test(f))
      .filter((f) => !/\.test\.ts$/.test(f))
      .filter((f) => !f.startsWith("extensions/loom/vendor/"))
      .filter((f) => f !== "shared/orbit-env.js");
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(resolve(REPO, f), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (RAW.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
