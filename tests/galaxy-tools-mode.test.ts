import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/loom/config")>()),
  loadConfig: loadConfigMock,
}));

import { applyGalaxyToolsMode, galaxyToolsMode } from "../extensions/loom/galaxy-tools-mode";
import {
  capabilityProfile,
  installedCapabilityProfile,
  profileFromEnv,
  setCapabilityProfile,
} from "../shared/capability-profile.js";
import * as capabilityProfileModule from "../shared/capability-profile.js";

const FLAG_NAMES = [
  "LOOM_GALAXY_TOOLS",
  "ORBIT_GALAXY_TOOLS",
  "LOOM_LOCAL_EXEC",
  "ORBIT_LOCAL_EXEC",
] as const;

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({});
  for (const name of FLAG_NAMES) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setCapabilityProfile(null);
});

describe("galaxyToolsMode", () => {
  it("defaults to mcp", () => {
    expect(galaxyToolsMode({})).toBe("mcp");
  });

  it.each([
    ["bare", "bare"],
    ["mcp", "mcp"],
    [" BARE ", "bare"],
  ])("reads LOOM_GALAXY_TOOLS=%p as %p", (value, mode) => {
    expect(galaxyToolsMode({ LOOM_GALAXY_TOOLS: value })).toBe(mode);
  });

  it("prefers the ORBIT_ spelling over the LOOM_ one", () => {
    expect(galaxyToolsMode({ ORBIT_GALAXY_TOOLS: "mcp", LOOM_GALAXY_TOOLS: "bare" })).toBe("mcp");
    expect(galaxyToolsMode({ ORBIT_GALAXY_TOOLS: "bare", LOOM_GALAXY_TOOLS: "mcp" })).toBe("bare");
  });

  it("falls back to the config, which env overrides", () => {
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "bare" } });
    expect(galaxyToolsMode({})).toBe("bare");
    expect(galaxyToolsMode({ LOOM_GALAXY_TOOLS: "mcp" })).toBe("mcp");
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "mcp" } });
    expect(galaxyToolsMode({})).toBe("mcp");
  });

  it("lets an unrecognised env value fall through to the config", () => {
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "bare" } });
    expect(galaxyToolsMode({ LOOM_GALAXY_TOOLS: "yes" })).toBe("bare");
    loadConfigMock.mockReturnValue({});
    expect(galaxyToolsMode({ LOOM_GALAXY_TOOLS: "" })).toBe("mcp");
  });

  it("ignores a config value that is not bare", () => {
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "BARE" } });
    expect(galaxyToolsMode({})).toBe("mcp");
  });

  it("is forced to mcp without a local exec surface", () => {
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "bare" } });
    expect(galaxyToolsMode({ LOOM_LOCAL_EXEC: "off", LOOM_GALAXY_TOOLS: "bare" })).toBe("mcp");
    expect(galaxyToolsMode({ ORBIT_LOCAL_EXEC: "off" })).toBe("mcp");
  });
});

describe("applyGalaxyToolsMode", () => {
  it("installs nothing under the default", () => {
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBeNull();
    expect(capabilityProfile().galaxyTools).toBe("mcp");
  });

  it("installs nothing when the flag says mcp", () => {
    vi.stubEnv("LOOM_GALAXY_TOOLS", "mcp");
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBeNull();
  });

  it("installs env's profile with bare Galaxy tools under bare", () => {
    vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toEqual({
      ...profileFromEnv(),
      galaxyTools: "bare",
    });
    expect(capabilityProfile().mcpServers).toBe(true);
  });

  it("installs from the config alone", () => {
    loadConfigMock.mockReturnValue({ experiments: { galaxyTools: "bare" } });
    applyGalaxyToolsMode();
    expect(capabilityProfile().galaxyTools).toBe("bare");
  });

  it("re-evaluates on a reload, taking its own profile down when the flag goes", () => {
    vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
    applyGalaxyToolsMode();
    const first = installedCapabilityProfile();
    expect(first?.galaxyTools).toBe("bare");
    applyGalaxyToolsMode();
    // Reinstalled from env, not kept: a reload sees whatever env says now.
    expect(installedCapabilityProfile()).not.toBe(first);
    expect(installedCapabilityProfile()?.galaxyTools).toBe("bare");
    vi.stubEnv("LOOM_GALAXY_TOOLS", undefined);
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBeNull();
  });

  describe("across a real reload", () => {
    // pi reloads the extension through a fresh Jiti loader with no module cache, so this
    // module comes back new while shared/capability-profile.js, native ESM, stays cached.
    async function freshMode() {
      vi.resetModules();
      vi.doMock("../shared/capability-profile.js", () => capabilityProfileModule);
      try {
        return await import("../extensions/loom/galaxy-tools-mode");
      } finally {
        vi.doUnmock("../shared/capability-profile.js");
      }
    }

    it("takes its bare profile down when the flag goes back to mcp", async () => {
      vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
      applyGalaxyToolsMode();
      expect(installedCapabilityProfile()?.galaxyTools).toBe("bare");
      vi.stubEnv("LOOM_GALAXY_TOOLS", "mcp");
      (await freshMode()).applyGalaxyToolsMode();
      expect(installedCapabilityProfile()).toBeNull();
      expect(capabilityProfile().galaxyTools).toBe("mcp");
    });

    it("installs bare when the flag turns on", async () => {
      vi.stubEnv("LOOM_GALAXY_TOOLS", "mcp");
      applyGalaxyToolsMode();
      expect(installedCapabilityProfile()).toBeNull();
      vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
      (await freshMode()).applyGalaxyToolsMode();
      expect(installedCapabilityProfile()?.galaxyTools).toBe("bare");
    });

    it("still leaves a shell's own profile alone", async () => {
      const shell = { ...profileFromEnv({}), galaxyTools: "bare" as const, mcpServers: false };
      setCapabilityProfile(shell);
      const installed = installedCapabilityProfile();
      (await freshMode()).applyGalaxyToolsMode();
      expect(installedCapabilityProfile()).toBe(installed);
    });
  });

  it("leaves a shell's own profile alone under either flag value", () => {
    const shell = { ...profileFromEnv({}), galaxyTools: "bare" as const, mcpServers: false };
    setCapabilityProfile(shell);
    const installed = installedCapabilityProfile();
    vi.stubEnv("LOOM_GALAXY_TOOLS", "mcp");
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBe(installed);
    vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBe(installed);
    expect(installedCapabilityProfile()?.mcpServers).toBe(false);
  });

  it("does not read the config while a shell's profile is installed", () => {
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    applyGalaxyToolsMode();
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("is forced to mcp under LOCAL_EXEC=off and installs nothing", () => {
    vi.stubEnv("LOOM_LOCAL_EXEC", "off");
    vi.stubEnv("LOOM_GALAXY_TOOLS", "bare");
    applyGalaxyToolsMode();
    expect(installedCapabilityProfile()).toBeNull();
  });
});
