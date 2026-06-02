import { spawn } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  findOrbit,
  launchOrbit,
  type FindOrbitDeps,
} from "../extensions/orbit-handoff/orbit-launcher";
import { handleOrbitHandoff } from "../extensions/orbit-handoff";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function deps(over: Partial<FindOrbitDeps> = {}): FindOrbitDeps {
  return {
    platform: "linux",
    env: {},
    homedir: "/home/me",
    existsSync: () => false,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("findOrbit -- env override", () => {
  it("returns ORBIT_BIN when set and the file exists", () => {
    const d = deps({
      env: { ORBIT_BIN: "/custom/path/Orbit" },
      existsSync: (p) => p === "/custom/path/Orbit",
    });
    expect(findOrbit(d)).toBe("/custom/path/Orbit");
  });

  it("returns null when ORBIT_BIN is set but missing on disk", () => {
    const d = deps({ env: { ORBIT_BIN: "/nope" }, existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});

describe("findOrbit -- darwin", () => {
  it("returns /Applications/Orbit.app's binary when installed", () => {
    const macPath = "/Applications/Orbit.app/Contents/MacOS/orbit";
    const d = deps({ platform: "darwin", existsSync: (p) => p === macPath });
    expect(findOrbit(d)).toBe(macPath);
  });

  it("falls back to ~/Applications/Orbit.app when system Applications is empty", () => {
    const userMacPath = "/home/me/Applications/Orbit.app/Contents/MacOS/orbit";
    const d = deps({ platform: "darwin", existsSync: (p) => p === userMacPath });
    expect(findOrbit(d)).toBe(userMacPath);
  });

  it("returns null when neither location has Orbit", () => {
    const d = deps({ platform: "darwin", existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});

describe("findOrbit -- linux", () => {
  it("finds an AppImage at ~/.local/bin/Orbit.AppImage", () => {
    const p = "/home/me/.local/bin/Orbit.AppImage";
    const d = deps({ platform: "linux", existsSync: (q) => q === p });
    expect(findOrbit(d)).toBe(p);
  });

  it("finds a deb/rpm install at /usr/bin/orbit", () => {
    const d = deps({ platform: "linux", existsSync: (q) => q === "/usr/bin/orbit" });
    expect(findOrbit(d)).toBe("/usr/bin/orbit");
  });

  it("returns null when no candidate exists", () => {
    const d = deps({ platform: "linux", existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});

describe("findOrbit -- win32", () => {
  it("finds Orbit.exe in the Squirrel default install dir", () => {
    const localAppData = "C:\\Users\\u\\AppData\\Local";
    const p = `${localAppData}\\orbit\\Orbit.exe`;
    const d = deps({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      existsSync: (q) => q === p,
    });
    expect(findOrbit(d)).toBe(p);
  });

  it("returns null when LOCALAPPDATA is unset", () => {
    const d = deps({ platform: "win32", env: {}, existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});

describe("launchOrbit", () => {
  it("spawns the orbit binary with --cwd, attaches an error handler, and detaches", () => {
    const fakeChild = { unref: vi.fn(), on: vi.fn(), pid: 12345 };
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const result = launchOrbit("/path/to/Orbit", "/Users/me/analysis");
    expect(spawn).toHaveBeenCalledWith(
      "/path/to/Orbit",
      ["--cwd", "/Users/me/analysis"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    // a detached child needs an 'error' listener or a failed launch crashes the CLI
    expect(fakeChild.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(result.pid).toBe(12345);
  });
});

describe("handleOrbitHandoff -- embedded guard", () => {
  const prev = process.env.LOOM_SHELL_KIND;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOOM_SHELL_KIND;
    else process.env.LOOM_SHELL_KIND = prev;
  });

  it("no-ops with a notice (no shutdown, no spawn) when already inside Orbit", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const notify = vi.fn();
    const shutdown = vi.fn();
    await handleOrbitHandoff(undefined, {
      cwd: "/Users/me/analysis",
      ui: { notify },
      shutdown,
    } as any);
    expect(shutdown).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("already in Orbit"), "info");
  });
});

describe("handleOrbitHandoff -- launch (no auto-exit)", () => {
  const prevShell = process.env.LOOM_SHELL_KIND;
  const prevBin = process.env.ORBIT_BIN;
  beforeEach(() => {
    delete process.env.LOOM_SHELL_KIND; // not embedded
    process.env.ORBIT_BIN = process.execPath; // a path that always exists, so findOrbit resolves
  });
  afterEach(() => {
    if (prevShell === undefined) delete process.env.LOOM_SHELL_KIND;
    else process.env.LOOM_SHELL_KIND = prevShell;
    if (prevBin === undefined) delete process.env.ORBIT_BIN;
    else process.env.ORBIT_BIN = prevBin;
  });

  it("launches Orbit, tells the user how to close the CLI, and does NOT auto-exit", async () => {
    const fakeChild = { unref: vi.fn(), on: vi.fn(), pid: 999 };
    vi.mocked(spawn).mockReturnValue(fakeChild as any);
    const notify = vi.fn();
    const shutdown = vi.fn();
    await handleOrbitHandoff(undefined, {
      cwd: "/Users/me/analysis",
      ui: { notify },
      shutdown,
    } as any);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--cwd", "/Users/me/analysis"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    // the descoped behavior: never auto-exits the CLI ...
    expect(shutdown).not.toHaveBeenCalled();
    // ... and tells the user how to close it themselves
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Ctrl-D|\/exit/), "info");
  });
});
