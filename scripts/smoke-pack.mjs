#!/usr/bin/env node
// Tarball smoke test: npm-pack the Loom package, extract into a tmpdir,
// install runtime deps, and run `node bin/loom.js --help` to verify the
// published surface is self-contained and at least starts up.
//
// Usage: `npm run smoke:pack` (also wired as `prepublishOnly`).

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "loom-smoke-"));
let ok = false;

try {
  console.log(`[smoke] tmp dir: ${tmp}`);

  // 1. Pack into the tmp dir.
  console.log(`[smoke] npm pack`);
  const packOutput = execSync(`npm pack --pack-destination ${JSON.stringify(tmp)}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  // npm pack prints the tarball filename on its last line.
  const tarball = packOutput.split("\n").pop().trim();
  const tarballPath = join(tmp, tarball);
  console.log(`[smoke] tarball: ${tarballPath}`);

  // 2. Extract.
  const extractDir = join(tmp, "extracted");
  execSync(`mkdir -p ${JSON.stringify(extractDir)}`);
  execSync(`tar -xzf ${JSON.stringify(tarballPath)} -C ${JSON.stringify(extractDir)}`);
  const pkgDir = join(extractDir, "package");
  console.log(`[smoke] extracted to ${pkgDir}`);

  // 3. Install runtime deps -- mirrors what `npm install -g` would do.
  console.log(`[smoke] npm install (runtime deps only) -- this takes ~30s`);
  execSync("npm install --omit=dev --omit=optional --no-audit --no-fund", {
    cwd: pkgDir,
    stdio: "inherit",
  });

  // 4. Run loom --help.
  console.log(`[smoke] node bin/loom.js --help`);
  const out = execFileSync("node", ["bin/loom.js", "--help"], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if (!out || out.trim().length < 20) {
    throw new Error(`empty/short output from --help: ${JSON.stringify(out)}`);
  }
  console.log(`[smoke] --help output: ${out.split("\n").length} lines`);

  ok = true;
  console.log(`[smoke] OK`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
