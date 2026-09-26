import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { readEnv } from "../../shared/orbit-env.js";

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
  /** Optional so synthetic deps default to "every path is its own target". */
  realpathSync?: (p: string) => string;
}

function realDeps(): FindOrbitDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync,
  };
}

/**
 * True when a candidate resolves to a Node CLI entry point rather than the
 * Electron binary. Once the CLI is published as `orbit`, a global npm install
 * under /usr or /usr/local puts its shim at exactly the path the old desktop
 * .deb used, and spawning that would just start another terminal session.
 */
export function isNodeCliShim(resolved: string): boolean {
  const p = resolved.replace(/\\/g, "/");
  return (
    /\.(c|m)?js$/i.test(p) ||
    p.includes("/node_modules/.bin/") ||
    p.includes("/node_modules/@galaxyproject/")
  );
}

function acceptable(candidate: string, deps: FindOrbitDeps): boolean {
  if (!deps.existsSync(candidate)) return false;
  let resolved: string;
  try {
    resolved = deps.realpathSync ? deps.realpathSync(candidate) : candidate;
  } catch {
    return false;
  }
  return !isNodeCliShim(resolved);
}

/**
 * Locate an installed Orbit binary on disk.
 *
 * Priority:
 *   1. $ORBIT_DESKTOP_BIN, or its older alias $ORBIT_BIN (escape hatch for
 *      non-standard installs / dev builds).
 *   2. Platform-conventional install paths (Applications, /usr/bin, etc.).
 *
 * Any candidate that resolves to a Node CLI shim is skipped -- see isNodeCliShim.
 *
 * Returns the absolute path or null if Orbit isn't installed.
 */
export function findOrbit(deps: FindOrbitDeps = realDeps()): string | null {
  // readEnv prefers ORBIT_DESKTOP_BIN over the older ORBIT_BIN alias.
  const override = readEnv("DESKTOP_BIN", deps.env);
  if (override) {
    return acceptable(override, deps) ? override : null;
  }
  if (deps.platform === "darwin") {
    // The bundle is Orbit.app but the inner binary is lowercase `orbit`
    // (forge.config.ts sets executableName: "orbit", which CFBundleExecutable
    // inherits). Pointing at capital-O Orbit silently misses every real install.
    const candidates = [
      "/Applications/Orbit.app/Contents/MacOS/orbit",
      `${deps.homedir}/Applications/Orbit.app/Contents/MacOS/orbit`,
    ];
    for (const c of candidates) if (acceptable(c, deps)) return c;
    return null;
  }
  if (deps.platform === "linux") {
    // The desktop's Linux executable is moving to `orbit-desktop` so the CLI
    // can own `orbit` on PATH. electron-installer-debian/redhat install the app
    // under /usr/lib/<package name>/ and symlink /usr/bin/<package name> to it,
    // so the lib paths catch a package whose name hasn't changed yet.
    const candidates = [
      `${deps.homedir}/.local/bin/Orbit.AppImage`,
      "/usr/bin/orbit-desktop",
      "/usr/local/bin/orbit-desktop",
      "/usr/lib/orbit-desktop/orbit-desktop",
      "/usr/lib/orbit/orbit-desktop",
      "/usr/bin/orbit",
      "/usr/local/bin/orbit",
      `${deps.homedir}/Applications/Orbit.AppImage`,
    ];
    for (const c of candidates) if (acceptable(c, deps)) return c;
    return null;
  }
  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA;
    if (!localAppData) return null;
    const candidates = [
      `${localAppData}\\orbit\\Orbit.exe`,
      `${localAppData}\\Programs\\orbit\\Orbit.exe`,
    ];
    for (const c of candidates) if (acceptable(c, deps)) return c;
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
  // spawn reports a failed launch (ENOENT, not executable, damaged bundle) via
  // an async 'error' event, not a throw -- and on an unref'd child with no
  // listener that surfaces as an unhandled error. Best-effort note to stderr;
  // by now the CLI is already tearing down, so there's nothing to recover.
  child.on("error", (err) => {
    process.stderr.write(`orbit launch failed: ${err.message}\n`);
  });
  child.unref();
  return { pid: child.pid };
}
