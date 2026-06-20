// Shared, shell-neutral classifier for destructive Galaxy operations. Used by BOTH
// tool_call gates -- the brain's exec-guard (Orbit/CLI) and the web-mode-gate (remote) --
// so "what counts as destructive" has a single home instead of a denylist duplicated per
// shell. Closes the #338 gap: a destructive Galaxy mutation (whole-history delete/purge)
// must be confirmed (or, where no confirm UI exists, blocked) regardless of model tier.
//
// Two confidence levels here:
//   - RELIABLE: structured JSON we can read exactly -- a direct tool call, or one wrapped
//     in the adapter's generic `mcp({tool, args})` proxy (args is a JSON string).
//   - BEST-EFFORT GUARDRAIL: free-form strings we can only pattern-match -- a raw curl/wget
//     DELETE, or code-mode's run_galaxy_tool(code=<python>) script. Trivially evadable
//     (obfuscation, a different client, method override); the goal is to catch the obvious
//     reach-for-the-nearest-tool case, not to be a security boundary.
//
// The op catalog is deliberately tiny and data-driven so it can later defer to galaxy-ops
// `destructiveHint` metadata (galaxy-mcp PR #61) instead of being hand-maintained here.

/**
 * @typedef {"history-delete" | "history-purge" | "dataset-delete" | "dataset-purge" | "collection-delete" | "collection-purge"} GalaxyDestructiveKind
 * @typedef {{ kind: GalaxyDestructiveKind, historyId?: string, datasetId?: string, collectionId?: string, irreversible: boolean }} GalaxyDestructiveOp
 */

// Op-name -> predicate over its input args, returning the destructive shape or null.
// NOTE: the pinned Galaxy MCP `update_history` tool exposes only `deleted` (a soft,
// recoverable delete) -- there is no `purged` param there, so an MCP-path history delete is
// always presented as recoverable. `purged` is still checked defensively (a future tool
// version or a direct API caller could supply it); irreversible purge in practice comes via
// the raw curl/code paths below, which carry the purge flag in the query or request body.
const DESTRUCTIVE_OPS = {
  /** @param {Record<string, unknown>} args */
  update_history(args) {
    if (args.purged === true) return { kind: "history-purge", irreversible: true };
    if (args.deleted === true) return { kind: "history-delete", irreversible: false };
    return null;
  },
};

/** Lowercase + drop a leading `galaxy_` so both the prefixed MCP name and the bare op name
 *  (and either gate's casing) resolve the same.
 * @param {unknown} toolName @returns {string} */
function normalize(toolName) {
  return String(toolName == null ? "" : toolName)
    .trim()
    .toLowerCase()
    .replace(/^galaxy_/, "");
}

/** @param {unknown} v @returns {Record<string, unknown>} */
function asObject(v) {
  return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : {};
}

/** The adapter's generic proxy passes args as a JSON string; tolerate objects and junk.
 * @param {unknown} v @returns {Record<string, unknown>} */
function parseArgs(v) {
  if (v && typeof v === "object") return /** @type {Record<string, unknown>} */ (v);
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} opName @param {Record<string, unknown>} args @returns {GalaxyDestructiveOp | null} */
function classifyOp(opName, args) {
  const predicate = DESTRUCTIVE_OPS[opName];
  if (!predicate) return null;
  const hit = predicate(args);
  if (!hit) return null;
  /** @type {GalaxyDestructiveOp} */
  const op = { kind: hit.kind, irreversible: hit.irreversible };
  if (typeof args.history_id === "string") op.historyId = args.history_id;
  return op;
}

/** Dispatch a resolved (name, args) pair: the code-mode meta-tool routes to the script
 *  guardrail, everything else to the structured op table.
 * @param {string} name @param {Record<string, unknown>} args @returns {GalaxyDestructiveOp | null} */
function classifyNamed(name, args) {
  if (name === "run_galaxy_tool") return classifyCode(args.code);
  return classifyOp(name, args);
}

/**
 * Classify an MCP tool call. Handles three shapes:
 *  - direct:     update_history({ deleted, history_id })
 *  - mcp proxy:  mcp({ tool: "galaxy_update_history", args: "<json string>" }) -- the
 *                adapter's generic gateway tool, a bypass if left unhandled (#338 F1)
 *  - code mode:  run_galaxy_tool({ code: "<python calling call_tool(...)>" }) (#338 F2)
 * @param {string} toolName @param {Record<string, unknown>} input @returns {GalaxyDestructiveOp | null}
 */
