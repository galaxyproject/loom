/**
 * Orbit <-> Galaxy-flavored-markdown content adapter. notebook.md is canonical.
 *
 * Push replaces each typed notebook fence Orbit keeps in the notebook body --
 * `loom-invocation`, `loom-job`, `loom-session`, `loom-udt` and
 * `loom-proposal` -- with a hidden carrier
 * holding the literal block, base64-encoded. Galaxy has no renderer for these
 * fence kinds, so a raw one shows up on the page as a "cell type is not
 * available" error. The carrier is a CommonMark link-reference definition
 * (`[loom-<kind>:v1]: #loom "<base64>"`): it renders to nothing and is preserved
 * byte-for-byte on store, so pull restores the original fences exactly.
 * (HTML comments do NOT work here -- Galaxy's page renderer escapes them to
 * visible text rather than hiding them, verified live against 26.1.rc1. A
 * reference definition is pure markdown, so it stays invisible.) base64 keeps
 * the payload free of quotes and newlines, so the carrier is always one
 * well-formed line. `loom-galaxy-page` binding blocks never reach this adapter;
 * the sync helper strips them before push, and pull never decodes one, so a
 * page can't plant a binding.
 *
 * Invocation and job blocks also get a visible ` ```galaxy ` directive
 * (`invocation_outputs` / `job_parameters`) alongside the carrier when their id
 * validates against the connected server; the other kinds get the carrier only. Pull strips the directives Orbit emitted (Orbit owns
 * the projection under the loom-canonical model and regenerates them each
 * push). A Orbit directive always sits immediately above a carrier with no blank
 * line between, so pull strips only ```galaxy blocks in that position -- a
 * ```galaxy fence a human wrote (or a co-author added on the Galaxy side)
 * survives the round trip.
 */

import { galaxyGet } from "./galaxy-api";
import {
  NOTEBOOK_FENCE_READ_PREFIXES,
  NOTEBOOK_FENCE_WRITE_PREFIX,
  isNotebookFenceOpen,
} from "../../shared/notebook-fences.js";

const FENCE_CLOSE = "```";
const GALAXY_FENCE_OPEN = "```galaxy";

/**
 * Notebook fence kinds that are carried through a Galaxy page push: every typed block the
 * record holds but the binding, since Galaxy refuses a page with a fence it has no cell for.
 */
const CARRIED_KINDS = ["invocation", "job", "session", "udt", "proposal"] as const;
type CarriedKind = (typeof CARRIED_KINDS)[number];

// Anchored to a whole line (`m` flag): the carrier is always its own line, so
// this never decodes carrier-like syntax that appears inline in prose (e.g. a
// notebook documenting Orbit's own format). The `g` flag replaces every carrier.
// Tolerate trailing horizontal whitespace -- a storage round trip can append a
// space, and an unmatched carrier silently loses the block on pull.
// The carrier's label and anchor carry the product prefix too, so a page pushed
// by a newer (or older) client still decodes; the payload is the block verbatim,
// fence line included, so pull restores whatever prefix was pushed.
const CARRIER_PREFIX_ALT = NOTEBOOK_FENCE_READ_PREFIXES.join("|");
const CARRIER_KIND_ALT = CARRIED_KINDS.join("|");
const CARRIER_BODY = `\\[(?:${CARRIER_PREFIX_ALT})-(?:${CARRIER_KIND_ALT}):v1\\]: #(?:${CARRIER_PREFIX_ALT}) "([A-Za-z0-9+/=]+)"[ \\t]*`;
const CARRIER_RE = new RegExp(`^${CARRIER_BODY}$`, "gm");

/** base64 a typed block into a (render-invisible) link-reference carrier. */
function encodeCarrier(kind: CarriedKind, block: string): string {
  const p = NOTEBOOK_FENCE_WRITE_PREFIX;
  return `[${p}-${kind}:v1]: #${p} "${Buffer.from(block, "utf8").toString("base64")}"`;
}

function carriedKindOf(line: string): CarriedKind | null {
  for (const kind of CARRIED_KINDS) {
    if (isNotebookFenceOpen(line, kind)) return kind;
  }
  return null;
}

/**
 * Push (pure, no network): typed notebook fences -> hidden base64 carriers,
 * narrative untouched. The sync helper pushes via orbitToGalaxyMarkdownRich
 * (which also emits validated directives); this plain form is kept for
 * non-network callers and the round-trip tests.
 */
