import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Dependencies findOrbit() reads from the environment. Threaded as a
 * parameter so tests can pass a synthetic platform/env/fs without fighting
 * vi.stubGlobal on process (some code paths capture process.platform at
 * module load and never re-read it).
 */
export interface FindOrbitDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  existsSync: (p: string) => boolean;
}

function realDeps(): FindOrbitDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    existsSync: fs.existsSync,
  };
}

/**
 * Locate an installed Orbit binary on disk.
 *
 * Priority:
 *   1. $ORBIT_BIN env var (escape hatch for non-standard installs / dev builds).
 *   2. Platform-conventional install paths (Applications, /usr/bin, etc.).
 *
 * Returns the absolute path or null if Orbit isn't installed.
 */
export function findOrbit(deps: FindOrbitDeps = realDeps()): string | null {
  const override = deps.env.ORBIT_BIN;
  if (override) {
    return deps.existsSync(override) ? override : null;
  }
  if (deps.platform === "darwin") {
    const candidates = [
      "/Applications/Orbit.app/Contents/MacOS/Orbit",
      `${deps.homedir}/Applications/Orbit.app/Contents/MacOS/Orbit`,
    ];
    for (const c of candidates) if (deps.existsSync(c)) return c;
    return null;
  }
  if (deps.platform === "linux") {
    const candidates = [
      `${deps.homedir}/.local/bin/Orbit.AppImage`,
      "/usr/bin/orbit",
      "/usr/local/bin/orbit",
      `${deps.homedir}/Applications/Orbit.AppImage`,
    ];
    for (const c of candidates) if (deps.existsSync(c)) return c;
    return null;
  }
  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA;
    if (!localAppData) return null;
    const candidates = [
      `${localAppData}\\orbit\\Orbit.exe`,
      `${localAppData}\\Programs\\orbit\\Orbit.exe`,
    ];
    for (const c of candidates) if (deps.existsSync(c)) return c;
    return null;
  }
  return null;
}

export interface LaunchResult {
  pid: number | undefined;
}

/**
 * Launch Orbit detached with --cwd <cwd>. Returns immediately. The caller
 * is responsible for the rest of session-shutdown -- launchOrbit does not
 * wait for Orbit to start.
 */
export function launchOrbit(orbitPath: string, cwd: string): LaunchResult {
  const child = spawn(orbitPath, ["--cwd", cwd], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid };
}