export function classifyGalaxyDestructive(toolName, input) {
  const name = normalize(toolName);
  const inputObj = asObject(input);
  if (name === "mcp") {
    return classifyNamed(normalize(inputObj.tool), parseArgs(inputObj.args));
  }
  return classifyNamed(name, inputObj);
}

/**
 * Honest, user-facing description for a confirmation prompt. Purge wording states it cannot
 * be undone; delete wording flags the whole-history scope and that it's usually recoverable
 * -- so the user is not misled either way (a soft delete is not a purge).
 * @param {GalaxyDestructiveOp} op @returns {{ headline: string }}
 */
export function describeGalaxyDestructive(op) {
  if (op.kind === "collection-delete" || op.kind === "collection-purge") {
    const target = op.collectionId ? `collection ${op.collectionId}` : "this collection";
    if (op.irreversible) {
      return {
        headline: `Permanently PURGE ${target} -- this deletes all of its datasets and cannot be undone.`,
      };
    }
    return {
      headline:
        `Mark ${target} (and all of its datasets) as deleted. ` +
        `Recoverable via Undelete on most Galaxy servers.`,
    };
  }
  const dataset = op.kind === "dataset-delete" || op.kind === "dataset-purge";
  if (dataset) {
    const target = op.datasetId ? `dataset ${op.datasetId}` : "this dataset";
    if (op.irreversible) {
      return { headline: `Permanently PURGE ${target} -- this cannot be undone.` };
    }
    return {
      headline:
        `Mark ${target} as deleted. Recoverable via Undelete on most Galaxy servers.`,
    };
  }
  if (op.irreversible) {
    const target = op.historyId ? `history ${op.historyId}` : "the entire history";
    return {
      headline: `Permanently PURGE ${target} -- this deletes all of its datasets and cannot be undone.`,
    };
  }
  const id = op.historyId ? ` (${op.historyId})` : "";
  return {
    headline:
      `Mark the entire history${id} as deleted -- not just specific datasets. ` +
      `Recoverable via Undelete on most Galaxy servers, but it affects the whole history.`,
  };
}

