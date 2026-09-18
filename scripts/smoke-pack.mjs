#!/usr/bin/env node
// Tarball smoke test: npm-pack the Loom package, extract into a tmpdir,
// install runtime deps, and run `node bin/loom.js --help` to verify the
// published surface is self-contained and at least starts up.
//
// Usage: `npm run smoke:pack` (also wired as `prepublishOnly`).

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // 3. The vendored skill content has to be IN the tarball, not merely in the
  // working tree. It reaches the package through `files: ["extensions/", ...]`,
  // so a change to that list, or to where the sync writes, drops it silently:
  // every check that reads the repo still passes and the published CLI has no
  // catalog and no reference material behind its own hints.
  const VENDOR = "extensions/loom/vendor/skills";
  // Checked before they are read, or excluding the vendor tree from `files`
  // fails with a raw ENOENT instead of the message written for exactly that.
  const generated = [`${VENDOR}/_manifest.json`, `${VENDOR}/_catalog.json`].filter(
    (rel) => !existsSync(join(pkgDir, rel)),
  );
  if (generated.length > 0) {
    throw new Error(`tarball is missing vendored files:\n  ${generated.join("\n  ")}`);
  }
  const manifest = JSON.parse(readFileSync(join(pkgDir, VENDOR, "_manifest.json"), "utf8"));
  // Matched by suffix rather than imported, because this script runs under plain
  // node and the constants are TypeScript. So the count is asserted too: a
  // rename upstream would otherwise make the filter empty and the check vacuous.
  const hintTargets = manifest.files
    .filter((f) => f.target.endsWith("failure-reference.md"))
    .map((f) => `${VENDOR}/${f.target}`);
  if (hintTargets.length < 2) {
    throw new Error(
      `expected at least the two invocation-failure hint targets, found ${hintTargets.length}`,
    );
  }
  const required = [
    `${VENDOR}/_manifest.json`,
    `${VENDOR}/_catalog.json`,
    "shared/skills-pin.js",
    "shared/skills-pin.d.ts",
    ...hintTargets,
  ];
  const routerSkills = Object.entries(
    JSON.parse(readFileSync(join(pkgDir, VENDOR, "_catalog.json"), "utf8")),
  )
    .filter(([key]) => !key.startsWith("$"))
    .flatMap(([, entries]) => entries.map((e) => `${VENDOR}/${e.path}`));
  if (routerSkills.length === 0) throw new Error("packed _catalog.json lists no skills");
  const missing = [...required, ...routerSkills].filter((rel) => !existsSync(join(pkgDir, rel)));
  if (missing.length > 0) {
    throw new Error(`tarball is missing vendored files:\n  ${missing.join("\n  ")}`);
  }
  console.log(
    `[smoke] vendored surface present: ${required.length} fixed + ${routerSkills.length} router skills`,
  );

  // 4. Install runtime deps -- mirrors what `npm install -g` would do.
  console.log(`[smoke] npm install (runtime deps only) -- this takes ~30s`);
  const pkgJsonPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  delete pkg.devDependencies;
  if (pkg.scripts) delete pkg.scripts.prepare;
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  execSync("npm install --omit=dev --omit=optional --no-audit --no-fund --ignore-scripts", {
    cwd: pkgDir,
    stdio: "inherit",
  });

  // 5. Run loom --help.
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
} catch (err) {
  // The `finally` below exits the process, which means an uncaught throw here
  // would be swallowed and the run would fail with no reason printed at all.
  console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
