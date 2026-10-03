#!/usr/bin/env node
// Regenerates extensions/loom/observation-allowlists.ts from pinned releases of
// Galaxy and galaxy-mcp. The observation collector admits a structured field
// only when it is on one of these lists, because a shape check lets any
// identifier-shaped word through -- a patient code is as datatype-shaped as
// `fastqsanger`.
//
// It reads both repos through `git show <ref>:<path>`, so it needs local clones
// that have the tags, and it never touches their working trees:
//
//   node scripts/gen-observation-allowlists.mjs \
//     --galaxy ../galaxy --galaxy-ref v26.1.1 \
//     --galaxy-mcp ../galaxy-mcp --galaxy-mcp-ref v1.10.0
//
// Bump the refs when Loom's Galaxy floor or galaxy-mcp pin moves, rerun, and
// commit the regenerated file. A name missing from a list is dropped from the
// observation (fail closed), so a stale list loses signal, never privacy.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { textLeaks } from "../shared/observation-contract.js";

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
const mcp = arg("galaxy-mcp");
const mcpRef = arg("galaxy-mcp-ref");

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

// galaxy-mcp: every @mcp.tool-decorated function, plus the three meta-tools
// its code discovery mode exposes instead (named in server.py's own startup
// log line).
const server = show(mcp, mcpRef, "mcp-server-galaxy-py/src/galaxy_mcp/server.py");
const mcpNames = [];
let pending = false;
for (const line of server.split("\n")) {
  if (/^\s*@mcp\.tool\b/.test(line)) pending = true;
  else if (pending) {
    const m = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (m) {
      mcpNames.push(m[1]);
      pending = false;
    }
  }
}
if (!/search \/ get_schemas \/ run_galaxy_tool/.test(server)) {
  console.error("galaxy-mcp code-mode meta-tool names changed; update this script");
  process.exit(1);
}
mcpNames.push("search", "get_schemas", "run_galaxy_tool");
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
// Sources, read with \`git show\` at these exact commits:
//   galaxy-mcp ${mcpRef} (${commitOf(mcp, mcpRef)})
//     mcp-server-galaxy-py/src/galaxy_mcp/server.py
//   galaxy ${galaxyRef} (${commitOf(galaxy, galaxyRef)})
//     lib/galaxy/config/sample/datatypes_conf.xml.sample
//     tools/, lib/galaxy/tools/, lib/galaxy/datatypes/converters/ (tool ids)
//
// Regenerate when Loom's Galaxy floor or galaxy-mcp pin moves; see the script
// header for the command.

/** galaxy-mcp's tool names, with the \`galaxy_\` prefix Loom gives them. */
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
  `wrote ${OUT}: ${mcpTools.kept.length} mcp tools, ${datatypes.kept.length} datatypes, ` +
    `${builtinTools.kept.length} built-in tool ids`,
);