// Whether a `purge`/`purged` flag is set to a non-falsy value -- in a URL query
// (?purge=true|1|yes|on), a JSON/body/kwarg field ("purge": true / 'purged': True / purge=1),
// or carried in a request-body file we can't read (-d @file). Galaxy treats true/1/yes/on as
// truthy; only an explicit false/0/no/off (or no purge token at all) is a recoverable soft
// delete. An UNKNOWABLE value (shell variable, file body) is treated as a purge -- the safe,
// honest direction: over-warn rather than mislabel an irreversible purge as recoverable.
/** @param {string} s @returns {boolean} */
function hasPurge(s) {
  const falsy = /^(false|0|no|off)$/i;
  const q = s.match(/[?&]purged?=([^&\s"']*)/i);
  if (q) return !falsy.test(q[1]);
  const b = s.match(/["']?purged?["']?\s*[:=]\s*["']?([\w$.{}]+)/i);
  if (b) return !falsy.test(b[1]);
  // A DELETE whose body comes from a file we can't inspect could carry {"purge": true}.
  if (/(?:-d|--data(?:-raw|-binary|-urlencode)?|--json)[=\s]+@/i.test(s)) return true;
  return false;
}

// A clean literal id only -- never surface a shell variable / interpolation as the "id".
/** @param {string | undefined} raw @returns {string | undefined} */
function literalId(raw) {
  return raw && /^[A-Za-z0-9]+$/.test(raw) ? raw : undefined;
}

/**
 * BEST-EFFORT guardrail for the raw-bash path: an HTTP DELETE issued by curl/wget against a
 * Galaxy history, a dataset, or a dataset collection. Targets are checked most-severe first
 * so a less-severe URL in the same command can't conceal a worse one (a whole-history delete
 * wins over a dataset URL). Covers the history (`/api/histories/{id}`), contents
 * (`/contents[/datasets|/dataset_collections]/{id}`), and singleton/batch dataset
 * (`/api/datasets[/{id}]`) routes. Reversibility is read from a purge flag (query, body, or
 * an unreadable body file). Requires an actual curl/wget verb so a stray URL in `echo`/text
 * doesn't trip it; ids are surfaced only when literal (a `$VAR` is matched but not echoed as
 * a fake id).
 * @param {string} command @returns {GalaxyDestructiveOp | null}
 */
export function isGalaxyDestructiveCurl(command) {
  const cmd = String(command == null ? "" : command);
  if (!/\b(?:curl|wget)\b/i.test(cmd)) return null;
  const isDelete =
    /(?:-X|--request)[=\s]+["']?DELETE\b/i.test(cmd) ||
    /-X["']?DELETE\b/i.test(cmd) ||
    /--method[=\s]+["']?DELETE\b/i.test(cmd);
  if (!isDelete) return null;
  const irreversible = hasPurge(cmd);

  // Whole-history delete wins (most severe): a bare /api/histories/{id} -- one NOT followed
  // by a sub-resource path. The lookahead requires a query/space/quote/end after the id, so
  // the history prefix of a /contents/... URL does not match here.
  const wholeHistory = cmd.match(/\/api\/histories\/([^/\s"'?]+)(?=[?\s"']|$)/);
  if (wholeHistory) {
    /** @type {GalaxyDestructiveOp} */
    const op = { kind: irreversible ? "history-purge" : "history-delete", irreversible };
    const id = literalId(wholeHistory[1]);
    if (id) op.historyId = id;
    return op;
  }

  // A dataset COLLECTION (a recursive container -- understating it would be dishonest):
  // /api/histories/{hid}/contents/dataset_collections/{cid}.
  const coll = cmd.match(
    /\/api\/histories\/[^/\s"'?]+\/contents\/dataset_collections\/([^/\s"'?]+)/,
  );
  if (coll) {
    /** @type {GalaxyDestructiveOp} */
    const op = { kind: irreversible ? "collection-purge" : "collection-delete", irreversible };
    const id = literalId(coll[1]);
    if (id) op.collectionId = id;
    return op;
  }

  // A single dataset: in-history contents (legacy /contents/{id} or typed
  // /contents/datasets/{id}) or the top-level singleton/batch /api/datasets[/{id}] routes.
  const inHistory = cmd.match(/\/api\/histories\/[^/\s"'?]+\/contents\/(?:datasets\/)?([^/\s"'?]+)/);
  const singleton = inHistory ? null : cmd.match(/\/api\/datasets\/([^/\s"'?]+)/);
  const batch = inHistory || singleton ? false : /\/api\/datasets(?=[?\s"']|$)/.test(cmd);
  if (inHistory || singleton || batch) {
    /** @type {GalaxyDestructiveOp} */
    const op = { kind: irreversible ? "dataset-purge" : "dataset-delete", irreversible };
    const id = literalId(inHistory ? inHistory[1] : singleton ? singleton[1] : undefined);
    if (id) op.datasetId = id;
    return op;
  }

  return null;
}

/**
 * BEST-EFFORT guardrail for code mode: run_galaxy_tool(code=<python>) where the only callable
 * is call_tool(name, params). Flags a script that calls update_history with deleted/purge
 * true. Coarse by nature (arbitrary Python); over-detection just yields an extra confirm.
 * @param {unknown} code @returns {GalaxyDestructiveOp | null}
 */
function classifyCode(code) {
  const s = String(code == null ? "" : code);
  // Tolerate the tool name appearing as a positional or kwarg, with or without the
  // galaxy_ prefix: call_tool('update_history', ...) / call_tool(name="galaxy_update_history", ...).
  if (!/call_tool\([^)]*["'](?:galaxy_)?update_history["']/.test(s)) return null;
  const purge = hasPurge(s);
  if (!purge && !/["']?deleted["']?\s*[:=]\s*["']?true\b/i.test(s)) return null;
  /** @type {GalaxyDestructiveOp} */
  const op = {
    kind: purge ? "history-purge" : "history-delete",
    irreversible: purge,
  };
  const idm = s.match(/["']?history_id["']?\s*[:=]\s*["']([A-Za-z0-9]+)["']/);
  if (idm) op.historyId = idm[1];
  return op;
}
