#!/usr/bin/env node
/**
 * `npm run preflight:orbit`: can Orbit's brain build and load in the agent worker at all?
 *
 * Builds core/src/agent/orbit/preflight.html through the production config, checks the worker
 * bundle for Node-only packages that got past the
 * aliases, prints its size, then runs it in a realm with only browser-worker globals
 * (orbit-worker-realm.mjs). The worker boots extensions/orbit on pi-host and writes and re-reads a
 * registry attempt, and posts { ok, mode, tools }. Exits non-zero on any failure.
 *
 * e2e/orbit-preflight-drive.cjs loads the same page in a real browser, built and dev.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const browser = fileURLToPath(new URL("..", import.meta.url));
const out = process.env.PREFLIGHT_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preflight-"));

/** Packages that may appear only as their stubs' names, `unavailable("<name>")`. */
const FORBIDDEN = [
  "@earendil-works/pi-tui",
  "@earendil-works/pi-coding-agent",
  "better-sqlite3",
  "chokidar",
  "@anthropic-ai/sandbox-runtime",
  "tus-js-client",
];

const fail = (message) => {
  console.error(`preflight:orbit: ${message}`);
  process.exit(1);
};

const built = spawnSync(
  "npx",
  [
    "vite",
    "build",
    "--config",
    "core/src/agent/orbit/preflight.vite.ts",
    "--configLoader",
    "runner",
    "--logLevel",
    "warn",
  ],
  {
    cwd: browser,
    env: { ...process.env, PREFLIGHT_OUT: out },
    stdio: "inherit",
  },
);
if (built.status !== 0) fail("the build failed");

const assets = path.join(out, "assets");
const workers = fs.readdirSync(assets).filter((f) => /^preflight\.worker-.*\.js$/.test(f));
if (workers.length !== 1) fail(`expected one worker bundle in ${assets}, found ${workers.length}`);
const workerFile = path.join(assets, workers[0]);
const code = fs.readFileSync(workerFile, "utf8");

const count = (re) => (code.match(re) ?? []).length;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const leaks = FORBIDDEN.flatMap((name) => {
  const bare = name.replace(/^@[^/]+\//, "");
  const all = count(new RegExp(escape(bare), "g"));
  const stubs = count(new RegExp(`\\("${escape(name)}"\\)`, "g"));
  return all > stubs ? [`${name}: ${all - stubs} reference(s) beyond its stub`] : [];
});
if (leaks.length) fail(`Node-only packages in the worker bundle:\n  ${leaks.join("\n  ")}`);
if (code.includes("__vite-browser-external")) fail("a Node builtin was externalized");

console.log(`worker bundle: ${workers[0]}, ${(code.length / 1024 / 1024).toFixed(2)} MB`);

const realm = spawnSync(
  process.execPath,
  [
    "--experimental-vm-modules",
    "--no-warnings",
    path.join(browser, "scripts/orbit-worker-realm.mjs"),
    workerFile,
  ],
  { encoding: "utf8" },
);
const answer = realm.stdout.trim();
console.log(`worker realm: ${answer}`);
if (realm.status !== 0) fail(realm.stderr || "the worker did not report ok");
const { mode } = JSON.parse(answer);
if (mode !== "writer") fail(`the registry opened ${mode}, not writer`);
console.log(`preflight:orbit ok (built into ${out})`);
