// Shell-neutral "what's new" logic: parse the curated CHANGELOG, decide whether
// a freshly-upgraded user should see notes, and select which entries to show.
// Pure and dependency-light (reuses the shared semver comparator) so it's unit-
// testable from the root Vitest suite and usable from both Orbit and the CLI.

import { isNewer, parseSemver } from "./version-compare.js";

// "## [1.2.3] - 2026-01-02" or "## 1.2.3" (brackets + date optional).
const HEADER_RE = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:-\s*(.+?))?\s*$/;
const BULLET_RE = /^[-*]\s+(.+?)\s*$/;

/** Parse CHANGELOG markdown into entries (newest-first, file order). Only the
 * `### Highlights` subsection of each version is collected; a version without
 * one is skipped. Pure.
 * @param {string} markdown @returns {import("./whats-new.js").WhatsNewEntry[]} */
export function parseChangelog(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const entries = [];
  let current = null;
  let inHighlights = false;
  for (const line of lines) {
    const header = line.match(HEADER_RE);
    if (header) {
      if (current && current.highlights.length) entries.push(current);
      current = { version: header[1], date: header[2]?.trim() || undefined, highlights: [] };
      inHighlights = false;
      continue;
    }
    if (!current) continue;
    if (/^###\s+/.test(line)) {
      inHighlights = /^###\s+highlights\b/i.test(line.trim());
      continue;
    }
    if (inHighlights) {
      const bullet = line.match(BULLET_RE);
      if (bullet) current.highlights.push(bullet[1].trim());
    }
  }
  if (current && current.highlights.length) entries.push(current);
  return entries;
}

/** @param {string} a @param {string} b @returns {boolean} */
function sameVersion(a, b) {
  if (!parseSemver(a) || !parseSemver(b)) return false;
  return !isNewer(a, b) && !isNewer(b, a);
}

/** Which entries to display.
 * - "latest": just the running version's entry (0 or 1), ignoring lastSeen.
 * - "accumulate": every entry with lastSeen < version <= running.
 * Pure. */
export function selectEntries(all, lastSeen, running, mode) {
  if (mode === "latest") {
    return all.filter((e) => sameVersion(e.version, running));
  }
  return all.filter(
    (e) => (lastSeen ? isNewer(lastSeen, e.version) : true) && !isNewer(running, e.version),
  );
}

/** Decide stamp + entries for a launch. Pure.
 * - lastSeen unset (fresh install): stamp running, show nothing.
 * - running not newer than lastSeen: no stamp, nothing.
 * - otherwise: stamp running, show selected entries. */
export function decideWhatsNew(all, lastSeen, running, mode) {
  if (!lastSeen) return { stamp: running, entries: [] };
  if (!isNewer(lastSeen, running)) return { stamp: null, entries: [] };
  return { stamp: running, entries: selectEntries(all, lastSeen, running, mode) };
}

/** GitHub release page for a tag. @param {string} version @returns {string} */
export function releaseUrlFor(version) {
  return `https://github.com/galaxyproject/loom/releases/tag/v${String(version).replace(/^v/, "")}`;
}

/** Plain-text block for the CLI notice / /whatsnew. Pure.
 * @param {import("./whats-new.js").WhatsNewEntry[]} entries @returns {string} */
export function formatHighlightsText(entries) {
  return entries
    .map((e) => `What's new in ${e.version}\n${e.highlights.map((h) => `  - ${h}`).join("\n")}`)
    .join("\n\n");
}
