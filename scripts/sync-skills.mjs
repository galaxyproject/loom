#!/usr/bin/env node
/**
 * Vendor skill content into `extensions/loom/vendor/skills/`.
 *
 * The source is `galaxyproject/agentic-plugins`, which mirrors galaxy-skills
 * and the Foundry casts at pins of its own and is what distributes the same
 * content to every other harness. Loom is a downstream client of it: pin one
 * commit, copy a chosen subset, record hashes, and gate drift in CI. The copy
 * ships inside the package, so the guidance is available offline, at a version
 * that went through review, with no runtime dependency on GitHub.
 *
 * The pin is a commit, not a tag. Tags move; a commit is the only thing that
 * makes "what did we ship" answerable later. `tag` in the manifest is a label.
 *
 *   npm run sync:skills      # fetch at the pinned commit, transform, write
 *   npm run check:skills     # verify the vendored tree matches _manifest.json
 *
 * `LOOM_AGENTIC_PLUGINS_DIR=/path/to/agentic-plugins` reads a local checkout
 * instead of fetching, for iterating on both repos at once. It does not check
 * that the checkout is at the pinned commit, so never commit the result of one.
 *
 * Transforms are declared per plugin and applied to markdown on the way in, so
 * the vendored copy is deliberately not byte-identical to upstream and `--check`
 * compares recorded hashes rather than re-fetching. They are exported as pure
 * functions because of what the CI gate cannot see. It catches an accidental
 * edit, a stale sync and a moved pin -- not a transform that mangles content,
 * which re-syncs, writes a fresh hash and passes, and not a deliberate edit
 * that updates `_manifest.json` in the same diff.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "skills.manifest.json");
const VENDOR_DIR = path.join(REPO_ROOT, "extensions", "loom", "vendor", "skills");
const VENDOR_MANIFEST_NAME = "_manifest.json";
const VENDOR_MANIFEST = path.join(VENDOR_DIR, VENDOR_MANIFEST_NAME);
const VENDOR_CATALOG_NAME = "_catalog.json";
const VENDOR_CATALOG = path.join(VENDOR_DIR, VENDOR_CATALOG_NAME);
// The shells cannot read the vendor tree, and the Preferences table has to be
// able to say which commit a bundled repo is pinned at, so the pin is also
// written as a shared contract module.
const PIN_MODULE = path.join(REPO_ROOT, "shared", "skills-pin.js");
const PIN_TYPES = path.join(REPO_ROOT, "shared", "skills-pin.d.ts");
const GENERATED = new Set([VENDOR_MANIFEST_NAME, VENDOR_CATALOG_NAME]);

/** The product-surface id Loom claims. A skill opts in with `metadata.surfaces: [loom]`. */
const SURFACE_ID = "loom";

// agentic-plugins follows the plugin layout every harness reads: skill content
// for a plugin lives under `plugins/<name>/skills/`. Include and exclude
// patterns in the manifest are relative to that directory.
const PLUGIN_SKILLS_ROOT = "skills";

// Research notes in the Foundry cite source by the author's local checkout
// (`~/projects/repositories/galaxy/...`), in both frontmatter `sources:` and
// body prose. Shipped as-is an agent may try to read a path that doesn't exist
// on the user's machine; Loom's read-jail blocks it, so the turn is wasted or
// the user is pointed somewhere useless. Rewrite to the canonical GitHub
// location, and refuse to ship a repo we have no rewrite for rather than
// leaking a dead local path.
export const REPO_BLOB_BASE = {
  galaxy: "https://github.com/galaxyproject/galaxy/blob/dev/",
  // Planemo's default branch is master. Assuming main or dev here produces 404s.
  planemo: "https://github.com/galaxyproject/planemo/blob/master/",
  "galaxy-brain": "https://github.com/jmchilton/galaxy-brain/blob/main/",
  // workflow-fixtures is the note author's scratch corpus holding clones of more
  // than one project, so it is keyed on the subdirectory rather than the name.
  // The notes state this mapping themselves ("mirror of galaxyproject/iwc").
  // The sibling pipelines/nf-core__* clones have no established upstream, and a
  // name-keyed rule would silently point them at the wrong repository, so they
  // fall through to the throw.
  "workflow-fixtures/iwc-src": "https://github.com/galaxyproject/iwc/blob/main/",
};

// The notes write the checkout root three ways: `~/`, and the expanded
// `/Users/<someone>/` or `/home/<someone>/`. The expanded forms also carry the
// author's account name, which we would otherwise publish to npm and into every
// installer, so all three have to be caught.
// A username can be anything a filesystem allows, so the class is "not a slash"
// rather than a guess at what characters people use.
const CHECKOUT_ROOT = String.raw`(?:~|/(?:Users|home)/[^/\s"'\`]+)`;
const SEG = String.raw`[A-Za-z0-9._-]+`;
const LOCAL_CHECKOUT = new RegExp(
  `${CHECKOUT_ROOT}/projects/repositories/(${SEG})(/${SEG})?/`,
  "g",
);

