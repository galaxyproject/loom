/**
 * Loom <-> Galaxy-flavored-markdown content adapter. notebook.md is canonical.
 *
 * Push replaces each `loom-invocation` fenced block with a hidden HTML-comment
 * carrier holding the literal block, base64-encoded. Galaxy preserves both the
 * markdown body and HTML comments byte-for-byte (verified against 26.1.rc1), so
 * pull restores the original fences exactly. base64 keeps the payload free of
 * `-->` and newlines, so the comment is always single-line and well-formed.
 *
 * Phase 2 adds a visible ` ```galaxy ` directive alongside the carrier; pull
 * strips those directives (Loom owns the projection under the loom-canonical
 * model), which is why galaxyMarkdownToLoom removes ```galaxy blocks here even
 * though Phase 1 never emits them -- it keeps pull forward-compatible.
 */

const INV_FENCE_OPEN = "```loom-invocation";
const FENCE_CLOSE = "```";
const GALAXY_FENCE_OPEN = "```galaxy";

const CARRIER_RE = /<!-- loom-invocation:v1 ([A-Za-z0-9+/=]+) -->/g;

/** Push: loom-invocation fences -> hidden base64 carriers. Narrative untouched. */
export function loomToGalaxyMarkdown(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === INV_FENCE_OPEN) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      const block = lines.slice(i, end + 1).join("\n");
      const b64 = Buffer.from(block, "utf8").toString("base64");
      out.push(`<!-- loom-invocation:v1 ${b64} -->`);
      i = end + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/** Pull: carriers -> original loom-invocation fences; strip any ```galaxy blocks. */
export function galaxyMarkdownToLoom(body: string): string {
  const restored = body.replace(CARRIER_RE, (_m, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );
  return stripGalaxyDirectiveBlocks(restored);
}

/** Remove ```galaxy ... ``` fenced blocks (Loom-emitted projection, regenerated each push). */
function stripGalaxyDirectiveBlocks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === GALAXY_FENCE_OPEN) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      i = end + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}
