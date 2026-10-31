/**
 * Build what the image runs, into dist/: the host (host.mjs), the worker (worker.mjs loading the
 * minified, ASCII-only orbit-worker.mjs) and the page (web/).
 *
 *   cd browser/hosted && node --import tsx scripts/build.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { bundleWorkerForProduction } from "../src/worker/bundle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
mkdirSync(DIST, { recursive: true });

await bundleWorkerForProduction(join(ROOT, "src", "worker", "boot.ts"), join(DIST, "orbit-worker.mjs"));
copyFileSync(join(ROOT, "scripts", "worker-loader.mjs"), join(DIST, "worker.mjs"));

await build({
  entryPoints: [join(ROOT, "src", "server", "main.ts")],
  outfile: join(DIST, "host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  // pg loads its optional native binding only when asked to; nothing here asks.
  external: ["pg-native"],
  banner: {
    js: ['import { createRequire as __hostRequire } from "node:module";', "const require = __hostRequire(import.meta.url);"].join(
      "\n",
    ),
  },
});

execFileSync("npx", ["vite", "build", "--configLoader", "runner", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
console.log(`built ${DIST}`);
