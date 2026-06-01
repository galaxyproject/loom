/**
 * Loom <-> Galaxy-flavored-markdown content adapter. notebook.md is canonical.
 *
 * Push replaces each `loom-invocation` fenced block with a hidden carrier holding
 * the literal block, base64-encoded. The carrier is a CommonMark link-reference
 * definition (`[loom-invocation:v1]: #loom "<base64>"`): it renders to nothing and
 * is preserved byte-for-byte on store, so pull restores the original fences exactly.
 * (HTML comments do NOT work here -- Galaxy's page renderer escapes them to visible
 * text rather than hiding them, verified live against 26.1.rc1. A reference
 * definition is pure markdown, so it stays invisible.) base64 keeps the payload free
 * of quotes and newlines, so the carrier is always one well-formed line.
 *
 * Phase 2 adds a visible ` ```galaxy ` directive alongside the carrier; pull
 * strips the directives Loom emitted (Loom owns the projection under the
 * loom-canonical model and regenerates them each push). A Loom directive always
 * sits immediately above a carrier with no blank line between, so pull strips
 * only ```galaxy blocks in that position -- a ```galaxy fence a human wrote (or
 * a co-author added on the Galaxy side) survives the round trip.
 */

import { galaxyGet } from "./galaxy-api";

const INV_FENCE_OPEN = "```loom-invocation";
const FENCE_CLOSE = "```";
const GALAXY_FENCE_OPEN = "```galaxy";

// Anchored to a whole line (`m` flag): the carrier is always its own line, so
// this never decodes carrier-like syntax that appears inline in prose (e.g. a
// notebook documenting Loom's own format). The `g` flag replaces every carrier.
const CARRIER_RE = /^\[loom-invocation:v1\]: #loom "([A-Za-z0-9+/=]+)"$/gm;

/** base64 a loom-invocation block into a (render-invisible) link-reference carrier. */
function encodeCarrier(block: string): string {
  return `[loom-invocation:v1]: #loom "${Buffer.from(block, "utf8").toString("base64")}"`;
}

/**
 * Push (pure, no network): loom-invocation fences -> hidden base64 carriers,
 * narrative untouched. The sync helper pushes via loomToGalaxyMarkdownRich
 * (which also emits validated directives); this plain form is kept for
 * non-network callers and the round-trip tests.
 */
export function loomToGalaxyMarkdown(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === INV_FENCE_OPEN) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      const block = lines.slice(i, end + 1).join("\n");
      out.push(encodeCarrier(block));
      i = end + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/** Pull: strip the ```galaxy directives Loom emitted, then carriers -> original
 *  loom-invocation fences. Stripping runs first, while carriers are still single
 *  lines, so the "directive sits directly above a carrier" check is exact. */
export function galaxyMarkdownToLoom(body: string): string {
  const withoutLoomDirectives = stripLoomGalaxyDirectiveBlocks(body);
  return withoutLoomDirectives.replace(CARRIER_RE, (_m, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );
}

// Single-line carrier matcher. CARRIER_RE is global/multiline (stateful via
// lastIndex), so it's unsafe for a one-off .test(); this is the per-line form.
const CARRIER_LINE_RE = /^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/;

/**
 * Remove only the ```galaxy directive blocks Loom itself emitted.
 * loomToGalaxyMarkdownRich always writes the directive immediately above the
 * invocation's carrier with no blank line between, so a ```galaxy block is
 * Loom's iff the line right after its closing fence is a carrier. Every other
 * ```galaxy block was authored by a human and is preserved verbatim -- stripping
 * those unconditionally was silent data loss on pull.
 */
function stripLoomGalaxyDirectiveBlocks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === GALAXY_FENCE_OPEN) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      // `end` is the closing fence (or EOF). Drop the block only when Loom's
      // carrier immediately follows it; otherwise fall through and keep it.
      if (end + 1 < lines.length && CARRIER_LINE_RE.test(lines[end + 1])) {
        i = end + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/** Decides whether an invocation id is renderable on the connected server. */
export interface InvocationValidator {
  isValid(invocationId: string): Promise<boolean>;
}

/**
 * Real validator: a GET that resolves means the id decodes and exists. It
 * queries the ambient configured server (galaxyGet reads GALAXY_URL), not a
 * block's own galaxy_server_url -- so an id from a different server validates
 * as false and its directive is safely omitted, which is correct under the
 * single-server push model.
 */
export const galaxyInvocationValidator: InvocationValidator = {
  async isValid(invocationId: string): Promise<boolean> {
    try {
      await galaxyGet(`/invocations/${invocationId}`);
      return true;
    } catch {
      return false;
    }
  },
};

const INV_ID_RE = /^invocation_id:\s*(.+)$/;

/**
 * Push with rich rendering: each loom-invocation block becomes a hidden carrier
 * AND, when its id validates, a visible `invocation_outputs` directive. The
 * directive is gated because Galaxy 400s the whole page on an undecodable id.
 */
export async function loomToGalaxyMarkdownRich(
  body: string,
  validator: InvocationValidator,
): Promise<string> {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === INV_FENCE_OPEN) {
      let end = i + 1;
      let invId: string | null = null;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) {
        const m = lines[end].match(INV_ID_RE);
        if (m) invId = m[1].trim();
        end++;
      }
      const block = lines.slice(i, end + 1).join("\n");
      const carrier = encodeCarrier(block);
      // Emit the directive immediately before the carrier with NO extra blank
      // line, so stripping the 3 fence lines on pull restores the carrier in
      // the block's exact original position -- keeping the round trip identical.
      if (invId && (await validator.isValid(invId))) {
        out.push(GALAXY_FENCE_OPEN);
        out.push(`invocation_outputs(invocation_id=${invId})`);
        out.push(FENCE_CLOSE);
      }
      out.push(carrier);
      i = end + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}
