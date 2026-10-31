#!/usr/bin/env node
/**
 * What the core needs on disk before a flavor builds against it: the Pyodide wheels the agent
 * loads. A flavor's build runs this first, so a fresh checkout of the flavor builds without a step
 * only the workspace root knows about. (The skills the agent offers are Orbit's vendored tree.)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run, not imported: the script's top-level main runs as its own process.
for (const script of ["install_pyodide.js"]) {
  const { status } = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: "inherit",
  });
  if (status !== 0) process.exit(status ?? 1);
}
