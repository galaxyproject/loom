/**
 * Report where olit's pinned upstreams sit relative to their sources.
 *
 * Reports, never updates: the pins are the contract, and a corpus that followed `main`
 * would change agent behaviour without a commit saying so. Exits 0 even when behind, so
 * this can run in CI as information rather than as a gate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

/** The version spec `package.json` pins `name` to, wherever it declares it. */
export function pinned(pkg, name) {
  const spec = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
  if (!spec) throw new Error(`package.json pins no ${name}`);
  return spec;
}

/** Every package.json that declares each pin this script reports on. */
export const PINS = {
  "galaxy-charts": ["olit/package.json"],
};

/** The one spec every declaring package pins `name` to; packages that disagree are an error. */
export function pinFor(name) {
  const specs = PINS[name].map((path) => pinned(read(path), name));
  if (new Set(specs).size > 1)
    throw new Error(`${PINS[name].join(" and ")} pin ${name} differently`);
  return specs[0];
}

async function github(path) {
  const headers = { "User-Agent": "olit-stale-check", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
  if (!res.ok) throw new Error(`npm ${res.status} for ${pkg}`);
  return (await res.json()).version;
}

async function galaxyCharts() {
  const version = pinFor("galaxy-charts").replace(/^[\^~]/, "");
  const latest = await npmLatest("galaxy-charts");
  return version === latest
    ? `charts     up to date at ${version}`
    : `charts     BEHIND: package.json wants ${version}, npm has ${latest}\n` +
        `           update: bump it and run npm test; visualizations.ts imports its input contract directly`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = await Promise.allSettled([galaxyCharts()]);
  for (const r of results) {
    console.log(r.status === "fulfilled" ? r.value : `(could not check: ${r.reason.message})`);
  }
}
