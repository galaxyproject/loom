#!/usr/bin/env node
/**
 * Is the default (flag-off) bundle byte for byte what it was? Builds Olit at a base ref and at the
 * working tree, both with pinned build stamps (ORBIT_BUILD_COMMIT, ORBIT_BUILD_TIME), and compares
 * every emitted .js file.
 *
 *   node scripts/compare-default-bundle.mjs [base-ref]    (default: HEAD)
 *
 * The base is checked out in a temporary git worktree that borrows this tree's node_modules, so
 * it refuses when the base's lockfiles differ from the working tree's. A base older than the
 * pinnable stamps embeds its own commit and build time; both are normalized before comparing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeEnv } from "../../shared/orbit-env.js";

const browser = fileURLToPath(new URL("..", import.meta.url));
const repo = path.resolve(browser, "..");
const base = process.argv[2] ?? "HEAD";
const STAMPS = { BUILD_COMMIT: "pinned", BUILD_TIME: "2000-01-01T00:00:00.000Z" };
const LOCKS = ["package-lock.json", "browser/package-lock.json"];

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const fail = (message) => {
  console.error(`compare-default-bundle: ${message}`);
  process.exit(1);
};

for (const lock of LOCKS) {
  const atBase = git("show", `${base}:${lock}`);
  if (atBase !== fs.readFileSync(path.join(repo, lock), "utf8")) {
    fail(`${lock} differs between ${base} and the working tree; install there and compare by hand`);
  }
}

/** Build Olit in `root` with the flag unset; return { relative path: contents } for every .js. */
function build(root) {
  // Both spellings: a base from before the rename reads only LOOM_*.
  const env = { ...process.env };
  for (const [name, value] of Object.entries(STAMPS)) writeEnv(env, name, value);
  delete env.VITE_ORBIT_BRAIN;
  const run = spawnSync("npm", ["run", "build"], {
    cwd: path.join(root, "browser"),
    env,
    encoding: "utf8",
  });
  // Thrown, not fail(): builds run inside the try below, whose finally removes the base worktree.
  if (run.status !== 0)
    throw new Error(`the build in ${root} failed:\n${run.stdout}\n${run.stderr}`);
  const out = path.join(root, "browser/olit/static");
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "pyodide") walk(file);
      } else if (entry.name.endsWith(".js")) {
        files[path.relative(out, file)] = fs.readFileSync(file);
      }
    }
  };
  walk(out);
  return files;
}

/** The stamps a base without pinnable build stamps embeds, rewritten to the pinned values. */
function normalize(files, short) {
  const ISO = /"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g;
  // Content hashes in file names follow the stamps, and the page names the worker by its hash.
  const HASHED = /-[A-Za-z0-9_-]{8}(\.js)$/;
  const renames = Object.keys(files)
    .filter((name) => HASHED.test(name))
    .map((name) => [path.basename(name), path.basename(name).replace(HASHED, "-HASH$1")]);
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => {
      let text = data
        .toString("latin1")
        .replaceAll(`"${short}"`, `"${STAMPS.BUILD_COMMIT}"`)
        .replace(ISO, `"${STAMPS.BUILD_TIME}"`);
      for (const [from, to] of renames) text = text.replaceAll(from, to);
      return [name.replace(HASHED, "-HASH$1"), Buffer.from(text, "latin1")];
    }),
  );
}

/**
 * The browser workspace's node_modules for the base tree: every package borrowed from this tree,
 * except the workspace links (@galaxyproject/olit, orbit-browser, orbit-browser-bare), which must
 * resolve to the base's own sources or the comparison builds this tree twice. .bin keeps its
 * relative links, so they land on the base's packages the same way.
 */
function borrowModules(from, to) {
  fs.mkdirSync(to);
  for (const entry of fs.readdirSync(from)) {
    const source = path.join(from, entry);
    if (entry === ".bin" || entry === "@galaxyproject") {
      fs.mkdirSync(path.join(to, entry));
      for (const inner of fs.readdirSync(source)) {
        const link = path.join(source, inner);
        const relative = fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null;
        fs.symlinkSync(
          relative && !path.isAbsolute(relative) ? relative : link,
          path.join(to, entry, inner),
        );
      }
    } else {
      fs.symlinkSync(source, path.join(to, entry));
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "default-bundle-"));
const baseTree = path.join(tmp, "base");
git("worktree", "add", "--detach", baseTree, base);
try {
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(baseTree, "node_modules"), "dir");
  borrowModules(
    path.join(repo, "browser/node_modules"),
    path.join(baseTree, "browser/node_modules"),
  );
  // The core's build-time assets (Pyodide wheels, the skills corpus) are untracked; borrow them.
  for (const assets of ["browser/core/temp"]) {
    if (fs.existsSync(path.join(repo, assets))) {
      fs.symlinkSync(path.join(repo, assets), path.join(baseTree, assets), "dir");
    }
  }
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: baseTree,
    encoding: "utf8",
  }).trim();
  const before = normalize(build(baseTree), short);
  const after = normalize(build(repo), short);
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const differ = names.filter((n) => !before[n] || !after[n] || !before[n].equals(after[n]));
  for (const name of names) {
    const mark = differ.includes(name) ? "DIFFERS" : "same";
    console.log(
      `${mark.padEnd(8)} ${name} (${before[name]?.length ?? "-"} -> ${after[name]?.length ?? "-"})`,
    );
  }
  // Not fail(): exiting here would skip the finally, leaving the base worktree registered.
  if (differ.length) {
    console.error(`compare-default-bundle: ${differ.length} file(s) differ from ${base}`);
    process.exitCode = 1;
  } else {
    console.log(`default bundle byte-identical to ${base}`);
  }
} finally {
  git("worktree", "remove", "--force", baseTree);
  fs.rmSync(tmp, { recursive: true, force: true });
}
