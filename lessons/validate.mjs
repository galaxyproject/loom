#!/usr/bin/env node
/**
 * Schema validator for the `lessons/` corpus. The rules here ARE the schema.
 *
 *   node lessons/validate.mjs           # validate lessons/
 *   node lessons/validate.mjs <dir>     # validate some other corpus (the tests do)
 *
 * Exit 0 when clean; exit 1 with one `path:line: message` line per violation.
 *
 * Plain Node plus `yaml` and `marked` (both runtime dependencies: this ships
 * and checks user-local lessons too). Nothing from `extensions/`, so this runs
 * before anything is built and can be imported by a plain `.mjs` script.
 *
 * Every bound below is a content control rather than a tidiness preference. A
 * lesson ships inside the package to every install, and the published snapshot
 * goes into a public index, so a lesson must not carry anything to follow (no
 * URLs, links, images, HTML or character references, judged by a real markdown
 * parser rather than line regexes), anything to run (no code blocks), or
 * anything identifying (no paths, hostnames, hex ids, uuids, IPs, email
 * addresses or credential shapes anywhere, and no URLs outside the fields the
 * schema says may hold a link, which take https to an allowed host only).
 * These are shape checks, not meaning checks: a private hostname written as
 * prose, a person's name, a copied data value or an instruction aimed at the
 * model still needs a human reviewer.
 */

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Lexer, marked } from "marked";
import { isAlias, parseDocument, visit } from "yaml";

export const LESSONS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `galaxy-api` holds lessons that graduated upstream and are kept unsurfaced. */
export const NAMESPACES = ["stats", "reproduction", "data", "galaxy-tools", "galaxy-api"];
export const STATUSES = ["draft", "stable", "deprecated"];
export const KINDS = ["pitfall", "expectation", "choice", "source-quirk", "reproduction"];
export const STAGES = [
  "data-acquisition",
  "metadata-reconciliation",
  "tool-parameterization",
  "job-execution",
  "result-interpretation",
];
export const EVIDENCE = {
  symptom: ["verified", "reported"],
  cause: ["verified", "hypothesized", "unknown"],
  outcome: ["validated", "unvalidated"],
};

export const REQUIRED_KEYS = [
  "type",
  "title",
  "description",
  "tags",
  "status",
  "generated",
  "stale_after",
  "sources",
  "kind",
  "stage",
  "trigger",
  "cues",
  "applies_to",
  "evidence",
  "graduated_to",
  "upstream",
  "supersedes",
];
export const OPTIONAL_KEYS = ["verified"];

export const TRIGGER_KEYS = [
  "signatures",
  "tools",
  "mcp_tools",
  "formats",
  "hosts",
  "extensions",
  "step_keywords",
];

/** The body's six sections, in the order they must appear. */
export const SECTIONS = [
  { heading: "## Symptom", key: "symptom", required: true },
  { heading: "## Cause", key: "cause", required: false },
  { heading: "## Check first", key: "check_first", required: true },
  { heading: "## Intervention", key: "intervention", required: true },
  { heading: "## Validate", key: "validate", required: true },
  { heading: "## Does NOT apply when", key: "not_when", required: true },
];

export const LIMITS = {
  slug: 80,
  title: 120,
  description: 200,
  tag: 40,
  cues: 300,
  signature: 200,
  tool: 200,
  mcpTool: 80,
  format: 40,
  host: 100,
  extension: 20,
  stepKeyword: 40,
  appliesTo: 200,
  method: 300,
  sourceId: 100,
  sourceText: 200,
  freeText: 200,
  section: 600,
  listItems: 20,
  minSignature: 8,
  fileBytes: 16384,
};

export const UNKNOWN_SIGNATURE = "unknown";

/**
 * The signature normalizer, in the locked order: url, email, path, id, n, then
 * truncate, then the empty fallback. The observation contract in `shared/`
 * holds the same table. It is duplicated rather than imported because this
 * script must run with nothing from the brain, and a lesson's signatures and a
 * tool result's signature have to normalize byte for byte the same or the
 * matcher never fires. Change both together.
 *
 * URL before path matters: the other way round, the path rule eats a URL's
 * `//host/a/b` and leaves an `https:` stub behind.
 */
const NORMALIZERS = Object.freeze([
  [/https?:\/\/\S+/g, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // Two separators required, so ordinary prose ("and/or") is not read as a
  // path. A single-segment absolute path like /etc is not identifying.
  [/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g, "<path>"],
  [/[0-9a-fA-F]{16,}/g, "<id>"],
  [/\d{5,}/g, "<n>"],
]);

export function normalizeSignature(text) {
  let s = String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, repl] of NORMALIZERS) s = s.replace(re, repl);
  s = s.slice(0, LIMITS.signature).trim();
  return s || UNKNOWN_SIGNATURE;
}

/**
 * Hosts a link field may point at. A link is provenance for a reviewer to
 * follow, so it goes to the project's own sites or to the public repositories
 * the lessons already name as trigger hosts, and nowhere else: an arbitrary
 * host is itself identifying (an internal Galaxy, a lab's file server) and can
 * carry anything in its path. Exact hostnames, no wildcard subdomains. To add
 * one, add it here and say why in the pull request.
 */
export const LINK_HOSTS = Object.freeze([
  "github.com",
  "galaxyproject.org",
  "docs.galaxyproject.org",
  "help.galaxyproject.org",
  "training.galaxyproject.org",
  "doi.org",
  "zenodo.org",
  "figshare.com",
  "journals.plos.org",
  "static-content.springer.com",
  "www.ncbi.nlm.nih.gov",
]);

/** Fields C3 allows to carry a link. Everything else in a lesson may not. */
const LINK_FIELDS = ["graduated_to", "upstream", "sources.resource"];

/**
 * Credential shapes from the provider-key list. Not anchored at a word
 * boundary on the left because `_` is a word character and `node_sk-...` would
 * slip past; the lookbehind only stops `disk-quota-...` reading as `sk-`.
 */