// Anything rooted in somebody's home directory is refused, whatever the layout
// below it: a named user directory on any of the three platforms, or a bare `~/`
// that is not one of the tool caches below. Narrowing this to one checkout
// layout, which is what it used to be, meant a note citing `~/notes/private.md`
// or `/Users/alice/work/...` sailed through and shipped to npm with the author's
// account name in it.
const HOME_DIR_PATH = new RegExp(
  [
    // /Users/<name>/ and /home/<name>/, with a backslash-escaped space allowed
    // inside the name so `/Users/bob\ smith/x` does not slip through.
    String.raw`\/(?:Users|home)\/(?:[^/\s"'\`]|\\ )+\/`,
    // C:\Users\<name>\
    String.raw`[A-Za-z]:\\Users\\(?:[^\\\s"'\`]|\\ )+\\`,
    // The single-user roots, which have no name segment at all.
    String.raw`\/(?:root|var\/root)\/`,
    // ~<name>/ -- the tilde form that still carries an account name.
    String.raw`~[A-Za-z0-9._-]+\/`,
    // The Windows environment variables that expand to one.
    String.raw`%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%`,
  ].join("|"),
  "i",
);
const TILDE_PATH = /~\/([^\s"'`]*)/g;

// `~/` prefixes that name a tool's own cache or config rather than anything of
// the author's. Every one of these is cited by content we vendor today. Add to
// it deliberately; the point of the list is that a new one gets looked at.
const GENERIC_HOME_PREFIXES = [".cache/", ".config/", ".claude/", ".foundry/"];

/**
 * Whether `base + suffix`, once a URL parser has had its way with it, is still
 * under `base`. Percent-decoded first so `%2e%2e` cannot hide, and backslashes
 * read as separators the way a browser reads them.
 */
function staysUnder(base, suffix) {
  let decoded = suffix;
  for (let i = 0; i < 3; i++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) break;
    decoded = next;
  }
  try {
    return new URL(decoded.replace(/\\/g, "/"), base).href.startsWith(base);
  } catch {
    return false;
  }
}

/**
 * Rewrite a local checkout of `<repo>` to that repo's GitHub blob base. A
 * two-segment key wins over a one-segment one, because one of these checkouts
 * holds clones of several projects and only some of them have a known upstream.
 */
export function rewriteLocalPaths(text, bases = REPO_BLOB_BASE) {
  return text.replace(LOCAL_CHECKOUT, (match, repo, sub, offset, whole) => {
    // Own-property only: `bases["constructor"]` is truthy and would splice a
    // native-code stringification into shipped guidance.
    const two = sub ? `${repo}${sub}` : null;
    const base = two && Object.hasOwn(bases, two) ? bases[two] : undefined;
    const prefix = base ?? (Object.hasOwn(bases, repo) ? bases[repo] : undefined);
    if (prefix === undefined) {
      throw new Error(
        `no GitHub base for "${match}" -- add "${repo}" to REPO_BLOB_BASE ` +
          `(or "${two ?? repo}" if only that subdirectory has a known upstream), ` +
          `or the vendored copy ships a path that only exists on the author's machine`,
      );
    }
    const replacement = base ?? prefix + (sub ? `${sub.slice(1)}/` : "");

    // Only the prefix is replaced, so whatever follows rides along into the URL.
    // Checking the spelling of that suffix is a losing game -- `..` can be
    // written with backslashes or percent-encoded, and both normalize away in
    // whatever eventually resolves the link. Build the URL instead and ask
    // whether it still points inside the repository we mapped it to.
    const suffix = /^[^\s"'`)\]]*/.exec(whole.slice(offset + match.length))?.[0] ?? "";
    if (!staysUnder(replacement, suffix)) {
      throw new Error(
        `"${match}${suffix}" walks out of the repository it maps to -- ` +
          `the rewritten URL would resolve somewhere else entirely`,
      );
    }
    return replacement;
  });
}

// Obsidian wiki-links resolve inside the Foundry vault and nowhere else. Left
// intact they read as an instruction to go fetch something that isn't vendored.
// Strip to the text a reader should see: the alias when the link is piped, the
// body otherwise, anchor included because `tests-format#has_size_model` says
// where to look and `tests-format` does not.
//
// The character class is the first of two guards. A 2D array literal opens the
// same way (`[["a", "b", "c"]]`), and a note name never contains a quote,
// comma, bracket, pipe or space, so excluding those leaves every literal alone.
const LINK_SEG = String.raw`[^[\]\n|"',\s]+?`;
const WIKI_LINK = new RegExp(String.raw`\[\[(${LINK_SEG})(?:\|(${LINK_SEG}))?\]\]`, "g");
const WIKI_LINK_ANCHORED = new RegExp(String.raw`^\[\[(${LINK_SEG})(?:\|(${LINK_SEG}))?\]\]$`);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const BLOCKQUOTE_MARKER = /^ {0,3}(?:> ?)+/;
const MASK = "\0";
// A code span is delimited by backtick runs of equal length, so the opener must
// not be preceded by a backtick and the closer must not be followed by one.
// Without those bounds `` `a```b` `` closed after `a` and exposed the rest.
const INLINE_SPAN = /(?<!`)(`+)[\s\S]*?\1(?!`)/g;

/**
 * Blank out fenced blocks and inline code spans, preserving length so an offset
 * into the result indexes the original text. This is the second guard, and the
 * only one that catches a placeholder like `data: [[cell values]]`, whose body
 * is a plausible note name.
 *
 * Known gap: a four-space indented code block is not a fence and is not
 * tracked. Masking every indented line instead would swallow list
 * continuations, and no vendored file has a bracket pair in one.
 */
export function maskCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    // A fence inside a blockquote is still a fence; the markers are not content.
    const body = line.replace(BLOCKQUOTE_MARKER, "");
    const open = FENCE_OPEN.exec(body);
    if (fence === null) {
      // The opening line is masked too, not only the lines after it: its info
      // string is part of the block's syntax, not prose.
      out.push(open ? MASK.repeat(line.length) : line);
      if (open) fence = open[1];
      continue;
    }
    out.push(MASK.repeat(line.length));
    const close = FENCE_CLOSE.exec(body);
    // CommonMark closes a fence only with the same character, at least as long.
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
  }
  // Inline spans are masked over the whole text, after fences: a span can run
  // across lines, and a backtick inside a fence is already gone so it cannot
  // pair with one outside.
  return out.join("\n").replace(INLINE_SPAN, (m) => MASK.repeat(m.length));
}

export function stripWikiLinks(text) {
  const masked = maskCode(text);
  let out = "";
  let last = 0;
  let m;
  WIKI_LINK.lastIndex = 0;
  while ((m = WIKI_LINK.exec(masked)) !== null) {
    // Re-read the original bytes at this offset. Taking the capture from the
    // masked copy would carry mask characters into the output for a link that
    // happens to sit beside a code span.
    const original = text.slice(m.index, m.index + m[0].length);
    const parsed = WIKI_LINK_ANCHORED.exec(original);
    out += text.slice(last, m.index) + (parsed ? (parsed[2] ?? parsed[1]).trim() : original);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/**
 * Transforms are named in the manifest per plugin, not applied globally. The
 * wiki-link strip and the path rewrite are corrections for how the Foundry
 * authors its notes; running them over content that never had the problem is
 * how a sync quietly corrupts something.
 */
export const TRANSFORMS = {
  "rewrite-local-paths": (text) => rewriteLocalPaths(text),
  "strip-wiki-links": (text) => stripWikiLinks(text),
};

export function applyTransforms(text, targetName, names = []) {
  const lower = targetName.toLowerCase();
  const out = lower.endsWith(".md")
    ? names.reduce((acc, name) => {
        const fn = TRANSFORMS[name];
        if (!fn) throw new Error(`unknown transform "${name}"`);
        return fn(acc);
      }, text)
    : lower.endsWith(".json")
      ? applyJsonTransforms(text, names)
      : text;
  // The rewrite itself is markdown-only, but the leak check is an assertion and
  // costs nothing, so every vendored file gets it. A local checkout path in a
  // sidecar would otherwise ship, with its author's account name, to npm and
  // into every installer.
  assertNoLocalCheckout(out, targetName);
  return out;
}

// A cast's `references/cli/*.json` carries a whole markdown document in its
// `body`, and its SKILL.md tells the agent to read the file. That prose has the
// same wiki-links as any note, so it gets the same treatment -- but only that
// field. Everywhere else in these JSON files a `[[name]]` is a machine-readable
// identifier (`"ref": "[[galaxy-collection-semantics]]"`), and stripping the
// brackets would change an id rather than tidy a sentence.
const JSON_PROSE_FIELD = "body";

export function applyJsonTransforms(text, names = []) {
  if (!names.includes("strip-wiki-links")) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed[JSON_PROSE_FIELD] !== "string") {
    // Only a top-level `body` is rewritten, so a nested one would ship with its
    // links intact and nothing would say so. Refuse rather than miss it.
    const nested = findNestedProse(parsed);
    if (nested) {
      throw new Error(
        `a nested "${JSON_PROSE_FIELD}" at ${nested} carries wiki-links; ` +
          `the rewrite only handles a top-level one`,
      );
    }
    return text;
  }
  const original = parsed[JSON_PROSE_FIELD];
  const stripped = stripWikiLinks(original);
  if (stripped === original) return text;
  // Splice the field's own span rather than searching the file for its value.
  // Searching replaced the first literal that decoded the same way, so
  // `{"ref":"[[x]]","body":"[[x]]"}` rewrote `ref` and left `body` alone, and a
  // body written with unicode escapes matched nothing at all.
  const spans = findJsonStringSpans(text, JSON_PROSE_FIELD, original);
  if (spans.length !== 1) {
    throw new Error(
      `expected exactly one "${JSON_PROSE_FIELD}" string to rewrite, found ${spans.length}`,
    );
  }
  const [start, end] = spans[0];
  return text.slice(0, start) + JSON.stringify(stripped) + text.slice(end);
}

/** Path to the first nested prose field holding a wiki-link, or null. */
function findNestedProse(value, trail = "$") {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = findNestedProse(item, `${trail}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === JSON_PROSE_FIELD && typeof item === "string" && WIKI_LINK.test(item)) {
      WIKI_LINK.lastIndex = 0;
      return `${trail}.${key}`;
    }
    WIKI_LINK.lastIndex = 0;
    const hit = findNestedProse(item, `${trail}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/** End offset (exclusive) of the JSON string literal that opens at `start`. */
function endOfJsonString(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** Offsets of every `"<key>": "<literal>"` whose literal decodes to `expected`. */
export function findJsonStringSpans(text, key, expected) {
  const keyLiteral = JSON.stringify(key);
  const spans = [];
  for (let i = text.indexOf(keyLiteral); i !== -1; i = text.indexOf(keyLiteral, i + 1)) {
    let j = i + keyLiteral.length;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ":") continue;
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '"') continue;
    const end = endOfJsonString(text, j);
    if (end === -1) continue;
    try {
      if (JSON.parse(text.slice(j, end)) === expected) spans.push([j, end]);
    } catch {
      // Not a literal we can reason about; leave it alone.
    }
  }
  return spans;
}

function toSurfaces(v) {
  if (typeof v === "string") return [v.trim()].filter(Boolean);
  if (Array.isArray(v)) {
    return v
      .filter((x) => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * A port of the runtime's `parseFrontmatter`. The sync runs under plain node and
 * cannot import the TypeScript one, so the two are kept honest by a test that
 * runs both over the same inputs, including every vendored SKILL.md.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  let data;
  try {
    data = parseYaml(m[1]);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const fm = {};
  if (typeof data.name === "string") fm.name = data.name;
  if (typeof data.description === "string") fm.description = data.description;
  if (typeof data.when_to_use === "string") fm.when_to_use = data.when_to_use.trim();
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : undefined;
  fm.surfaces = toSurfaces(metadata?.surfaces);
  return fm;
}

/**
 * The router's view of a plugin: one entry per SKILL.md, at the path a fetch
 * would use. Built at sync time so a first run has a catalog without reaching
 * GitHub, and so the descriptions in the system prompt are the ones we shipped
 * rather than whatever upstream looks like today.
 *
 * Refuses a plugin with nothing tagged for this surface: `selectSkills` is
 * tag-or-all, so an untagged mirror would quietly put every skill it holds into
 * the cached system prompt.
 */
export function buildCatalogEntries(plugin, files, readText) {
  const entries = [];
  for (const file of files) {
    if (file.target !== "SKILL.md" && !file.target.endsWith("/SKILL.md")) continue;
    const fm = parseFrontmatter(readText(file));
    if (!fm.name || !fm.description) {
      throw new Error(`${file.target}: SKILL.md has no name or description in its frontmatter`);
    }
    const entry = {
      path: file.target,
      name: fm.name,
      description: fm.description,
      surfaces: fm.surfaces ?? [],
    };
    if (fm.when_to_use) entry.when_to_use = fm.when_to_use;
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error(`plugin "${plugin.plugin}" is in the router but vendors no SKILL.md`);
  }
  if (!entries.some((e) => e.surfaces.includes(SURFACE_ID))) {
    throw new Error(
      `plugin "${plugin.plugin}" has no skill tagged surfaces: [${SURFACE_ID}] -- ` +
        `the router is tag-or-all, so every one of its ${entries.length} skills would be offered`,
    );
  }
  return entries;
}

function assertNoLocalCheckout(text, targetName) {
  const named = HOME_DIR_PATH.exec(text);
  if (named) {
    throw new Error(
      `${targetName}: "${named[0]}" is a path in somebody's home directory, ` +
        `which must not ship -- rewrite it upstream or exclude the file`,
    );
  }
  for (const m of text.matchAll(TILDE_PATH)) {
    const rest = m[1];
    if (GENERIC_HOME_PREFIXES.some((prefix) => rest.startsWith(prefix))) continue;
    throw new Error(
      `${targetName}: "~/${rest}" is a path in somebody's home directory that is not a ` +
        `known tool cache -- rewrite it upstream, exclude the file, or add the prefix ` +
        `to GENERIC_HOME_PREFIXES if it really is generic`,
    );
  }
}

/**
 * Hash of the content with line endings normalised. Git hands Windows checkouts
 * CRLF, so hashing the bytes on disk would fail the drift gate on that leg only.
 */
export function sha256(text) {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf-8").digest("hex");
}

// Codepoint order, not `localeCompare`: the manifest has to come out in the
// same order on every machine that runs the sync, and collation is not.
const byTargetName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Glob match over slash-separated paths: `*` stays in one segment, `**` does not. */
export function matchesPattern(pattern, filePath) {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`).test(filePath);
}

/**
 * Which files a plugin entry selects, and what each one is called in the vendor
 * tree. `available` is every path under the plugin's skills root. An include
 * that matches nothing is an error: a renamed cast upstream should stop the
 * sync, not quietly shrink what ships.
 *
 * @param {{plugin: string, as?: string, include: (string | {source: string, target: string, why?: string})[], exclude?: string[], why?: string}} entry
 * @param {string[]} available
 * @returns {{source: string, target: string, why?: string}[]}
 */
export function selectFiles(entry, available) {
  const exclude = entry.exclude ?? [];
  const isExcluded = (p) => exclude.some((pattern) => matchesPattern(pattern, p));
  const prefix = (target) => (entry.as ? `${entry.as}/${target}` : target);
  const selected = new Map();

  const add = (file) => {
    // Split on both separators: `..\\..\\x.md` has no forward slash at all, and
    // `path.join` on Windows would happily walk it out of the vendor directory.
    const segments = file.target.split(/[\\/]/);
    if (/^([A-Za-z]:)?[\\/]/.test(file.target) || segments.includes("..")) {
      throw new Error(`plugin "${entry.plugin}": target "${file.target}" leaves the vendor tree`);
    }
    const clash = selected.get(file.target);
    if (clash && clash.source !== file.source) {
      throw new Error(
        `plugin "${entry.plugin}": ${clash.source} and ${file.source} both vendor as ${file.target}`,
      );
    }
    selected.set(file.target, file);
  };

  for (const item of entry.include) {
    if (typeof item === "string") {
      const hits = available.filter((p) => matchesPattern(item, p) && !isExcluded(p));
      if (hits.length === 0) {
        throw new Error(`plugin "${entry.plugin}": include "${item}" matched nothing`);
      }
      for (const p of hits) add({ source: p, target: prefix(p) });
      continue;
    }
    if (!available.includes(item.source)) {
      throw new Error(`plugin "${entry.plugin}": include "${item.source}" does not exist upstream`);
    }
    if (isExcluded(item.source)) continue;
    add({ source: item.source, target: prefix(item.target), why: item.why });
  }

  return [...selected.values()].sort((a, b) => byTargetName(a.target, b.target));
}

/**
 * The targets the manifest names outright, or null when any plugin selects by
 * pattern -- a glob cannot be re-evaluated without the source tree, so offline
 * there is nothing to compare against. Both plugins glob today, so this returns
 * null in production and the two comparisons it feeds are exercised only by
 * tests; the explicit-include form is kept for a future plugin that needs to
 * name a handful of files rather than a directory. An explicit include that an exclude also
 * matches is not vendored, so it is not declared either; counting it would make
 * `sync` and `check` disagree on a manifest that is perfectly consistent.
 */
export function declaredTargets(manifest) {
  const plugins = manifest.plugins ?? [];
  if (!plugins.flatMap((p) => p.include).every((i) => typeof i === "object")) return null;
  return plugins.flatMap((p) =>
    p.include
      .filter((i) => !(p.exclude ?? []).some((pattern) => matchesPattern(pattern, i.source)))
      .map((i) => (p.as ? `${p.as}/${i.target}` : i.target)),
  );
}

/**
 * The four ways the vendored tree can be wrong, as pure logic over what the
 * source manifest asks for, what the vendored manifest recorded, and what is
 * actually on disk.
 *
 * @param {object} args
 * @param {{repo: string, commit: string, manifestSha?: string, syncSha?: string}} args.source what the manifest asks for
 * @param {{repo: string, commit: string, manifestSha?: string, syncSha?: string}} args.vendored what the vendored copy was built from
 * @param {string[] | null} args.declared targets the manifest names outright, null when it selects by pattern
 * @param {{target: string, sha256: string}[]} args.recorded entries in the vendored manifest
 * @param {string[]} args.present files found under the vendor dir, manifest excluded
 * @param {(target: string) => string | null} args.hashOf actual hash, null when unreadable
 * @returns {{kind: string, message: string}[]}
 */
export function checkVendored({ source, vendored, declared, recorded, present, hashOf }) {
  const failures = [];
  // Keep whatever follows the sha. Truncating `aa4da4b+dirty` to `aa4da4b`
  // makes the message read "pin moved to X but vendored from X", and the
  // suffix is the entire content of that failure.
  const short = (c) => {
    if (typeof c !== "string") return String(c);
    const m = /^([0-9a-f]{7,40})(.*)$/.exec(c);
    return m ? m[1].slice(0, 7) + m[2] : c;
  };

  if (source.repo !== vendored.repo || source.commit !== vendored.commit) {
    failures.push({
      kind: "moved-pin",
      message:
        `pin moved to ${source.repo}@${short(source.commit)} but files were not ` +
        `re-synced (vendored from ${vendored.repo}@${short(vendored.commit)})`,
    });
  } else {
    // Globs cannot be re-evaluated without the source tree, so the only offline
    // way to notice an edited selection, or an edited transform, is to hash the
    // inputs. A recorded hash that is absent is not a pass: it means the tree
    // was written by something that did not record it.
    for (const [label, want, have] of [
      ["the manifest", source.manifestSha, vendored.manifestSha],
      ["the sync script", source.syncSha, vendored.syncSha],
    ]) {
      if (!have) {
        failures.push({
          kind: "moved-pin",
          message: `_manifest.json records no hash for ${label}`,
        });
      } else if (want !== have) {
        failures.push({
          kind: "moved-pin",
          message: `${label} changed but files were not re-synced`,
        });
      }
    }
  }

  const recordedTargets = new Set(recorded.map((f) => f.target));
  const presentSet = new Set(present);

  for (const target of declared ?? []) {
    if (!recordedTargets.has(target)) {
      failures.push({ kind: "missing", message: `${target}: in the manifest but not vendored` });
    }
  }

  for (const entry of recorded) {
    if (!presentSet.has(entry.target)) {
      failures.push({ kind: "missing", message: `${entry.target}: recorded but not on disk` });
      continue;
    }
    const actual = hashOf(entry.target);
    if (actual !== entry.sha256) {
      failures.push({
        kind: "hash-mismatch",
        message: `${entry.target}: hand-edited or corrupt (sha256 mismatch)`,
      });
    }
  }

  if (declared) {
    for (const target of recordedTargets) {
      if (!declared.includes(target)) {
        failures.push({
          kind: "orphaned",
          message: `${target}: vendored but no longer in the manifest`,
        });
      }
    }
  }

  for (const file of present) {
    if (!recordedTargets.has(file)) {
      failures.push({ kind: "orphaned", message: `${file}: on disk but not in _manifest.json` });
    }
  }

  return failures;
}

/**
 * The files a commit actually contains under `prefix`, as slash-separated paths
 * relative to it.
 *
 * Deliberately not a directory walk. A checkout can hold anything the author
 * left lying around -- an ignored `.env`, a scratch file, a symlink out of the
 * tree -- and none of it is covered by the commit whose provenance we record, so
 * a walk would let it ship with a clean pin. Each entry carries whether it is a
 * regular blob; git records a symlink as mode 120000 and a submodule as 160000.
 *
 * Content is still read from the working tree, which is the same thing for the
 * fetched copy and is the point of the local override. A local checkout that
 * differs from its commit reports `+dirty` and the gate refuses the result.
 */
export function listCommittedFiles(dir, rev, prefix) {
  const out = git(["ls-tree", "-r", "-z", rev, "--", prefix], dir);
  const files = [];
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(
        `${file}: not a regular file in ${rev} (mode ${mode}); refusing to vendor it`,
      );
    }
    files.push(file.slice(prefix.length + 1));
  }
  return files.sort();
}

/** Every file under `dir`, as slash-separated paths relative to it. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

function readManifestText() {
  return fs.readFileSync(MANIFEST_PATH, "utf-8");
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${(res.stderr ?? "").trim()}`);
  }
  return res.stdout;
}

/**
 * A directory holding the source tree. Fetching the pinned commit directly is
 * one object walk and keeps working when the pin falls behind whatever the
 * default branch has moved to.
 */
function materializeSource(manifest) {
  const local = process.env.LOOM_AGENTIC_PLUGINS_DIR;
  if (local) {
    const dir = path.resolve(local);
    if (!fs.existsSync(path.join(dir, "plugins"))) {
      throw new Error(`LOOM_AGENTIC_PLUGINS_DIR is set but ${dir} has no plugins/ directory`);
    }
    // Record what the checkout actually is, not what the manifest asked for.
    // Otherwise a sync from a side branch writes a provenance record naming a
    // commit whose content it does not contain, and the gate certifies it.
    // Files are enumerated from the commit, so the directory has to be a
    // repository -- there is no provenance to record for a bare folder.
    const commit = localCheckoutCommit(dir);
    if (commit === null) {
      throw new Error(`LOOM_AGENTIC_PLUGINS_DIR is set but ${dir} is not a git repository`);
    }
    console.log(`Reading ${dir} (LOOM_AGENTIC_PLUGINS_DIR) at ${commit}.`);
    const commitDate = git(["show", "-s", "--format=%cs", "HEAD"], dir).trim();
    if (commit !== manifest.commit) {
      console.log("That is not the pinned commit, so `check:skills` will reject the result.");
    }
    return { dir, commit, commitDate, rev: "HEAD", cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-sync-"));
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", `https://github.com/${manifest.repo}.git`], dir);
  git(["fetch", "-q", "--depth", "1", "origin", manifest.commit], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return {
    dir,
    commit: git(["rev-parse", "HEAD"], dir).trim(),
    // Read from the commit, not from the manifest: the date reaches a tooltip in
    // Preferences, and a pin bump that forgot to update it by hand would ship a
    // wrong one with the gate perfectly happy.
    commitDate: git(["show", "-s", "--format=%cs", "HEAD"], dir).trim(),
    rev: "HEAD",
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function localCheckoutCommit(dir) {
  try {
    const head = git(["rev-parse", "HEAD"], dir).trim();
    return git(["status", "--porcelain"], dir).trim() ? `${head}+dirty` : head;
  } catch {
    return null;
  }
}

function readUpstreamPin(sourceDir, plugin) {
  try {
    const raw = fs.readFileSync(path.join(sourceDir, "plugins", plugin, "UPSTREAM.json"), "utf-8");
    const { repository, ref, commit, path: subPath } = JSON.parse(raw);
    return { repository, ref, commit, path: subPath };
  } catch {
    console.warn(`  (no readable UPSTREAM.json for ${plugin}; provenance chain not recorded)`);
    return null;
  }
}

async function sync() {
  const manifestText = readManifestText();
  const manifest = JSON.parse(manifestText);
  const source = materializeSource(manifest);

  try {
    const entries = [];
    const plugins = [];
    const catalog = {};
    const claimedRepos = new Set();
    const byTarget = new Map();

    // Read and transform everything before writing anything. A transform that
    // refuses a file is the normal way this fails, and half a tree on disk with
    // a stale manifest beside it reports as four hash mismatches rather than as
    // "the last sync did not finish".
    for (const plugin of manifest.plugins) {
      const prefix = `plugins/${plugin.plugin}/${PLUGIN_SKILLS_ROOT}`;
      const root = path.join(source.dir, "plugins", plugin.plugin, PLUGIN_SKILLS_ROOT);
      if (!fs.existsSync(root)) {
        throw new Error(`plugin "${plugin.plugin}" has no ${PLUGIN_SKILLS_ROOT}/ directory`);
      }
      const committed = listCommittedFiles(source.dir, source.rev, prefix);
      if (committed.length === 0) {
        throw new Error(`plugin "${plugin.plugin}" has no committed files under ${prefix}`);
      }
      plugins.push({
        plugin: plugin.plugin,
        as: plugin.as ?? "",
        repo: plugin.repo,
        router: plugin.router ?? "never",
        transforms: plugin.transforms ?? [],
        why: plugin.why,
        upstream: readUpstreamPin(source.dir, plugin.plugin),
      });

      const pluginFiles = selectFiles(plugin, committed);
      const transformed = new Map(
        pluginFiles.map((f) => {
          const from = `plugins/${plugin.plugin}/${PLUGIN_SKILLS_ROOT}/${f.source}`;
          const bytes = fs.readFileSync(path.join(root, f.source));
          // Everything vendored is prose or JSON. Reading a binary as UTF-8
          // would replace every invalid sequence, hash the damage as if it were
          // the content, and sail through the gate.
          if (bytes.includes(0)) {
            throw new Error(`${from}: looks binary; the vendored set is text only`);
          }
          try {
            return [
              f.target,
              applyTransforms(bytes.toString("utf-8"), f.target, plugin.transforms),
            ];
          } catch (err) {
            throw new Error(`${from}: ${err.message}`, { cause: err });
          }
        }),
      );

      // Checked for every plugin, not only the routed ones: reads are scoped by
      // which plugin owns a repo name, and the lookup takes the first claimant.
      if (plugin.repo) {
        if (claimedRepos.has(plugin.repo) || plugin.repo in Object.prototype) {
          throw new Error(`repo "${plugin.repo}" is claimed twice or is not usable as a key`);
        }
        claimedRepos.add(plugin.repo);
      }
      if (plugin.router === "catalog") {
        if (!plugin.repo) {
          throw new Error(`plugin "${plugin.plugin}" is in the router but names no repo`);
        }
        // Read the transformed text, not the upstream bytes: a description is
        // copied straight into the cached system prompt, so it has to be the
        // one that went past the transforms rather than around them.
        catalog[plugin.repo] = buildCatalogEntries(plugin, pluginFiles, (f) =>
          transformed.get(f.target),
        );
      }

      for (const file of pluginFiles) {
        const owner = byTarget.get(file.target);
        if (owner) {
          throw new Error(`plugins "${owner}" and "${plugin.plugin}" both vendor ${file.target}`);
        }
        byTarget.set(file.target, plugin.plugin);

        const from = `plugins/${plugin.plugin}/${PLUGIN_SKILLS_ROOT}/${file.source}`;
        const text = transformed.get(file.target);
        entries.push({
          target: file.target,
          plugin: plugin.plugin,
          source: from,
          // Byte count of what the hash covers, so a CRLF checkout upstream
          // does not make the generated manifest differ by platform.
          bytes: Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf-8"),
          sha256: sha256(text),
          why: file.why,
          text,
        });
      }
    }

    entries.sort((a, b) => byTargetName(a.target, b.target));
    for (const entry of entries) {
      const abs = safeVendorPath(entry.target);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Writing through an existing symlink would put the content wherever it
      // points. Replace the link rather than follow it.
      const existing = lstatOrNull(abs);
      if (existing?.isSymbolicLink()) fs.rmSync(abs);
      fs.writeFileSync(abs, entry.text, "utf-8");
      console.log(`  ${entry.target}  (${entry.bytes} bytes)`);
      delete entry.text;
    }

    const catalogText =
      JSON.stringify(
        {
          $comment:
            "Generated by scripts/sync-skills.mjs from the vendored SKILL.md " +
            "frontmatter. Do not hand-edit; run `npm run sync:skills` instead.",
          ...catalog,
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(VENDOR_CATALOG, catalogText, "utf-8");
    fs.writeFileSync(
      PIN_MODULE,
      renderPinModule(manifest, source.commit, source.commitDate),
      "utf-8",
    );
    fs.writeFileSync(PIN_TYPES, PIN_TYPES_SOURCE, "utf-8");

    fs.writeFileSync(
      VENDOR_MANIFEST,
      JSON.stringify(
        {
          $comment:
            "Generated by scripts/sync-skills.mjs. Do not hand-edit; " +
            "run `npm run sync:skills` instead.",
          repo: manifest.repo,
          commit: source.commit,
          commitDate: source.commitDate,
          tag: manifest.tag ?? null,
          manifestSha256: sha256(manifestText),
          catalogSha256: sha256(catalogText),
          // The transforms decide what the vendored bytes are, so a change to
          // them without a re-sync is the same class of drift as a moved pin --
          // and the only one the hashes above cannot see. Re-running the sync
          // after editing this script is the cost; the diff is usually empty.
          syncSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8")),
          plugins,
          files: entries,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    pruneStale(new Set(entries.map((e) => e.target)));
    console.log(
      `Vendored ${entries.length} file(s) from ${manifest.repo}@${source.commit.slice(0, 7)}`,
    );
  } finally {
    source.cleanup();
  }
}

const PIN_TYPES_SOURCE = [
  "// Generated by scripts/sync-skills.mjs. Do not hand-edit; run `npm run sync:skills`.",
  "export const SKILLS_PIN: {",
  "  repo: string;",
  "  /** Commit the bundled content was vendored from. Tags move; this does not. */",
  "  commit: string;",
  "  commitDate: string | null;",
  "  tag: string | null;",
  "};",
  "",
].join("\n");

function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs);
  } catch {
    return null;
  }
}

/**
 * Resolve a target inside the vendor directory, refusing anything that leaves
 * it. `selectFiles` rejects the obvious shapes, but it works on strings and this
 * works on the resolved path, which is the thing the write actually uses.
 */
export function safeVendorPath(target, vendorDir = VENDOR_DIR) {
  const abs = path.resolve(vendorDir, target);
  if (abs !== vendorDir && !abs.startsWith(vendorDir + path.sep)) {
    throw new Error(`target "${target}" resolves outside the vendor directory`);
  }
  // The string is contained; the filesystem may not be. A symlinked directory
  // anywhere above the file satisfies `mkdirSync(..., { recursive: true })` and
  // the write goes straight through it, so resolve as much of the parent chain
  // as exists and check that too.
  const realParent = realpathOfNearestExisting(path.dirname(abs));
  const realVendor = realpathOfNearestExisting(vendorDir);
  if (realParent !== realVendor && !realParent.startsWith(realVendor + path.sep)) {
    throw new Error(`target "${target}" resolves outside the vendor directory through a symlink`);
  }
  return abs;
}

/** realpath of `dir`, or of the deepest part of it that exists yet. */
function realpathOfNearestExisting(dir) {
  for (let candidate = dir; ; candidate = path.dirname(candidate)) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return dir;
    }
  }
}

function renderPinModule(manifest, commit, commitDate) {
  // Written in the repo's own formatting rather than JSON.stringify's: the file
  // is committed, so the formatter would rewrite it and the gate below, which
  // reads the commit straight back out of it, would stop matching.
  const field = (k, v) => `  ${k}: ${v === null || v === undefined ? "null" : JSON.stringify(v)},`;
  return [
    "// Generated by scripts/sync-skills.mjs. Do not hand-edit; run `npm run sync:skills`.",
    "// The commit the bundled skill content was vendored from, for a shell to show",
    "// beside a bundled repo. `tag` is a label only; the commit is the pin.",
    "export const SKILLS_PIN = {",
    field("repo", manifest.repo),
    field("commit", commit),
    field("commitDate", commitDate ?? null),
    field("tag", manifest.tag ?? null),
    "};",
    "",
  ].join("\n");
}

/**
 * Drop files a previous sync left behind. Without this a target that moves or
 * leaves the manifest stays on disk and keeps shipping, and `--check` reports it
 * as an orphan on every run until someone deletes it by hand.
 */
function pruneStale(keep) {
  if (!fs.existsSync(VENDOR_DIR)) return;
  for (const rel of listFiles(VENDOR_DIR)) {
    if (GENERATED.has(rel) || keep.has(rel)) continue;
    fs.rmSync(path.join(VENDOR_DIR, rel));
    console.log(`  removed ${rel}`);
  }
  // Directories a pruned file used to live in.
  const dirs = new Set();
  for (const rel of listFiles(VENDOR_DIR)) {
    for (let d = path.dirname(rel); d !== "."; d = path.dirname(d)) dirs.add(d);
  }
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(VENDOR_DIR, sub), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      walk(rel);
      if (!dirs.has(rel)) fs.rmdirSync(path.join(VENDOR_DIR, rel));
    }
  };
  walk("");
}

function check() {
  if (!fs.existsSync(VENDOR_MANIFEST)) {
    console.error("check:skills -- no vendored manifest; run `npm run sync:skills`");
    process.exit(1);
  }
  const vendored = JSON.parse(fs.readFileSync(VENDOR_MANIFEST, "utf-8"));
  const manifestText = readManifestText();
  const manifest = JSON.parse(manifestText);

  const failures = checkVendored({
    source: {
      repo: manifest.repo,
      commit: manifest.commit,
      manifestSha: sha256(manifestText),
      syncSha: sha256(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8")),
    },
    vendored: {
      repo: vendored.repo,
      commit: vendored.commit,
      manifestSha: vendored.manifestSha256,
      syncSha: vendored.syncSha256,
    },
    declared: declaredTargets(manifest),
    recorded: vendored.files,
    present: listFiles(VENDOR_DIR).filter((f) => !GENERATED.has(f)),
    hashOf: (target) => {
      try {
        return sha256(fs.readFileSync(path.join(VENDOR_DIR, target), "utf-8"));
      } catch {
        return null;
      }
    },
  });

  // The pin module is generated outside the vendor tree entirely, so the only
  // thing tying it to the manifest is this comparison.
  try {
    const pinned = /\bcommit:\s*["']([^"']+)["']/.exec(fs.readFileSync(PIN_MODULE, "utf-8"));
    if (!pinned || pinned[1] !== vendored.commit) {
      failures.push({
        kind: "moved-pin",
        message: `shared/skills-pin.js records ${pinned?.[1] ?? "nothing"}, not ${vendored.commit}`,
      });
    }
  } catch {
    failures.push({ kind: "missing", message: "shared/skills-pin.js: missing" });
  }

  // The catalog is generated beside the manifest rather than vendored, so it is
  // not in `present` and needs its own hash to catch a hand-edit.
  const catalogActual = fs.existsSync(VENDOR_CATALOG)
    ? sha256(fs.readFileSync(VENDOR_CATALOG, "utf-8"))
    : null;
  if (!vendored.catalogSha256) {
    failures.push({
      kind: "missing",
      message: `_manifest.json records no hash for ${VENDOR_CATALOG_NAME}`,
    });
  } else if (catalogActual !== vendored.catalogSha256) {
    failures.push({
      kind: "hash-mismatch",
      message: `${VENDOR_CATALOG_NAME}: hand-edited, corrupt or missing (sha256 mismatch)`,
    });
  }

  if (failures.length > 0) {
    console.error("check:skills FAILED");
    for (const f of failures) console.error(`  - ${f.message}`);
    console.error("\nRun `npm run sync:skills` to regenerate.");
    process.exit(1);
  }
  console.log(`check:skills OK -- ${vendored.files.length} file(s) match _manifest.json`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`usage: sync-skills.mjs [--check] (got ${args.join(" ")})`);
    process.exit(2);
  }
  try {
    if (args[0] === "--check") {
      check();
    } else {
      await sync();
    }
  } catch (err) {
    // The messages are the point of this script's failures; eight lines of node
    // internals on top of them is not.
    console.error(`sync-skills: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
