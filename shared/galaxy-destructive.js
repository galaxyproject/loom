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
 * @typedef {{ kind: "history-delete" | "history-purge", historyId?: string, irreversible: boolean }} GalaxyDestructiveOp
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

// A `purge`/`purged` flag set true, in a URL query (?purge=true) or a JSON/body/kwarg field
// ("purge": true / purge=true / 'purged': True / "purge": "true"). Case-insensitive (so
// Python `True` matches) and tolerant of a quoted boolean value (JSON-string / coerced bool).
/** @param {string} s @returns {boolean} */
function hasPurge(s) {
  return /[?&]purged?=true\b/i.test(s) || /["']?purged?["']?\s*[:=]\s*["']?true\b/i.test(s);
}

// A clean literal id only -- never surface a shell variable / interpolation as the "id".
/** @param {string | undefined} raw @returns {string | undefined} */
function literalId(raw) {
  return raw && /^[A-Za-z0-9]+$/.test(raw) ? raw : undefined;
}

/**
 * BEST-EFFORT guardrail for the raw-bash path: an HTTP DELETE issued by curl/wget against a
 * whole Galaxy history (`/api/histories/{id}`, NOT a dataset-level `/contents/` sub-path).
 * Reversibility is read from a purge flag in the query or the request body. Requires an
 * actual curl/wget verb so a stray URL in `echo`/text doesn't trip it; the history id is
 * surfaced only when it's a literal (a `$VAR` is matched but not echoed as a fake id).
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
  // Dataset-level deletes (/api/histories/{id}/contents/{dsid}) are out of v1 scope --
  // do not claim "entire history" for them.
  if (/\/api\/histories\/[^/\s"'?]+\/contents\//.test(cmd)) return null;
  const m = cmd.match(/\/api\/histories\/([^/\s"'?]+)/);
  if (!m) return null;
  const irreversible = hasPurge(cmd);
  /** @type {GalaxyDestructiveOp} */
  const op = { kind: irreversible ? "history-purge" : "history-delete", irreversible };
  const id = literalId(m[1]);
  if (id) op.historyId = id;
  return op;
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
