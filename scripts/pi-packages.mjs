// Where the pi packages live, what they currently resolve to, and how to bump
// them. Consumed by .github/workflows/pi-update.yml.
//
// Everything here is derived from the manifests rather than written down. The
// workflow used to hardcode three package names and which section each lived
// in, which set two traps: a fourth pi package would be bumped by nothing and
// then flagged as split by check-version-lockstep, and moving pi-ai from
// devDependencies to dependencies would be silently undone on the next run.
// Both traps are in a YAML file nobody thinks to grep.
//
// Versions come from the LOCKFILES, not the manifest ranges. "^0.84.1" is a
// floor, not what is installed, so a range floor cannot answer either question
// the workflow asks -- what are we on, and are the two trees on the same thing.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const SCOPE = "@earendil-works/";
const NM = "node_modules/";

// The two trees that install separately. app/ is not a workspace, so it keeps
// its own lockfile and can drift from the root independently.
export const TREES = [
  { tree: "root", dir: "." },
  { tree: "app", dir: "app" },
];

/** Direct pi dependencies of one manifest, paired with the section they live in. */
export function piDependencies(manifest) {
  const out = [];
  for (const section of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest?.[section] ?? {})) {
      if (name.startsWith(SCOPE)) out.push({ name, section });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a lockfile resolved a top-level package to, or null if it is absent. */
export function resolvedVersion(lock, name) {
  return lock?.packages?.[NM + name]?.version ?? null;
}

/**
 * Every distinct version the pi direct dependencies resolve to, across all
 * trees. One entry means the trees agree; more than one is the split state
 * check-version-lockstep.mjs fails on, and the workflow must treat it as work
 * to do rather than reporting "nothing to do".
 */
export function distinctVersions(trees) {
  const seen = new Set();
  for (const { packages } of trees) {
    for (const { version } of packages) if (version) seen.add(version);
  }
  return [...seen].sort();
}

/**
 * One npm invocation per (tree, section): the fewest resolves that still let
 * npm see every requested version at once.
 *
 * Named packages on the command line matter beyond brevity. npm treats an
 * explicitly requested package as an override and downgrades a conflicting
 * peer to a warning, whereas re-resolving a manifest edited in place turns the
 * same conflict into a fatal ERESOLVE. A pi extension with a caret peer range on
 * pi-ai would abort a manifest-edit bump on the first pi minor that leaves that
 * range, before it ever produced a branch to look at.
 */
export function installPlan(trees, version) {
  const plan = [];
  for (const { dir, packages } of trees) {
    for (const section of ["dependencies", "devDependencies"]) {
      const specs = packages
        .filter((p) => p.section === section)
        .map((p) => `${p.name}@${version}`);
      if (specs.length === 0) continue;
      plan.push({ dir, flag: section === "dependencies" ? "--save" : "--save-dev", specs });
    }
  }
  return plan;
}

function readTrees(root) {
  return TREES.map(({ tree, dir }) => {
    const base = dir === "." ? root : join(root, dir);
    const manifest = JSON.parse(readFileSync(join(base, "package.json"), "utf-8"));
    const lock = JSON.parse(readFileSync(join(base, "package-lock.json"), "utf-8"));
    const packages = piDependencies(manifest).map((p) => ({
      ...p,
      version: resolvedVersion(lock, p.name),
    }));
    return { tree, dir, packages };
  });
}

function main(argv) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const trees = readTrees(root);
  const [mode, arg] = argv;

  if (mode === "--versions") {
    console.log(distinctVersions(trees).join(","));
    return;
  }
  if (mode === "--install-plan") {
    if (!arg) throw new Error("--install-plan needs a version");
    // Tab-separated so the workflow can read it with a plain `while read`.
    for (const { dir, flag, specs } of installPlan(trees, arg)) {
      console.log([dir, flag, specs.join(" ")].join("\t"));
    }
    return;
  }
  // No mode: a human-readable dump, handy from a workflow log.
  for (const { tree, packages } of trees) {
    for (const { name, section, version } of packages) {
      console.log(`${tree}\t${section}\t${name}\t${version ?? "(unresolved)"}`);
    }
  }
}

// Realpath both sides: Node realpath-resolves the ESM entry but only
// path-resolves argv[1], so a raw comparison makes this a silent no-op behind
// any symlink.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2));
}