const CREDENTIALS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

// Pseudonyms in generated.by and verified.by have their own strict pattern.
const AUTHOR = /^(?:agent|human):[A-Za-z0-9._/@-]{1,80}$/;

// Schemes that are a link whatever follows them. Any other `word:` is only a
// scheme when what follows looks like a host or an address, because `word:`
// is also an R interaction term (`batch:condition`), a Galaxy collection type
// (`list:paired`) and a slice (`arr[i:j]`).
const SCHEMES =
  "https?|s?ftps?|mailto|file|data|javascript|vbscript|ssh|git|svn|s3|gs|hdfs|tel|sms|callto|wss?|irc|ldap|smb|nfs|telnet|gopher|news|nntp|blob|about|chrome|view-source|jar|magnet|xmpp|sip|urn|rtsp|webcal|feed|intent|ms-[a-z-]+";
const KNOWN_SCHEME = new RegExp(`(?<![A-Za-z0-9+.-])(?:${SCHEMES}):(?=\\S)`, "i");

function hasScheme(text) {
  if (KNOWN_SCHEME.test(text)) return true;
  // The lookbehind pins each match to the start of a word, which keeps this
  // linear on a long run of letters.
  const re = /(?<![A-Za-z0-9+.:-])[A-Za-z][A-Za-z0-9+.-]*:(?!:)(\S*)/g;
  for (const m of text.matchAll(re)) {
    if (AUTHOR.test(m[0].replace(/[`'"),.;\]}>]+$/, ""))) continue;
    if (/[@%]|[A-Za-z0-9-]\.[A-Za-z]{2,}/.test(m[1])) return true;
  }
  return false;
}

// Top-level domains that mean a network name rather than a file extension:
// `.gz`, `.md`, `.ts`, `.sh`, `.py` and friends are country codes too, and
// lessons talk about files all the time. A host on a TLD not listed here gets
// past; this is a shape check.
const PRIVATE_TLDS =
  "internal|local|localdomain|lan|corp|intranet|private|home|arpa|example|test|invalid|localhost";
const TLDS = `com|org|net|edu|gov|mil|int|io|dev|cloud|info|biz|ai|co|ly|xyz|us|app|ru|me|tv|cc|gg|site|online|tech|top|ws|to|${PRIVATE_TLDS}|uk|de|fr|nl|ch|eu|ca|au|jp|cn|se|dk|fi|es|nz|br`;

const URL_SHAPES = ["a URL", "a hostname"];

/** An IPv4 octet, and the four of them with nothing numeric on either side. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// The first octet is never 0: 0.0.0.0/8 identifies nothing, and four-part
// tool versions like 0.7.17.4 would otherwise read as addresses.
const IPV4 = new RegExp(
  `(?<![\\d.])(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?)(?:\\.${OCTET}){3}(?!\\.?\\d)`,
);

/**
 * Shapes that point at a person, a machine, a dataset or a credential. The
 * observation validator's list, minus its hid/dataset/history-followed-by-a-
 * number rule: lessons talk about hids in the abstract. Every unbounded
 * repetition is pinned to a word start with a lookbehind, so a 16 KB run of
 * letters costs one pass rather than one pass per character.
 */
const IDENTIFYING = [
  [
    "a URL",
    (s) =>
      // A scheme with slashes, a protocol-relative //host, www., a scheme-less
      // host/path, or a `scheme:` (`https:example.org` and `mailto:` both
      // resolve).
      /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:^|[^A-Za-z0-9:])\/\/[A-Za-z0-9]|(?<![A-Za-z0-9])www\.|(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/\S/i.test(
        s,
      ) || hasScheme(s),
  ],
  [
    "a hostname",
    new RegExp(`(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\\.)+(?:${TLDS})(?![A-Za-z0-9-])`, "i"),
  ],
  [
    "a home-directory path",
    /\/(?:Users|home|root)\/|~[A-Za-z0-9._-]*[\\/]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/]/i,
  ],
  // Any lead-in that is not itself part of a word or a relative path (`./`,
  // `../`, `a/b`), and any segment characters at all: `/data@lab/` is a path.
  ["an absolute path", /(?:^|[^A-Za-z0-9_~/.])\/[^\s/\\]+\/[^\s/]/],
  [
    "a Windows path",
    /\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9.-]+\\|(?:^|[^A-Za-z0-9_\\])\\[^\s\\]+\\[^\s\\]/,
  ],
  ["a hex id of 16+ characters", /[0-9a-fA-F]{16,}/],
  ["a uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  [
    "an IP address",
    (s) =>
      IPV4.test(s) ||
      // The full form, then the `::` forms. Nothing word-like or `[` may hug
      // a `::`, so `dplyr::filter`, `base::c()`, `std::vector` and `x[::2]`
      // stay prose; `_` may, so `node_2001:db8::1` is still an address.
      /(?<![0-9A-Za-z:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![0-9A-Za-z:])/i.test(s) ||
      /(?<![0-9A-Za-z:[])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)(?![A-Za-z0-9_:(\]])/i.test(
        s,
      ),
  ],
  // Anything@domain, quoted local parts included.
  [
    "an email address",
    /(?<![A-Za-z0-9._%+"-])[A-Za-z0-9._%+"-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  ],
  ["a credential-shaped string", (s) => CREDENTIALS.some((re) => re.test(s))],
];

/** Names of the identifying shapes in `text`, minus any in `skip`. */
function shapesIn(text, skip = []) {
  const s = String(text ?? "");
  const out = [];
  for (const [name, test] of IDENTIFYING) {
    if (skip.includes(name)) continue;
    if (typeof test === "function" ? test(s) : test.test(s)) out.push(name);
  }
  return out;
}

/**
 * Identifying-data problems in one string. Exported so the local-lesson rules
 * use this table rather than a copy of it. Each problem reads `<where>
 * contains <shape>; lessons carry none`.
 */
export function identifyingProblems(text, where) {
  if (tooLongToCheck(text)) return [`${where} is too long to check`];
  return shapesIn(text).map((shape) => `${where} contains ${shape}; lessons carry none`);
}

/**
 * Nothing in a lesson is longer than the file cap, and the parser and the
 * shape table both cost more than linear time on some inputs, so a longer
 * string is refused rather than checked.
 */
function tooLongToCheck(text) {
  return String(text ?? "").length > LIMITS.fileBytes;
}

/** A string that is, or carries, a URL or a hostname. */
function looksLikeLink(text) {
  return shapesIn(text).some((name) => URL_SHAPES.includes(name));
}

/**
 * Problems with a link in a field that may hold one. The raw string is what
 * ships, so it is judged as written: canonical https to an allowed host, no
 * port, credentials, query, fragment, percent-escapes or dot segments, and the
 * whole string still gets the identifying table. The absolute-path rule is
 * left out because every URL path is one; the host allowlist bounds where a
 * path can point instead.
 */
export function linkProblems(link, where) {
  const raw = String(link ?? "");
  const out = [];
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || /\s/.test(raw)) {
    out.push(`${where} is not a single URL`);
  } else {
    if (url.protocol !== "https:") out.push(`${where} is a non-https URL`);
    if (url.username || url.password) out.push(`${where} has credentials in a URL`);
    if (url.port) out.push(`${where} has a port in a URL`);
    if (/[?#]/.test(raw)) out.push(`${where} has a query or fragment in a URL`);
    // Messages never echo the host or the path: a refused link is exactly
    // the text that must not reach a log.
    if (url.protocol === "https:" && !LINK_HOSTS.includes(url.hostname)) {
      out.push(`${where} links to a host that is not in LINK_HOSTS`);
    }
    // The origin-only form is the one difference new URL() is allowed to make.
    if (url.href !== raw && url.href !== `${raw}/`) {
      out.push(
        `${where} is not a canonical URL (lowercase host, no default port, no dot segments)`,
      );
    }
    // A path is words, digits and separators. Anything else (`[`, `!`, `:`,
    // `@`, `<`) is how markup or an address rides along under an allowed host.
    if (!/^[A-Za-z0-9._~/+-]*$/.test(url.pathname)) {
      out.push(`${where} has a character in its path that a link does not need`);
    }
    // The host is pinned by the allowlist, so the path is what can still name
    // a machine; only the absolute-path rule is left out, since every URL path
    // is one.
    for (const shape of shapesIn(url.pathname, ["an absolute path"])) {
      out.push(`${where} contains ${shape} inside a URL path`);
    }
  }
  if (/%/.test(raw)) out.push(`${where} has a percent-escape in a URL`);
  if (/\\/.test(raw)) out.push(`${where} has a backslash in a URL`);
  if (/\.\./.test(raw)) out.push(`${where} has a dot segment in a URL`);
  for (const shape of shapesIn(raw, [...URL_SHAPES, "an absolute path"])) {
    out.push(`${where} contains ${shape} inside a URL`);
  }
  return out;
}

/**
 * What markdown a lesson may not contain, keyed by what a finding is called in
 * a message. `rule` reads as a refusal in a body message; `noun` reads after
 * "contains" in a field message.
 */
const MARKUP = {
  link: { rule: "no markdown links", noun: "a markdown link" },
  image: { rule: "no images", noun: "an image" },
  html: { rule: "no HTML", noun: "HTML" },
  def: { rule: "no markdown links", noun: "a link reference definition" },
  escape: { rule: "no backslash escapes", noun: "a backslash escape" },
  charref: { rule: "no character references", noun: "a character reference" },
  codespan: { rule: "no links or HTML inside a code span", noun: "a link or HTML in a code span" },
};

// `&#64;`, `&#x40;` and `&amp;`. Numeric ones without the semicolon too:
// browsers decode those in text.
const CHAR_REF = /&#[0-9]+;?|&#[xX][0-9A-Fa-f]+;?|&[A-Za-z][A-Za-z0-9]*;/;

// A code span may show a placeholder like `<collection id>`, but nothing a
// renderer that disagreed about where the span ends could turn into a live
// tag: no closing tags, comments, attribute values, quotes or schemes.
const INERT_PLACEHOLDER = /^<[A-Za-z][A-Za-z0-9 _-]*>$/;
// Elements that change how everything after them parses, or fetch something,
// even with no attributes. Never a placeholder.
const LIVE_ELEMENTS =
  /^<\s*(?:script|style|iframe|frame|frameset|object|embed|applet|plaintext|xmp|textarea|title|noscript|noembed|noframes|svg|math|base|link|meta|form|input|button|img|image|video|audio|source|track|picture|template|portal|select|option|marquee)\b/i;
// What normalizeSignature writes. A stored signature carries these as text,
// so they are not HTML.
const NORMALIZER_PLACEHOLDERS = new Set(["<url>", "<email>", "<path>", "<id>", "<n>"]);

function inertPlaceholder(raw) {
  return INERT_PLACEHOLDER.test(raw) && !LIVE_ELEMENTS.test(raw);
}

function childTokens(token) {
  const out = [];
  if (Array.isArray(token.tokens)) out.push(...token.tokens);
  if (Array.isArray(token.items)) out.push(...token.items);
  if (token.type === "table") {
    for (const cell of token.header ?? []) out.push(...(cell.tokens ?? []));
    for (const row of token.rows ?? []) for (const cell of row) out.push(...(cell.tokens ?? []));
  }
  return out;
}

/**
 * Lex `text` and call `visit(token, offset)` for every token at every depth,
 * where `offset` is the token's position in `text` when its raw text can be
 * found there, and the enclosing block's when the lexer rewrote it (it strips
 * the `>` from blockquote contents, for one). Returns the lexer's output, or
 * undefined when the lexer threw.
 */
function walkTokens(text, visit) {
  let tokens;
  try {
    tokens = marked.lexer(text, { gfm: true });
  } catch {
    return undefined;
  }
  const walk = (list, base, depth) => {
    let cursor = base;
    for (const token of list) {
      const at = typeof token.raw === "string" ? text.indexOf(token.raw, cursor) : -1;
      const offset = at === -1 ? base : at;
      if (at !== -1) cursor = at + token.raw.length;
      visit(token, offset, depth);
      walk(childTokens(token), offset, depth + 1);
    }
  };
  walk(tokens, 0, 0);
  return tokens;
}

/** Every refused piece of markup in `text`, as `{ kind, offset }`. */
function markupFindings(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(CHAR_REF.source, "g"))) {
    out.push({ kind: "charref", offset: m.index });
  }
  const tokens = walkTokens(text, (token, offset) => {
    if (token.type === "html" && NORMALIZER_PLACEHOLDERS.has(token.raw)) return;
    if (["link", "image", "html", "def", "escape"].includes(token.type)) {
      out.push({ kind: token.type, offset });
    } else if (token.type === "codespan" && !inertCodeSpan(token.text)) {
      out.push({ kind: "codespan", offset });
    }
  });
  // Fail closed: text the parser cannot read is text nobody checked.
  if (!tokens) out.push({ kind: "html", offset: 0 });
  // A definition anywhere makes some `[label]` live. The walk sees it as a
  // def token wherever it sits; this is the backstop if a lexer version
  // records the definition without emitting one.
  else if (Object.keys(tokens.links ?? {}).length > 0 && !out.some((f) => f.kind === "def")) {
    out.push({ kind: "def", offset: 0 });
  }
  return out;
}

// Containers whose children are separate blocks rather than one run of text.
const BLOCK_CONTAINERS = new Set(["blockquote", "list", "list_item", "table"]);

/**
 * What a reader sees once `tokens` render: inline runs concatenated with no
 * separator, so `alice@exa**mple**.org` comes out as the address it is.
 */
function plainText(tokens, sep = "\n") {
  return tokens
    .map((t) => {
      const kids = childTokens(t);
      if (kids.length > 0) return plainText(kids, BLOCK_CONTAINERS.has(t.type) ? "\n" : "");
      return typeof t.text === "string" ? t.text : "";
    })
    .join(sep);
}

function inertCodeSpan(content) {
  let inner;
  try {
    inner = Lexer.lexInline(content, { gfm: true });
  } catch {
    return false;
  }
  const bad = (list) =>
    list.some(
      (t) =>
        t.type === "link" ||
        t.type === "image" ||
        (t.type === "html" && !inertPlaceholder(t.raw)) ||
        // A span inside a span is still read by some renderer as markup.
        (t.type === "codespan" && !inertCodeSpan(t.text)) ||
        bad(childTokens(t)),
    );
  return !bad(inner);
}

/**
 * Markup problems in one string, for any field or body. Exported so the
 * local-lesson rules apply the same parser instead of keeping regexes of their
 * own. Each problem reads `<where> contains <what>`.
 */
export function markupProblems(text, where) {
  if (tooLongToCheck(text)) return [`${where} is too long to check`];
  const kinds = [...new Set(markupFindings(String(text ?? "")).map((f) => f.kind))];
  return kinds.map((k) => `${where} contains ${MARKUP[k].noun}`);
}

/**
 * Parse frontmatter YAML strictly. Comments are refused because they ship in
 * the raw file and nothing else checks them; anchors, aliases and explicit tags
 * because a lesson has no use for them and each one is a way to make the
 * parsed value differ from what a reviewer reads.
 */
export function loadFrontmatter(fmText) {
  const doc = parseDocument(fmText, { uniqueKeys: true, prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map(
    (e) => `frontmatter is not valid YAML: ${e.message.split("\n")[0]}`,
  );
  let comments = Boolean(doc.commentBefore || doc.comment);
  let fancy = false;
  visit(doc, {
    Node(_, node) {
      if (node.commentBefore || node.comment) comments = true;
      if (isAlias(node) || node.anchor || node.tag) fancy = true;
    },
  });
  if (comments) problems.push("no YAML comments in frontmatter; they ship unchecked");
  if (fancy) problems.push("no YAML anchors, aliases or explicit tags in frontmatter");
  return { value: problems.length > 0 ? undefined : doc.toJS(), problems };
}

function eachString(value, label, visit) {
  if (typeof value === "string") visit(label, value);
  else if (Array.isArray(value)) value.forEach((v, i) => eachString(v, `${label}[${i}]`, visit));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) eachString(v, label ? `${label}.${k}` : k, visit);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain `YYYY-MM-DD` that is also a real calendar date. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * Split `---` frontmatter from the body. Line numbers are 1-based so a
 * violation can be clicked in an editor.
 */
export function splitFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return {
    fmText: lines.slice(1, end).join("\n"),
    fmLines: lines.slice(1, end),
    fmFirstLine: 2,
    body: lines.slice(end + 1).join("\n"),
    bodyFirstLine: end + 2,
  };
}

/** Line of the first frontmatter entry for `key`, at any nesting depth. */
function lineOfKey(split, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*:`);
  const i = split.fmLines.findIndex((line) => re.test(line));
  return i === -1 ? split.fmFirstLine : split.fmFirstLine + i;
}

/** Split the body on its headings. Returns what was found, not what is legal. */
export function parseSections(body, bodyFirstLine = 1) {
  const lines = body.split("\n");
  const found = [];
  const unexpected = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("#")) return;
    const spec = SECTIONS.find((s) => s.heading === line.trimEnd());
    if (spec) found.push({ spec, index: i, line: bodyFirstLine + i });
    else unexpected.push({ text: line, line: bodyFirstLine + i });
  });
  const sections = {};
  found.forEach((hit, n) => {
    const start = hit.index + 1;
    const end = n + 1 < found.length ? found[n + 1].index : lines.length;
    if (sections[hit.spec.key] !== undefined) return; // first wins; the dup is reported
    sections[hit.spec.key] = { text: lines.slice(start, end).join("\n").trim(), line: hit.line };
  });
  return { found, unexpected, sections };
}

/**
 * Parse a lesson that has already passed `validateLessonFile`. Throws on
 * anything the validator would have rejected, so the build can stay simple.
 */
export function parseLesson(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(text);
  if (!split) throw new Error("missing YAML frontmatter");
  const { value: frontmatter, problems } = loadFrontmatter(split.fmText);
  if (problems.length > 0) throw new Error(problems[0]);
  const { sections } = parseSections(split.body, split.bodyFirstLine);
  const out = {};
  for (const spec of SECTIONS) {
    if (sections[spec.key] !== undefined) out[spec.key] = sections[spec.key].text;
  }
  return { frontmatter, sections: out };
}

function checkStringList(add, line, label, value, { max, pattern, hint, maxItems }) {
  if (!Array.isArray(value)) {
    add(line, `${label} must be a list`);
    return;
  }
  const cap = maxItems ?? LIMITS.listItems;
  if (value.length > cap) add(line, `${label} has ${value.length} entries, max ${cap}`);
  value.forEach((item, i) => {
    const at = `${label}[${i}]`;
    if (typeof item !== "string") return add(line, `${at} must be a string`);
    if (item.length === 0) return add(line, `${at} is empty`);
    if (item.includes("\n")) return add(line, `${at} must be a single line`);
    if (item.length > max) return add(line, `${at} is ${item.length} chars, max ${max}`);
    if (pattern && !pattern.test(item)) add(line, `${at} ${hint} (got ${JSON.stringify(item)})`);
  });
}

function checkScalarString(add, line, label, value, { max, allowEmpty = false }) {
  if (typeof value !== "string") {
    add(line, `${label} must be a string`);
    return false;
  }
  if (!allowEmpty && value.trim().length === 0) {
    add(line, `${label} is empty`);
    return false;
  }
  if (value.includes("\n")) {
    add(line, `${label} must be a single line`);
    return false;
  }
  if (value.length > max) {
    add(line, `${label} is ${value.length} chars, max ${max}`);
    return false;
  }
  return true;
}

function checkEnum(add, line, label, value, allowed) {
  if (!allowed.includes(value)) {
    add(line, `${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function checkExactKeys(add, line, label, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    add(line, `${label} must be a mapping`);
    return false;
  }
  for (const k of keys) if (!(k in value)) add(line, `${label} is missing "${k}"`);
  for (const k of Object.keys(value)) {
    if (!keys.includes(k)) add(line, `${label} has unknown key "${k}"`);
  }
  return true;
}

function codepoint(ch) {
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Validate one lesson. `relPath` is `<namespace>/<slug>.md`. */
export function validateLessonFile(relPath, raw) {
  const rel = relPath.split(path.sep).join("/");
  const out = [];
  const add = (line, message) => out.push(`${rel}:${line}: ${message}`);
  const text = raw.replace(/\r\n/g, "\n");

  const parts = rel.split("/");
  if (parts.length !== 2) {
    add(1, "a lesson lives at lessons/<namespace>/<slug>.md");
  } else {
    const [ns, file] = parts;
    const slug = file.replace(/\.md$/, "");
    if (!NAMESPACES.includes(ns)) {
      add(1, `namespace must be one of ${NAMESPACES.join(", ")} (got ${JSON.stringify(ns)})`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      add(1, `slug must be lowercase words joined by hyphens (got ${JSON.stringify(slug)})`);
    }
    if (slug.length > LIMITS.slug) {
      add(1, `slug is ${slug.length} chars, max ${LIMITS.slug}`);
    }
  }

  // Printable ASCII only, everywhere. A smart quote or a Unicode em-dash in a
  // lesson reaches the model as whatever the consumer's encoding makes of it,
  // and the repo writes em-dashes as `--` anyway.
  if (Buffer.byteLength(raw, "utf8") > LIMITS.fileBytes) {
    add(1, `file is ${Buffer.byteLength(raw, "utf8")} bytes, max ${LIMITS.fileBytes}`);
    return out;
  }

  // Every one, not the first: a pasted paragraph usually brings several, and
  // fixing them one run at a time is how the last one gets missed.
  for (const odd of text.matchAll(/[^\t\n\x20-\x7e]/gu)) {
    const line = text.slice(0, odd.index).split("\n").length;
    // Reported as a codepoint: an em-dash, an en-dash and a non-breaking hyphen
    // are indistinguishable in a terminal and the fix differs for each.
    add(line, `non-ASCII character ${codepoint(odd[0])}; write em-dashes as --`);
  }

  const split = splitFrontmatter(text);
  if (!split) {
    add(1, "missing YAML frontmatter: the file must open with --- and close it with ---");
    return out;
  }

  // The raw lines too, so anything the parser drops is still held to the
  // identifying-data rules. URLs and hostnames are left to the parsed check
  // below, which knows which field may hold a link and which holds a host.
  split.fmLines.forEach((line, i) => {
    for (const shape of shapesIn(line, URL_SHAPES)) {
      add(split.fmFirstLine + i, `frontmatter line contains ${shape}; lessons carry none`);
    }
  });

  let fm;
  try {
    const loaded = loadFrontmatter(split.fmText);
    if (loaded.problems.length > 0) {
      for (const p of loaded.problems) add(split.fmFirstLine, p);
      return out;
    }
    fm = loaded.value;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    add(split.fmFirstLine, `frontmatter is not valid YAML: ${message}`);
    return out;
  }
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    add(split.fmFirstLine, "frontmatter must be a YAML mapping");
    return out;
  }

  const at = (key) => lineOfKey(split, key);
  for (const key of REQUIRED_KEYS) {
    if (!(key in fm)) add(split.fmFirstLine, `missing required frontmatter key "${key}"`);
  }
  for (const key of Object.keys(fm)) {
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
      add(at(key), `unknown frontmatter key "${key}"`);
    }
  }

  if ("type" in fm && fm.type !== "Lesson") {
    add(at("type"), `type must be exactly "Lesson" (got ${JSON.stringify(fm.type)})`);
  }
  if ("title" in fm) checkScalarString(add, at("title"), "title", fm.title, { max: LIMITS.title });
  if ("description" in fm) {
    checkScalarString(add, at("description"), "description", fm.description, {
      max: LIMITS.description,
    });
  }
  if ("tags" in fm) {
    checkStringList(add, at("tags"), "tags", fm.tags, { max: LIMITS.tag });
  }
  if ("status" in fm) checkEnum(add, at("status"), "status", fm.status, STATUSES);

  if (
    "generated" in fm &&
    checkExactKeys(add, at("generated"), "generated", fm.generated, ["by", "at"])
  ) {
    const line = at("generated");
    if (
      typeof fm.generated.by !== "string" ||
      !/^(?:agent|human):[A-Za-z0-9._/@-]{1,80}$/.test(fm.generated.by)
    ) {
      add(line, 'generated.by must look like "agent:loom/0.8.0" or "human:loom-maintainers"');
    }
    if (!isIsoDate(fm.generated.at)) add(line, "generated.at must be a YYYY-MM-DD date string");
  }

  if ("verified" in fm) {
    const line = at("verified");
    if (!Array.isArray(fm.verified)) add(line, "verified must be a list");
    else {
      if (fm.verified.length > LIMITS.listItems) {
        add(line, `verified has ${fm.verified.length} entries, max ${LIMITS.listItems}`);
      }
      fm.verified.forEach((entry, i) => {
        if (!checkExactKeys(add, line, `verified[${i}]`, entry, ["by", "at"])) return;
        // Maintainer pseudonyms only. A contributor id here would publish an
        // identity into the snapshot and the public index.
        if (typeof entry.by !== "string" || !/^human:[A-Za-z0-9._-]{1,60}$/.test(entry.by)) {
          add(line, `verified[${i}].by must look like "human:<pseudonym>"`);
        }
        if (!isIsoDate(entry.at)) add(line, `verified[${i}].at must be a YYYY-MM-DD date string`);
      });
    }
  }

  if ("stale_after" in fm && !isIsoDate(fm.stale_after)) {
    add(at("stale_after"), "stale_after must be a YYYY-MM-DD date string");
  }

  if ("sources" in fm) {
    const line = at("sources");
    if (!Array.isArray(fm.sources)) add(line, "sources must be a list");
    else {
      if (fm.sources.length > LIMITS.listItems) {
        add(line, `sources has ${fm.sources.length} entries, max ${LIMITS.listItems}`);
      }
      fm.sources.forEach((entry, i) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          add(line, `sources[${i}] must be a mapping with an id`);
          return;
        }
        for (const k of Object.keys(entry)) {
          if (!["id", "resource", "title"].includes(k)) {
            add(line, `sources[${i}] has unknown key "${k}"`);
          }
        }
        checkScalarString(add, line, `sources[${i}].id`, entry.id, { max: LIMITS.sourceId });
        for (const k of ["resource", "title"]) {
          if (entry[k] !== undefined) {
            checkScalarString(add, line, `sources[${i}].${k}`, entry[k], {
              max: LIMITS.sourceText,
            });
          }
        }
      });
    }
  }

  if ("kind" in fm) checkEnum(add, at("kind"), "kind", fm.kind, KINDS);

  if ("stage" in fm) {
    const line = at("stage");
    if (!Array.isArray(fm.stage) || fm.stage.length === 0) {
      add(line, "stage must be a non-empty list");
    } else {
      const seen = new Set();
      fm.stage.forEach((s, i) => {
        checkEnum(add, line, `stage[${i}]`, s, STAGES);
        if (seen.has(s)) add(line, `stage lists ${JSON.stringify(s)} twice`);
        seen.add(s);
      });
    }
  }

  if ("trigger" in fm && checkExactKeys(add, at("trigger"), "trigger", fm.trigger, TRIGGER_KEYS)) {
    const t = fm.trigger;
    const rules = {
      // A signature has to be stored the way the matcher will see it, so a
      // signature that normalization would change can never match anything.
      signatures: { max: LIMITS.signature },
      tools: {
        max: LIMITS.tool,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
        hint: "must be a Galaxy tool id or family",
      },
      mcp_tools: {
        max: LIMITS.mcpTool,
        pattern: /^galaxy_[a-z0-9_]+$/,
        hint: "must be a galaxy_* MCP tool name",
      },
      formats: {
        max: LIMITS.format,
        pattern: /^[a-z0-9][a-z0-9._-]*$/,
        hint: "must be a lowercase Galaxy datatype or extension name",
      },
      hosts: {
        max: LIMITS.host,
        pattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/,
        hint: "must be a bare hostname, no scheme and no path",
      },
      extensions: {
        max: LIMITS.extension,
        pattern: /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/,
        hint: "must be a lowercase dotted extension",
      },
      step_keywords: {
        max: LIMITS.stepKeyword,
        pattern: /^[a-z0-9][a-z0-9 '+./-]*$/,
        hint: "must be lowercase words matched against plan-step text",
      },
    };
    for (const key of TRIGGER_KEYS) {
      checkStringList(add, at(key), `trigger.${key}`, t[key], rules[key]);
    }
    if (Array.isArray(t.signatures)) {
      t.signatures.forEach((sig, i) => {
        if (typeof sig !== "string") return;
        const normalized = normalizeSignature(sig);
        if (sig === UNKNOWN_SIGNATURE || sig.length < LIMITS.minSignature) {
          add(
            at("signatures"),
            `trigger.signatures[${i}] is too generic to match on; quote the distinctive part of the error`,
          );
        }
        if (normalized !== sig) {
          add(
            at("signatures"),
            `trigger.signatures[${i}] is not normalized; store ${JSON.stringify(normalized)}`,
          );
        }
      });
    }
    const matchable = TRIGGER_KEYS.some((k) => Array.isArray(t[k]) && t[k].length > 0);
    if (!matchable) {
      add(
        at("trigger"),
        "trigger has nothing machine-matchable; a lesson nothing can match is documentation",
      );
    }
  }

  if ("cues" in fm) checkScalarString(add, at("cues"), "cues", fm.cues, { max: LIMITS.cues });

  if (
    "applies_to" in fm &&
    checkExactKeys(add, at("applies_to"), "applies_to", fm.applies_to, ["versions", "tested"])
  ) {
    for (const k of ["versions", "tested"]) {
      checkScalarString(add, at("applies_to"), `applies_to.${k}`, fm.applies_to[k], {
        max: LIMITS.appliesTo,
      });
    }
  }

  if (
    "evidence" in fm &&
    checkExactKeys(add, at("evidence"), "evidence", fm.evidence, [
      "symptom",
      "cause",
      "outcome",
      "method",
    ])
  ) {
    const line = at("evidence");
    for (const k of ["symptom", "cause", "outcome"]) {
      checkEnum(add, line, `evidence.${k}`, fm.evidence[k], EVIDENCE[k]);
    }
    checkScalarString(add, line, "evidence.method", fm.evidence.method, { max: LIMITS.method });
  }

  for (const key of ["graduated_to", "upstream"]) {
    if (key in fm) checkStringList(add, at(key), key, fm[key], { max: LIMITS.freeText });
  }
  if ("supersedes" in fm) {
    checkStringList(add, at("supersedes"), "supersedes", fm.supersedes, {
      max: LIMITS.sourceId,
      pattern: new RegExp(`^(?:${NAMESPACES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`),
      hint: "must be a lesson id like stats/na-coerced-to-zero-in-filters",
    });
  }

  // The namespace is the contract: galaxy-api is where lessons go once the
  // durable fix ships somewhere else, and `graduated_to` is what stops the
  // matcher surfacing them.
  if (parts[0] === "galaxy-api" && Array.isArray(fm.graduated_to) && fm.graduated_to.length === 0) {
    add(
      at("graduated_to"),
      "a galaxy-api lesson must say where the durable fix lives in graduated_to",
    );
  }

  // Every string, not just the prose fields: a title, a cue or a source id
  // reaches the snapshot and the public index exactly like the body does.
  eachString(fm, "", (label, value) => {
    // trigger's lists each have a line of their own; elsewhere the nested key
    // names repeat (`by` is in generated and in verified) so the parent's line
    // is the honest one.
    const [top, sub] = label.split(/[.[]/);
    const line = top === "trigger" && sub ? at(sub) : at(top);
    // The file-level ASCII check reads raw bytes, and a YAML escape like "\u202e"
    // is ASCII on disk. This is the check that sees the decoded value.
    for (const bad of value.matchAll(/[^\x20-\x7e]/gu)) {
      add(line, `${label} contains control or non-ASCII character ${codepoint(bad[0])}`);
    }
    const field = label.replace(/\[\d+\]/g, "");
    if (LINK_FIELDS.includes(field)) {
      // Free text is allowed here too ("galaxy-mcp#55"); only a string that
      // tries to be a link is held to the link rules.
      const problems = looksLikeLink(value)
        ? linkProblems(value, label)
        : [...identifyingProblems(value, label), ...markupProblems(value, label)];
      for (const p of problems) add(line, p);
      return;
    }
    if (field === "trigger.hosts") {
      // A host is the whole point of this field; its own pattern pins the
      // shape. A private one names somebody's network, so it never ships.
      for (const shape of shapesIn(value, URL_SHAPES)) {
        add(line, `${label} contains ${shape}; lessons carry none`);
      }
      if (new RegExp(`\\.(?:${PRIVATE_TLDS})$`, "i").test(value)) {
        add(line, `${label} is a private hostname; only public hosts go in a lesson`);
      }
      return;
    }
    for (const p of identifyingProblems(value, label)) add(line, p);
    // A pseudonym's own pattern already pins it, and `@` in it would read as
    // a GFM email autolink.
    if (field === "generated.by" || field === "verified.by") return;
    for (const p of markupProblems(value, label)) add(line, p);
  });

  out.push(...validateBody(rel, split));
  return out;
}

function validateBody(rel, split) {
  const out = [];
  const add = (line, message) => out.push(`${rel}:${line}: ${message}`);
  const { found, unexpected, sections } = parseSections(split.body, split.bodyFirstLine);

  for (const bad of unexpected) {
    add(
      bad.line,
      `unexpected heading ${JSON.stringify(bad.text.trimEnd())}; only the six lesson sections are allowed`,
    );
  }

  const seen = new Set();
  for (const hit of found) {
    if (seen.has(hit.spec.key))
      add(hit.line, `duplicate section ${JSON.stringify(hit.spec.heading)}`);
    seen.add(hit.spec.key);
  }
  for (const spec of SECTIONS) {
    if (spec.required && !seen.has(spec.key)) {
      add(split.bodyFirstLine, `missing required section ${JSON.stringify(spec.heading)}`);
    }
  }

  const order = SECTIONS.map((s) => s.key).filter((k) => seen.has(k));
  const actual = [];
  for (const hit of found) if (!actual.includes(hit.spec.key)) actual.push(hit.spec.key);
  if (actual.join(",") !== order.join(",")) {
    add(
      split.bodyFirstLine,
      `sections are out of order; the order is ${SECTIONS.map((s) => s.heading).join(", ")}`,
    );
  }

  for (const [key, section] of Object.entries(sections)) {
    if (section.text.length === 0) add(section.line, `section ${key} is empty`);
    else if (section.text.length > LIMITS.section) {
      add(section.line, `section ${key} is ${section.text.length} chars, max ${LIMITS.section}`);
    }
  }

  const bodyLines = split.body.split("\n");
  // Everything before the first heading is dropped from the snapshot but still
  // ships in the raw file, so it has to be empty.
  const firstHeading = found.length > 0 ? found[0].index : bodyLines.length;
  const preamble = bodyLines.slice(0, firstHeading).findIndex((l) => l.trim() !== "");
  if (preamble !== -1) {
    add(split.bodyFirstLine + preamble, "no text before the first section heading");
  }

  bodyLines.forEach((line, i) => {
    const at = split.bodyFirstLine + i;
    // Anywhere on the line, so a fence inside a blockquote or a list item counts.
    if (/`{3,}|~{3,}/.test(line)) {
      add(at, "no fenced code blocks in a lesson body; a short inline span is fine");
    }
    if (/^(?: {4,}|\t)\S/.test(line)) add(at, "no indented code blocks in a lesson body");
    if (!line.startsWith("#") && /^[ \t>*+-]*#{1,6}(?:\s|$)/.test(line)) {
      add(at, "unexpected heading; only the six lesson sections are allowed");
    }
    if (/^ {0,3}(?:=+|-+|\*{3,}|_{3,})\s*$/.test(line)) {
      add(at, "no setext headings or horizontal rules in a lesson body");
    }
    if (/<[A-Za-z!/?]/.test(line.replace(/`[^`]*`/g, ""))) {
      add(at, "no HTML in a lesson body");
    }
    for (const shape of shapesIn(line)) {
      if (shape === "a URL") add(at, "no URLs in a lesson body; put provenance in sources");
      else add(at, `${shape} in a lesson body; lessons carry none`);
    }
    // `](` and `][` rather than a whole `[text](target)`: link text and
    // target can be split across lines, and reference definitions stand alone.
    if (/\]\(|\]\[|^\s*\[[^\]]+\]:/.test(line)) add(at, "no markdown links in a lesson body");
  });

  // The line rules above are cheap and catch the obvious; the parser is the
  // one that agrees with a renderer about what is a link, HTML or code.
  const lineOf = (offset) =>
    split.bodyFirstLine + split.body.slice(0, offset).split("\n").length - 1;
  for (const f of markupFindings(split.body)) {
    add(lineOf(f.offset), `${MARKUP[f.kind].rule} in a lesson body`);
  }
  const lineShapes = (from, to) =>
    new Set(bodyLines.slice(from, to + 1).flatMap((l) => shapesIn(l)));
  const tokens = walkTokens(split.body, (token, offset, depth) => {
    const at = lineOf(offset);
    if (token.type === "code") {
      add(
        at,
        token.codeBlockStyle === "indented"
          ? "no indented code blocks in a lesson body"
          : "no fenced code blocks in a lesson body; a short inline span is fine",
      );
    } else if (token.type === "hr") {
      add(at, "no setext headings or horizontal rules in a lesson body");
    } else if (
      token.type === "heading" &&
      (depth > 0 || !SECTIONS.some((spec) => spec.heading === token.raw.trimEnd()))
    ) {
      add(at, "unexpected heading; only the six lesson sections are allowed");
    }
    if (depth !== 0 || typeof token.raw !== "string") return;
    // Formatting can split a shape so no single raw line holds it whole;
    // judge the rendered text of each block as well.
    const first = at - split.bodyFirstLine;
    const seen = lineShapes(first, first + token.raw.split("\n").length - 1);
    for (const shape of shapesIn(plainText([token]))) {
      if (seen.has(shape)) continue;
      if (shape === "a URL") add(at, "no URLs in a lesson body; put provenance in sources");
      else add(at, `${shape} in a lesson body; lessons carry none`);
    }
  });
  if (!tokens) add(split.bodyFirstLine, "the lesson body could not be parsed as markdown");

  return [...new Set(out)];
}

/** Lesson paths under `dir`, as sorted `<namespace>/<slug>.md`. */
export function collectLessonFiles(dir) {
  const out = [];
  for (const ns of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ns.isDirectory() || ns.name.startsWith(".")) continue;
    for (const entry of fs.readdirSync(path.join(dir, ns.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push(`${ns.name}/${entry.name}`);
    }
  }
  return out.sort();
}

/** Validate a whole corpus directory. Returns `path:line: message` lines. */
export function validateLessonsDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return [`${dir}:1: no such lessons directory`];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ns of entries) {
    if (ns.name.startsWith(".")) continue;
    if (ns.isSymbolicLink()) {
      out.push(`${ns.name}:1: no symlinks in the lessons directory`);
      continue;
    }
    if (!ns.isDirectory()) continue; // README, SCHEMA, LICENSE, log, the scripts
    if (!NAMESPACES.includes(ns.name)) {
      out.push(
        `${ns.name}:1: unknown namespace directory; the namespaces are ${NAMESPACES.join(", ")}`,
      );
      continue;
    }
    const inner = fs
      .readdirSync(path.join(dir, ns.name), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of inner) {
      if (entry.isDirectory()) {
        out.push(`${ns.name}/${entry.name}:1: a namespace holds lesson files only, one level deep`);
      } else if (!entry.name.endsWith(".md")) {
        out.push(`${ns.name}/${entry.name}:1: a namespace holds .md lesson files only`);
      } else if (!entry.isFile()) {
        out.push(`${ns.name}/${entry.name}:1: not a regular file`);
      }
    }
  }
  const files = collectLessonFiles(dir);
  if (files.length === 0) out.push(`${path.basename(dir)}:1: no lesson files found`);
  for (const rel of files) {
    out.push(...validateLessonFile(rel, fs.readFileSync(path.join(dir, rel), "utf8")));
  }
  return out;
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
  if (args.length > 1) {
    console.error(`usage: validate.mjs [dir] (got ${args.join(" ")})`);
    process.exit(2);
  }
  const dir = args[0] ? path.resolve(args[0]) : LESSONS_DIR;
  const violations = validateLessonsDir(dir);
  if (violations.length > 0) {
    console.error(`lessons/validate: FAILED -- ${violations.length} violation(s)`);
    for (const v of violations) console.error(v);
    process.exit(1);
  }
  console.log(`lessons/validate: OK -- ${collectLessonFiles(dir).length} lesson(s)`);
}
