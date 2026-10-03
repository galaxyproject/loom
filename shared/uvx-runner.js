// Pre-flight helper: is `uvx` resolvable on PATH? Galaxy MCP launches via
// `uvx galaxy-mcp>=1.9.0` (see extensions/loom/mcp-servers.ts), so when Galaxy
// credentials are configured but uv isn't installed, pi fails to start that one
// server with a spawn error buried in the logs and Galaxy tools silently
// vanish. We detect the gap up front and print an actionable notice. Orbit
// bundles uv and prepends it to the brain's PATH before spawn, so the check
// naturally passes there -- but only when packaged: a source run gets the
// system PATH, which is why developers see a failure users of an installer
// never hit. Pure helpers (resolveExecutable, uvxMissingNotice) are
// unit-tested; isUvxAvailable is a thin fs wrapper.
//
// Lives in shared/ because both sides need it: the CLI prints the notice at
// startup, and the brain (extensions/loom) turns a launcher spawn failure into
// the same guidance mid-session. bin/uvx-check.js re-exports for the CLI.

import fs from "node:fs";
import path from "node:path";

/** Real executable check: a regular file we're allowed to execute. On Windows
 * the X_OK bit is meaningless, so presence + PATHEXT match is enough.
 * @param {string} p @returns {boolean} */
function defaultIsExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror how `child_process.spawn` resolves a bare command: walk PATH entries
 * and return the first executable named `cmd` (trying PATHEXT suffixes on
 * Windows). Pure given injected `pathEnv` / `platform` / `isExecutable`.
 * @param {string} cmd
 * @param {{ pathEnv?: string, platform?: NodeJS.Platform, pathExt?: string, isExecutable?: (p: string) => boolean }} [opts]
 * @returns {string | null}
 */
export function resolveExecutable(cmd, opts = {}) {
  const {
    pathEnv = process.env.PATH || "",
    platform = process.platform,
    pathExt = process.env.PATHEXT,
    isExecutable = defaultIsExecutable,
  } = opts;
  if (!pathEnv) return null;
  const isWin = platform === "win32";
  // Join with the injected platform's separator, not the host OS's. Bare
  // path.join uses native separators, so a win32 PATH probed on a posix host
  // (or vice versa) yielded mismatched slashes -- which broke this on Windows CI.
  const pathMod = isWin ? path.win32 : path.posix;
  const sep = isWin ? ";" : ":";
  const exts = isWin ? (pathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue; // empty segment must not resolve to the cwd
    for (const ext of exts) {
      const candidate = pathMod.join(dir, cmd + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** @returns {boolean} whether `uvx` is resolvable on the current PATH. */
export function isUvxAvailable() {
  return resolveExecutable("uvx") !== null;
}

/** Actionable notice shown when Galaxy creds are set but `uvx` is missing. Pure.
 * @returns {string} */
export function uvxMissingNotice() {
  return `loom: Galaxy is configured, but \`uvx\` was not found on your PATH.
Galaxy tools run through \`uvx galaxy-mcp\` (a Python MCP server), so they
won't be available until you install uv:

  * Install script:  curl -LsSf https://astral.sh/uv/install.sh | sh
  * Homebrew:        brew install uv

See https://docs.astral.sh/uv/ for details. Loom will keep running without
Galaxy tools -- web search, BRC Analytics, and local execution still work.`;
}
