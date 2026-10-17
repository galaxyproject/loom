import { afterEach, describe, it, expect } from "vitest";
import {
  capabilityProfile,
  installedCapabilityProfile,
  profileFromEnv,
  setCapabilityProfile,
} from "../shared/capability-profile.js";

describe("profileFromEnv", () => {
  it("describes a full local shell when nothing is set", () => {
    expect(profileFromEnv({})).toEqual({
      shell: true,
      files: true,
      notebook: "file",
      network: true,
      galaxyTools: "mcp",
      mcpServers: true,
      ui: "terminal",
    });
  });

  it("drops files on LOCAL_EXEC=off without also dropping the shell", () => {
    const p = profileFromEnv({ LOOM_LOCAL_EXEC: "off" });
    expect(p.files).toBe(false);
    expect(p.shell).toBe(true);
  });

  it("drops only the shell on LOCAL_SHELL=off", () => {
    const p = profileFromEnv({ ORBIT_LOCAL_SHELL: "off" });
    expect(p.shell).toBe(false);
    expect(p.files).toBe(true);
  });

  it.each(["on", "", "OFF", "false", "0"])("keeps both on for %p", (value) => {
    const p = profileFromEnv({ LOOM_LOCAL_EXEC: value, LOOM_LOCAL_SHELL: value });
    expect(p.files).toBe(true);
    expect(p.shell).toBe(true);
  });

  it("reports a desktop ui under the desktop shell", () => {
    expect(profileFromEnv({ ORBIT_SHELL_KIND: "desktop" }).ui).toBe("desktop");
    expect(profileFromEnv({ LOOM_SHELL_KIND: "orbit" }).ui).toBe("desktop");
  });
});

describe("capabilityProfile", () => {
  afterEach(() => setCapabilityProfile(null));

  it("answers with the installed profile when a shell set one", () => {
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    expect(capabilityProfile().ui).toBe("worker");
  });

  it("reads an explicit env even while a profile is installed", () => {
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    expect(capabilityProfile({}).ui).toBe("terminal");
  });

  it("hands back the installed object itself, and null under env", () => {
    expect(installedCapabilityProfile()).toBeNull();
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    expect(installedCapabilityProfile()).toBe(capabilityProfile());
    setCapabilityProfile(null);
    expect(installedCapabilityProfile()).toBeNull();
  });

  it("falls back to env once the profile is cleared", () => {
    setCapabilityProfile({ ...profileFromEnv({}), ui: "worker" });
    setCapabilityProfile(null);
    expect(capabilityProfile()).toEqual(profileFromEnv(process.env));
  });
});