export function orbitToGalaxyMarkdown(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = carriedKindOf(lines[i]);
    if (kind) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      const block = lines.slice(i, end + 1).join("\n");
      out.push(encodeCarrier(kind, block));
      i = end + 1;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/** Pull: strip the ```galaxy directives Orbit emitted, then carriers -> original
 *  typed fences. Stripping runs first, while carriers are still single lines,
 *  so the "directive sits directly above a carrier" check is exact. */
export function galaxyMarkdownToOrbit(body: string): string {
  const withoutOrbitDirectives = stripOrbitGalaxyDirectiveBlocks(body);
  return withoutOrbitDirectives.replace(CARRIER_RE, (_m, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );
}

// Single-line carrier matcher. CARRIER_RE is global/multiline (stateful via
// lastIndex), so it's unsafe for a one-off .test(); this is the per-line form.
// Same trailing-whitespace tolerance as CARRIER_RE so the strip heuristic and
// the decoder agree on what counts as a carrier line.
const CARRIER_LINE_RE = new RegExp(`^${CARRIER_BODY}$`);

/**
 * Remove only the ```galaxy directive blocks Orbit itself emitted.
 * orbitToGalaxyMarkdownRich always writes the directive immediately above the
 * block's carrier with no blank line between, so a ```galaxy block is Orbit's
 * iff the line right after its closing fence is a carrier. Every other
 * ```galaxy block was authored by a human and is preserved verbatim -- stripping
 * those unconditionally was silent data loss on pull. The one exception: a human
 * ```galaxy block sitting directly above a typed block, with no blank line between,
 * looks like Orbit's and is dropped on read. Under a page record that read follows
 * every write, not just a pull.
 */
function stripOrbitGalaxyDirectiveBlocks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === GALAXY_FENCE_OPEN) {
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      // `end` is the closing fence (or EOF). Drop the block only when Orbit's
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

/** Decides whether a Galaxy id is renderable on the connected server. */
export interface IdValidator {
  isValid(id: string): Promise<boolean>;
}

export type InvocationValidator = IdValidator;
export type JobValidator = IdValidator;

/** One validator per directive-bearing block kind. */
export interface DirectiveValidators {
  invocation: InvocationValidator;
  job: JobValidator;
}

/**
 * Real validators: a GET that resolves AND echoes back the same id means the id
 * decodes and exists on the connected server (galaxyGet reads GALAXY_URL, not a
 * block's own galaxy_server_url -- so an id from a different server validates as
 * false and its directive is safely omitted, correct under the single-server
 * push model).
 *
 * Two guards stop a malformed id from smuggling a directive onto the page:
 * encoded ids are hex, so anything else is rejected before any network call (a
 * value like "../histories" would otherwise dot-segment-normalize to a real
 * endpoint, return 200, and pass); and the response id must equal the requested
 * id, so a 200 for some *other* resource doesn't count. Both matter because
 * pulled page content is untrusted -- a hostile carrier must not 400 the next
 * push.
 */
const ENCODED_ID_RE = /^[0-9a-fA-F]+$/;

function echoingIdValidator(collection: string): IdValidator {
  return {
    async isValid(id: string): Promise<boolean> {
      if (!ENCODED_ID_RE.test(id)) return false;
      try {
        const res = await galaxyGet<{ id?: string }>(`/${collection}/${encodeURIComponent(id)}`);
        return res?.id === id;
      } catch {
        return false;
      }
    },
  };
}

export const galaxyInvocationValidator: InvocationValidator = echoingIdValidator("invocations");
export const galaxyJobValidator: JobValidator = echoingIdValidator("jobs");

export const galaxyDirectiveValidators: DirectiveValidators = {
  invocation: galaxyInvocationValidator,
  job: galaxyJobValidator,
};

const DIRECTIVES: Record<
  keyof DirectiveValidators,
  { idRe: RegExp; render: (id: string) => string }
> = {
  invocation: {
    idRe: /^invocation_id:\s*(.+)$/,
    render: (id) => `invocation_outputs(invocation_id=${id})`,
  },
  job: {
    idRe: /^job_id:\s*(.+)$/,
    render: (id) => `job_parameters(job_id=${id})`,
  },
};

/**
 * Push with rich rendering: each typed block becomes a hidden carrier AND, for
 * invocation and job blocks whose id validates, a visible directive. The
 * directive is gated because Galaxy 400s the whole page on an undecodable id.
 */
export async function orbitToGalaxyMarkdownRich(
  body: string,
  validators: DirectiveValidators,
): Promise<string> {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = carriedKindOf(lines[i]);
    if (kind) {
      const directed = kind === "invocation" || kind === "job" ? kind : null;
      const directive = directed ? DIRECTIVES[directed] : null;
      let end = i + 1;
      let id: string | null = null;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) {
        const m = directive ? lines[end].match(directive.idRe) : null;
        if (m) id = m[1].trim();
        end++;
      }
      const block = lines.slice(i, end + 1).join("\n");
      const carrier = encodeCarrier(kind, block);
      // Emit the directive immediately before the carrier with NO extra blank
      // line, so stripping the 3 fence lines on pull restores the carrier in
      // the block's exact original position -- keeping the round trip identical.
      if (directed && directive && id && (await validators[directed].isValid(id))) {
        out.push(GALAXY_FENCE_OPEN);
        out.push(directive.render(id));
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
