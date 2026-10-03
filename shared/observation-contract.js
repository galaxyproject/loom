// Shared observation wire contract (community knowledge loop, contract C1).
// Dual-file (.js runtime + .d.ts types) to match feedback-contract: the brain
// resolves a real .js at runtime, so a single .ts would risk a missing runtime
// file. No Node imports here -- this file is renderer-safe and is shared by the
// brain, Orbit, and (by verbatim copy) the orbit-feedback Worker.
//
// normalizeSignature, LEAK_PATTERNS and validateObservation are security
// controls, not formatting helpers. They fail closed: a payload that trips a
// leak pattern is dropped, never "cleaned up and sent anyway". The Worker keeps
// a byte-compatible copy of the same regexes, so a change here is a change
// there.

export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVATIONS_ROUTE = "/observations";
// Same shared key as /feedback -- one secret per install, two routes.
export const OBSERVATION_KEY_HEADER = "X-Orbit-Feedback-Key";
export const RETRACT_TOKEN_HEADER = "X-Retract-Token";
export const OBSERVATIONS_ENDPOINT_URL = "https://orbit-feedback.dannon-baker.workers.dev";
// The Worker's body cap. Enforced client-side too so a doomed POST is never sent.
export const OBSERVATION_MAX_BYTES = 16 * 1024;

// Contract C7: the single source of truth for the public-server allowlist.
// Anything else is "private" -- an exact hostname match, never a suffix match,
// so an institutional mirror at galaxy.usegalaxy.org.example cannot pass.
export const PUBLIC_GALAXY_SERVERS = Object.freeze([
  "usegalaxy.org",
  "usegalaxy.eu",
  "usegalaxy.org.au",
  "usegalaxy.fr",
  "usegalaxy.no",
  "usegalaxy.cz",
  "test.galaxyproject.org",
]);
export const PRIVATE_SERVER = "private";

export const OBSERVATION_KINDS = Object.freeze([
  "tool-error",
  "retry-loop",
  "assertion-failed",
  "user-correction",
  "silent-wrong-result",
  "other",
]);
export const OBSERVATION_STAGES = Object.freeze([
  "data-acquisition",
  "metadata-reconciliation",
  "tool-parameterization",
  "job-execution",
  "result-interpretation",
  "unknown",
]);
export const OBSERVATION_TRIGGERS = Object.freeze([
  "tool_error",
  "retry_loop",
  "assertion",
  "user_correction",
  "explicit",
]);
export const OBSERVATION_APPS = Object.freeze(["orbit", "loom-cli"]);
export const OBSERVATION_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);

export const SIGNATURE_MAX = 200;
export const DESCRIPTION_MAX = 500;
export const TOOLS_MAX = 5;
export const TOOL_ID_MAX = 200;
export const TOOL_VERSION_MAX = 40;
export const MCP_TOOL_MAX = 80;
export const DATATYPES_MAX = 5;
export const DATATYPE_MAX = 40;
export const VERSION_MAX = 40;

// `signature` is half the intake route's cluster key, so it is never empty.
// Normalization can legitimately reduce a line to nothing (a line that was only
// a path, or only an id); the builder substitutes this instead of shipping a
// payload the intake route would refuse.
export const UNKNOWN_SIGNATURE = "unknown";

