#!/usr/bin/env node
// Regenerates extensions/loom/observation-allowlists.ts from the installed
// @galaxyproject/galaxy-ops and a pinned Galaxy release. The observation
// collector admits a structured field only when it is on one of these lists,
// because a shape check lets any identifier-shaped word through -- a patient
// code is as datatype-shaped as `fastqsanger`.
//
// Galaxy tool names come from galaxy-ops' allOperations plus the few names in
// scripts/galaxy-allowlist-extra-names.mjs. Datatypes and built-in tool ids are
// read from Galaxy through `git show <ref>:<path>`, so that needs a local clone
// that has the tag, and it never touches the clone's working tree:
//
//   node scripts/gen-observation-allowlists.mjs \
//     --galaxy ../galaxy --galaxy-ref v26.1.1
//
// Rerun when galaxy-ops is bumped or Loom's Galaxy floor moves, and commit the
// regenerated file. A name missing from a list is dropped from the observation
// (fail closed), so a stale list loses signal, never privacy.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { textLeaks } from "../shared/observation-contract.js";
import { GALAXY_ALLOWLIST_EXTRA_NAMES } from "./galaxy-allowlist-extra-names.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "extensions", "loom", "observation-allowlists.ts");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const galaxy = arg("galaxy");
const galaxyRef = arg("galaxy-ref");

const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
const show = (repo, ref, path) => git(repo, "show", `${ref}:${path}`);
const commitOf = (repo, ref) => git(repo, "rev-parse", `${ref}^{commit}`).trim();
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

// Anything that would itself trip the collector's leak scan is left off: the
// scan runs over every string in the payload, so such an entry could never be
// sent anyway, and listing it would only hide that.
function partition(values) {
  const kept = [];
  const refused = [];
  for (const v of [...new Set(values)].sort()) {
    (textLeaks(v).length === 0 ? kept : refused).push(v);
  }
  return { kept, refused };
}

// galaxy-ops: every operation. A plain Node import resolves the Node entry, so
// this includes the operations the browser entry leaves out. The version is read
// from the package the import resolved, not whichever copy a bare require finds.
const opsEntry = fileURLToPath(import.meta.resolve("@galaxyproject/galaxy-ops"));
const opsVersion = createRequire(opsEntry)("../package.json").version;
const mcpNames = [...allOperations.map((op) => op.name), ...GALAXY_ALLOWLIST_EXTRA_NAMES];
// Wire spelling, not runtime spelling. pi calls these mcp__galaxy__<name>; the
// collector maps that to galaxy_<name> (observationToolName in observations.ts)
// before it checks this list, because the observation contract and the intake
// that validates it fixed galaxy_<name> before pi's built-in MCP took over.
const mcpTools = partition(mcpNames.map((n) => `galaxy_${n}`));

// Galaxy datatypes: every active <datatype extension="..."> in the sample
// registry, which is what a stock server knows, plus the compressed variants
// Galaxy derives from auto_compressed_types (fastqsanger -> fastqsanger.gz).
const registry = stripComments(
  show(galaxy, galaxyRef, "lib/galaxy/config/sample/datatypes_conf.xml.sample"),
);
const datatypeNames = [];
for (const [tag] of registry.matchAll(/<datatype\b[^>]*>/g)) {
  const ext = tag.match(/\bextension="([^"]+)"/)?.[1];
  if (!ext) continue;
  datatypeNames.push(ext);
  const compressed = tag.match(/\bauto_compressed_types="([^"]+)"/)?.[1] ?? "";
  for (const c of compressed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)) {
    datatypeNames.push(`${ext}.${c}`);
  }
}
const datatypes = partition(datatypeNames);

// Bare (non-toolshed) tool ids that ship inside Galaxy itself: the stock tools,
// the collection operations and the datatype converters. Only word-character
// ids; anything else could not be told apart from a path or a host anyway.
const toolFiles = git(
  galaxy,
  "ls-tree",
  "-r",
  "--name-only",
  galaxyRef,
  "tools",
  "lib/galaxy/tools",
  "lib/galaxy/datatypes/converters",
)
  .split("\n")
  .filter((p) => p.endsWith(".xml"));
const toolIds = [];
for (const file of toolFiles) {
  const m = stripComments(show(galaxy, galaxyRef, file)).match(/<tool\b[^>]*?\bid="([^"]+)"/);
  if (m && /^\w+$/.test(m[1])) toolIds.push(m[1]);
}
const builtinTools = partition(toolIds);

for (const [name, { refused }] of Object.entries({ mcpTools, datatypes, builtinTools })) {
  if (refused.length)
    console.error(`${name}: left off (trips the leak scan): ${refused.join(", ")}`);
}

const list = (values) => values.map((v) => `  ${JSON.stringify(v)},`).join("\n");
const out = `// GENERATED by scripts/gen-observation-allowlists.mjs -- do not edit by hand.
//
// Sources:
//   @galaxyproject/galaxy-ops ${opsVersion}, allOperations (Node entry)
//   extra names, scripts/galaxy-allowlist-extra-names.mjs:
//     ${GALAXY_ALLOWLIST_EXTRA_NAMES.join(", ")}
//   galaxy ${galaxyRef} (${commitOf(galaxy, galaxyRef)}), read with \`git show\`:
//     lib/galaxy/config/sample/datatypes_conf.xml.sample
//     tools/, lib/galaxy/tools/, lib/galaxy/datatypes/converters/ (tool ids)
//
// Regenerate when galaxy-ops is bumped or Loom's Galaxy floor moves; see the
// script header for the command.

/**
 * Galaxy tool names in the observation wire spelling, \`galaxy_<name>\`.
 * pi calls them \`mcp__galaxy__<name>\`; the collector normalises to this
 * spelling before it checks the list, so a pi spelling is never on it.
 */
export const GALAXY_MCP_TOOLS: ReadonlySet<string> = new Set([
${list(mcpTools.kept)}
]);

/** Datatype extensions a stock Galaxy server registers. */
export const GALAXY_DATATYPES: ReadonlySet<string> = new Set([
${list(datatypes.kept)}
]);

/** Bare tool ids that ship inside Galaxy (not from a toolshed). */
export const GALAXY_BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set([
${list(builtinTools.kept)}
]);
`;
writeFileSync(OUT, out);
console.log(
  `wrote ${OUT}: ${mcpTools.kept.length} Galaxy tools, ${datatypes.kept.length} datatypes, ` +
    `${builtinTools.kept.length} built-in tool ids`,
);