// Locked order. The lesson validator and the lesson matcher reuse this exact
// sequence, so a change here is a change to the shared contract first.
//
// URL before path is the reason the order is written down at all: paths-first
// turned `https://host/a/b` into `https:<path>`, which left the scheme behind
// and slipped past the validator's https?:// check.
//
// Deliberately NOT here: a rewrite for the crude
// hid/dataset/history-followed-by-a-number shape, and one for non-ASCII. The
// validator rejects both, so a line carrying either is DROPPED rather than
// reshaped. That loses some legitimate signal (a Galaxy message about a
// two-digit hid, a non-English message) and it is the fail-closed direction.
const NORMALIZERS = Object.freeze([
  [/https?:\/\/\S+/g, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // Two separators required, so ordinary prose ("and/or") is not read as a
  // path. A single-segment absolute path like /etc is not identifying.
  [/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g, "<path>"],
  [/[0-9a-fA-F]{16,}/g, "<id>"],
  [/\d{5,}/g, "<n>"],
]);

/** The line normalizeSignature reads, before any rewrite or cap. */
export function rawSignatureLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSignature(text) {
  let s = rawSignatureLine(text);
  for (const [re, repl] of NORMALIZERS) s = s.replace(re, repl);
  // Plain slice: appending an ellipsis would make the result non-ASCII and the
  // validator would then reject every truncated signature.
  s = s.slice(0, SIGNATURE_MAX).trim();
  // The intake route clusters on (kind, signature), so empty is not a legal
  // value. One owner of the fallback, here rather than in each caller.
  return s || UNKNOWN_SIGNATURE;
}

// Client rules NOT run at the early stage, because the later rewrites remove
// what they match whole rather than mutilating it: a rooted path becomes
// <path>, and an id phrase's long number becomes <id> or <n>. A relative path
// or a short id number survives those rewrites and is caught at the full-table
// stage. Running them early would withhold nearly every real Galaxy error.
const EARLY_STAGE_SKIP = new Set(["path-separator", "id-phrase"]);

/**
 * The staged leak scan for a signature, as pattern names (empty when clean).
 * Each shape is scanned while it is still intact, so no rewrite can hide one:
 *
 *   1. apply the <url> and <email> rewrites, which consume a whole token and
 *      can't create or hide another shape;
 *   2. run the client table over that text -- the shapes the <path>, <id> and
 *      <n> rewrites could erase or mutilate (galaxyprod:12345 -> galaxyprod:<n>,
 *      a UUID losing its first block to <n>);
 *   3. apply the rest, then run the full table over the normalized text before
 *      the length cap, so a host cut mid-label at the cap is still seen.
 *
 * The final capped value is scanned again with the rest of the payload by
 * scanObservationForLeaks.
 */
export function signatureStageLeaks(text) {
  let s = rawSignatureLine(text);
  for (const [re, repl] of NORMALIZERS.slice(0, 2)) s = s.replace(re, repl);
  const hits = [];
  for (const [name, re] of CLIENT_LEAK_PATTERNS) {
    if (!EARLY_STAGE_SKIP.has(name) && re.test(s)) hits.push(name);
  }
  for (const [re, repl] of NORMALIZERS.slice(2)) s = s.replace(re, repl);
  hits.push(...textLeaks(s));
  return [...new Set(hits)];
}

// The leak table. No `g` flags: `test()` on a global regex is stateful and
// would skip every other call. Names are the error suffix the validator
// reports, so a 400 from the Worker still never echoes a value.
export const LEAK_PATTERNS = Object.freeze([
  Object.freeze(["url", /https?:\/\//i]),
  Object.freeze(["home-path", /\/Users\/|\/home\//i]),
  Object.freeze(["windows-path", /[A-Za-z]:[\\/]/]),
  Object.freeze(["tilde-path", /~[\\/]/]),
  Object.freeze(["long-hex", /[0-9a-fA-F]{16,}/]),
  Object.freeze(["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/]),
  // Crude but cheap, per C1: a Galaxy id phrase followed by a number.
  Object.freeze(["galaxy-id-phrase", /\b(?:history|dataset|hid)\b[^A-Za-z0-9]{0,4}\d/i]),
  Object.freeze(["non-ascii", /[^\x20-\x7E]/]),
]);

const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "clientTs",
  "client",
  "installToken",
  "kind",
  "stage",
  "trigger",
  "tools",
  "mcpTool",
  "datatypes",
  "signature",
  "galaxy",
  "description",
]);
const CLIENT_KEYS = new Set(["app", "version", "platform", "wsl"]);
const GALAXY_KEYS = new Set(["version", "server"]);
const TOOL_KEYS = new Set(["id", "version"]);

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INSTALL_TOKEN_RE = /^[0-9a-f]{32}$/;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// An unknown key is named in the error only when it looks like an identifier.
// Anything else is reported as <unknown>, the same string the intake Worker
// uses, so the error lists stay diffable and a key can't smuggle a value into
// an error message.
const REPORTABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function pushUnknownKeys(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) continue;
    const name = REPORTABLE_KEY_RE.test(k) ? k : "<unknown>";
    errors.push(`${prefix ? prefix + "." : ""}${name}:unknown-key`);
  }
}

function badString(v, max, { allowEmpty = false } = {}) {
  if (typeof v !== "string") return true;
  if (!allowEmpty && v.length === 0) return true;
  return v.length > max;
}

const NON_ASCII_RE = /[^\x20-\x7E]/;

/** Every string in `value`, at any depth, that matches `re`, as `path:name`. */
function scanStrings(value, re, name, path = "", hits = []) {
  if (typeof value === "string") {
    if (path !== "installToken" && re.test(value)) hits.push(`${path}:${name}`);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, re, name, `${path}[${i}]`, hits));
    return hits;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      scanStrings(v, re, name, path ? `${path}.${k}` : k, hits);
    }
  }
  return hits;
}

export function validateObservation(obj) {
  if (!isPlainObject(obj)) return { ok: false, errors: ["observation:not-an-object"] };
  const o = obj;
  const errors = [];

  pushUnknownKeys(o, TOP_KEYS, "", errors);
  if (o.schemaVersion !== OBSERVATION_SCHEMA_VERSION) errors.push("schemaVersion:unsupported");
  if (typeof o.id !== "string" || !UUID_V4_RE.test(o.id)) errors.push("id:not-a-uuid-v4");
  if (typeof o.clientTs !== "string" || !ISO_TS_RE.test(o.clientTs)) {
    errors.push("clientTs:not-iso-8601");
  }

  if (!isPlainObject(o.client)) {
    errors.push("client:not-an-object");
  } else {
    const c = o.client;
    pushUnknownKeys(c, CLIENT_KEYS, "client", errors);
    if (!OBSERVATION_APPS.includes(c.app)) errors.push("client.app:not-allowed");
    if (badString(c.version, VERSION_MAX)) errors.push("client.version:bad-length");
    if (!OBSERVATION_PLATFORMS.includes(c.platform)) errors.push("client.platform:not-allowed");
    if (c.wsl !== undefined && typeof c.wsl !== "boolean") errors.push("client.wsl:not-a-boolean");
  }

  if (typeof o.installToken !== "string" || !INSTALL_TOKEN_RE.test(o.installToken)) {
    errors.push("installToken:not-32-hex");
  }
  if (!OBSERVATION_KINDS.includes(o.kind)) errors.push("kind:not-allowed");
  if (!OBSERVATION_STAGES.includes(o.stage)) errors.push("stage:not-allowed");
  if (!OBSERVATION_TRIGGERS.includes(o.trigger)) errors.push("trigger:not-allowed");

  if (!Array.isArray(o.tools)) {
    errors.push("tools:not-an-array");
  } else if (o.tools.length > TOOLS_MAX) {
    errors.push("tools:too-many");
  } else {
    o.tools.forEach((t, i) => {
      if (!isPlainObject(t)) {
        errors.push(`tools[${i}]:not-an-object`);
        return;
      }
      pushUnknownKeys(t, TOOL_KEYS, `tools[${i}]`, errors);
      if (badString(t.id, TOOL_ID_MAX)) errors.push(`tools[${i}].id:bad-length`);
      if (t.version !== undefined && badString(t.version, TOOL_VERSION_MAX)) {
        errors.push(`tools[${i}].version:bad-length`);
      }
    });
  }

  if (o.mcpTool !== undefined && badString(o.mcpTool, MCP_TOOL_MAX)) {
    errors.push("mcpTool:bad-length");
  }

  if (!Array.isArray(o.datatypes)) {
    errors.push("datatypes:not-an-array");
  } else if (o.datatypes.length > DATATYPES_MAX) {
    errors.push("datatypes:too-many");
  } else {
    o.datatypes.forEach((d, i) => {
      if (badString(d, DATATYPE_MAX)) errors.push(`datatypes[${i}]:bad-length`);
    });
  }

  if (badString(o.signature, SIGNATURE_MAX)) errors.push("signature:bad-length");
  if (badString(o.description, DESCRIPTION_MAX, { allowEmpty: true })) {
    errors.push("description:bad-length");
  }

  if (!isPlainObject(o.galaxy)) {
    errors.push("galaxy:not-an-object");
  } else {
    const g = o.galaxy;
    pushUnknownKeys(g, GALAXY_KEYS, "galaxy", errors);
    const serverOk =
      typeof g.server === "string" &&
      (PUBLIC_GALAXY_SERVERS.includes(g.server) || g.server === PRIVATE_SERVER);
    if (!serverOk) errors.push("galaxy.server:not-allowed");
    if (g.version !== undefined && badString(g.version, VERSION_MAX)) {
      errors.push("galaxy.version:bad-length");
    }
  }

  // The two free-text fields carry the leak risk, so they get the full table.
  for (const field of ["signature", "description"]) {
    const value = o[field];
    if (typeof value !== "string") continue;
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(value)) errors.push(`${field}:${name}`);
    }
  }

  // EVERY string is printable ASCII, not just the free-text pair. Tool ids and
  // datatypes arrive from model-authored arguments, so the structured half
  // needs the same floor. Only the ASCII rule is applied here -- the rest of
  // the table would be wrong for a field like a toolshed path. installToken is
  // skipped for the same reason as in scanObservationForLeaks.
  for (const hit of scanStrings(o, NON_ASCII_RE, "non-ascii")) {
    if (!errors.includes(hit)) errors.push(hit);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Client-side only, on top of LEAK_PATTERNS, and deliberately NOT part of the
// wire validator the intake Worker mirrors: these are the shapes the contract
// table lets through that still name a machine, a person or a record. They run
// over every string in the payload (scanObservationForLeaks) and, staged, over
// the error line the signature came from (signatureStageLeaks). Structured fields are also admitted from
// allowlists in the builder, so for them this is the second line, not the
// first.
//
// Real top-level domains plus the usual private suffixes. A dotted run counts
// as a host only when its LAST label is one of these: that is what keeps
// `sample.fastq.gz`, `galaxy.tools.parameters.basic.ParameterValueError` and
// version numbers in, and it is also the rule's blind spot -- a host under a
// suffix not listed here (`galaxy.inrae`) gets through.
const HOST_SUFFIXES = [
  // generic
  "com|org|net|edu|gov|mil|int|info|biz|name|pro|io|ai|co|app|dev|cloud|bio|science|tech",
  "online|site|xyz|me|tv|cc|ws|eus|cat|asia|museum",
  // country codes in common research use
  "us|uk|de|fr|eu|au|nz|ca|ch|at|be|nl|lu|se|no|dk|fi|is|ie|cz|sk|pl|hu|si|hr|rs|ro|bg|gr|pt|es|it",
  "ee|lv|lt|ua|ru|tr|il|za|eg|ng|ke|in|cn|jp|kr|tw|hk|sg|my|th|vn|id|ph|br|ar|cl|mx|co|pe|uy",
  // private and reserved
  "internal|local|lan|corp|intranet|private|home|test|example|invalid|localhost|localdomain",
].join("|");
export const CLIENT_LEAK_PATTERNS = Object.freeze([
  // Bounded by "not a host character" rather than \b, so a host glued to a
  // word character (galaxy.cancer-center.org_backup) still counts.
  Object.freeze([
    "hostname",
    new RegExp(
      `(?<![A-Za-z0-9-])[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${HOST_SUFFIXES})(?![A-Za-z0-9-])`,
      "i",
    ),
  ]),
  // A single-label host with a port: galaxyprod:8080, galaxy_prod:8080 (a
  // Docker service name), localhost:80. Ports 80 and 443 by name, otherwise
  // four to six digits (six, because the early stage of the signature scan
  // sees the port before <n> does), so `line:42` and `HTTPError:400` stay
  // out.
  Object.freeze(["host-port", /(?<![\w-])[A-Za-z][\w-]*:(?:80|443|\d{4,6})\b/]),
  // Anything at anything: the contract's email rule needs a dotted domain, and
  // alice@localhost, alice@7node and alice@3lab don't have one.
  Object.freeze(["user-at-host", /[^\s@]@[A-Za-z0-9]/]),
  // No word boundaries: node_10.12.4.7, srv_192.168.17.42 and 10.0.0.5x are
  // still addresses.
  Object.freeze(["ipv4", /\d{1,3}(?:\.\d{1,3}){3}/]),
  Object.freeze([
    "ipv6",
    /\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\]|[0-9A-Fa-f]{0,4}::[0-9A-Fa-f]{0,4}|(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}/,
  ]),
  Object.freeze(["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i]),
  // Any scheme, not just http: s3://, gs://, ftp://, file://.
  Object.freeze(["scheme-url", /[A-Za-z][A-Za-z0-9+.-]*:\/\//]),
  // Any path separator at all. The normalizer turns a rooted path into
  // <path>, which has none, so what is left is a relative path, a one-segment
  // path (/Alice_Smith), the tail of a path with a space in it, or a UNC
  // share -- and from here none of them can be told apart from a name. The
  // cost, in the fail-closed direction: "and/or" and "400/500" refuse too.
  Object.freeze(["path-separator", /[\w-]*[\\/]|%2[Ff]|%5[Cc]/]),
  Object.freeze(["tilde-user", /~[A-Za-z_]/]),
  // The contract's id phrase misses `history_id=12`, `dataset id: 42`,
  // `histories 12 and 13` and other plurals. A bare job or invocation number
  // is left alone -- Galaxy's own messages say "Job 3 is in error state", and
  // a small decoded job number names nothing -- but one labelled as an id
  // (`invocation_id=73`, `job id 9`) is an id. "history number 12" and
  // "dataset no. 42" are the same phrase with a word in the way.
  Object.freeze([
    "id-phrase",
    /\b(?:histor(?:y|ies)|datasets?|hids?|collections?|hdas?|hdcas?)(?:[\s_-]?ids?)?\b[^A-Za-z0-9]{0,4}(?:(?:number|num|no)\b[^A-Za-z0-9]{0,4})?\d|\b(?:jobs?|invocations?|workflows?|users?)[\s_-]?ids?\b[^A-Za-z0-9]{0,4}\d/i,
  ]),
]);

/** Names of every leak pattern (contract and client-side) that `text` trips. */
export function textLeaks(text) {
  const hits = [];
  if (typeof text !== "string") return hits;
  for (const [name, re] of LEAK_PATTERNS) if (re.test(text)) hits.push(name);
  for (const [name, re] of CLIENT_LEAK_PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

// A public toolshed id is a host and a path by construction, so scanning it
// whole would always trip. Its host is fixed, and the segments after it are
// what the model wrote, so those are scanned one at a time instead.
const PUBLIC_TOOLSHED_PREFIX_RE =
  /^(?:toolshed\.g2\.bx\.psu\.edu|testtoolshed\.g2\.bx\.psu\.edu)\/repos\//;

/**
 * The strings in a payload that the leak table runs over, as [path, text]. A
 * few fields are exact-shape by contract and would trip a rule by design (a
 * UUID id, an ISO timestamp, an allowlisted server name, the 32-hex install
 * token); each is skipped only while it actually has that exact shape, so a
 * hostile value in one of them is still scanned.
 */
function scannableStrings(obs) {
  const out = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (path === "installToken" && INSTALL_TOKEN_RE.test(value)) return;
      if (path === "id" && UUID_V4_RE.test(value)) return;
      if (path === "clientTs" && ISO_TS_RE.test(value)) return;
      if (path === "galaxy.server" && PUBLIC_GALAXY_SERVERS.includes(value)) return;
      if (/^tools\[\d+\]\.id$/.test(path) && PUBLIC_TOOLSHED_PREFIX_RE.test(value)) {
        value
          .replace(PUBLIC_TOOLSHED_PREFIX_RE, "")
          .split("/")
          .forEach((seg, i) => out.push([`${path}/${i}`, seg]));
        return;
      }
      out.push([path, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(obs, "");
  return out;
}

/**
 * Run the whole leak table -- the contract's and the client-side one -- over
 * EVERY string in the payload, at any depth. Structured fields are admitted
 * from allowlists upstream, so on a builder-made payload this comes back
 * empty; when it does not, the caller drops the observation. Hits are
 * `path:pattern`; a hit in a toolshed id segment is reported against the id.
 */
export function scanObservationForLeaks(obs) {
  const hits = [];
  for (const [path, text] of scannableStrings(obs)) {
    for (const name of textLeaks(text)) hits.push(`${path.replace(/\/\d+$/, "")}:${name}`);
  }
  return [...new Set(hits)];
}

function sliceOr(v, max, fallback) {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}

/**
 * Coerce a built observation into the contract's shape and caps. Pair with
 * validateObservation: cap first ("make it fit"), then validate ("is it
 * legal"). Truncation is a plain slice -- an ellipsis character would make the
 * field non-ASCII and the validator would reject it.
 */
export function capObservation(obs) {
  const o = isPlainObject(obs) ? obs : {};
  const client = isPlainObject(o.client) ? o.client : {};
  const galaxy = isPlainObject(o.galaxy) ? o.galaxy : {};
  const tools = (Array.isArray(o.tools) ? o.tools : [])
    .slice(0, TOOLS_MAX)
    .map((t) => {
      const src = isPlainObject(t) ? t : {};
      const version = sliceOr(src.version, TOOL_VERSION_MAX, "");
      return {
        id: sliceOr(src.id, TOOL_ID_MAX, ""),
        ...(version ? { version } : {}),
      };
    })
    .filter((t) => t.id.length > 0);
  const datatypes = (Array.isArray(o.datatypes) ? o.datatypes : [])
    .slice(0, DATATYPES_MAX)
    .map((d) => sliceOr(d, DATATYPE_MAX, ""))
    .filter((d) => d.length > 0);
  const mcpTool = sliceOr(o.mcpTool, MCP_TOOL_MAX, "");
  const galaxyVersion = sliceOr(galaxy.version, VERSION_MAX, "");

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: o.id,
    clientTs: o.clientTs,
    client: {
      app: client.app,
      version: sliceOr(client.version, VERSION_MAX, ""),
      platform: client.platform,
      ...(client.wsl === true ? { wsl: true } : {}),
    },
    installToken: o.installToken,
    kind: o.kind,
    stage: o.stage,
    trigger: o.trigger,
    tools,
    ...(mcpTool ? { mcpTool } : {}),
    datatypes,
    signature: sliceOr(o.signature, SIGNATURE_MAX, ""),
    galaxy: {
      server: galaxy.server,
      ...(galaxyVersion ? { version: galaxyVersion } : {}),
    },
    description: sliceOr(o.description, DESCRIPTION_MAX, ""),
  };
}

const textEncoder = new TextEncoder();

export function observationByteLength(obs) {
  try {
    return textEncoder.encode(JSON.stringify(obs)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
