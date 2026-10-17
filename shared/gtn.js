// Galaxy Training Network discovery, the part both shells share: where the GTN API is, how a
// topic or tutorial listing is read, which urls gtn_fetch may follow, and how a tutorial page is
// reduced to text. The reduction is a small scanner rather than an HTML parser so it loads in a
// browser worker, and it degrades on malformed markup instead of leaking a script body.

export const GTN_HOST = "training.galaxyproject.org";
export const GTN_BASE = `https://${GTN_HOST}`;
export const GTN_API = `${GTN_BASE}/training-material/api`;

/** Chrome that carries no tutorial content, dropped whole. */
const DROP_TAGS = new Set(["script", "style", "nav", "header", "footer", "aside", "noscript"]);
/** Elements with no end tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Most specific first: the first one present wins. */
const CONTENT_REGIONS = ["main", "article", "tutorial-content"];
const RAW_TEXT = new Set(["script", "style"]);
/** @type {Record<string, string>} */
const ENTITIES = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rarr: "→",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  times: "×",
};
const TAG =
  /<!--[\s\S]*?-->|<[!?][^>]*>|<\/([a-zA-Z][^\s/>]*)[^>]*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const CLASS_ATTR = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** @param {string} text */
function unescape(text) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, ref) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[ref] ?? match;
  });
}

/** @param {string} attrs */
function classOf(attrs) {
  const matches = [...attrs.matchAll(CLASS_ATTR)];
  const last = matches[matches.length - 1];
  return last ? unescape(last[1] ?? last[2] ?? last[3] ?? "") : "";
}

/**
 * The page's text, and the text inside each content region.
 * @param {string} html
 */
function extract(html) {
  /** @type {string[]} */
  const chunks = [];
  /** @type {Record<string, string[]>} */
  const regions = {};
  /** @type {[string, number][]} */
  const open = [];
  let depth = 0;
  /** @type {number | undefined} */
  let skipUntil;

  /** @param {string} tag @param {string} attrs */
  const start = (tag, attrs) => {
    if (VOID_TAGS.has(tag)) return;
    depth += 1;
    if (skipUntil !== undefined) return;
    if (DROP_TAGS.has(tag)) {
      skipUntil = depth;
      return;
    }
    let name = CONTENT_REGIONS.includes(tag) ? tag : undefined;
    if (!name && classOf(attrs).split(/\s+/).includes("tutorial-content")) {
      name = "tutorial-content";
    }
    // Only the outermost occurrence of a region is captured.
    if (name && !(name in regions)) {
      regions[name] = [];
      open.push([name, depth]);
    }
  };
  /** @param {string} tag */
  const end = (tag) => {
    if (VOID_TAGS.has(tag)) return;
    if (skipUntil !== undefined && depth <= skipUntil) skipUntil = undefined;
    while (open.length && open[open.length - 1][1] >= depth) open.pop();
    depth = Math.max(0, depth - 1);
  };
  /** @param {string} text */
  const data = (text) => {
    if (!text || skipUntil !== undefined) return;
    chunks.push(text);
    for (const [name] of open) regions[name].push(text);
  };

  let at = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(html); match; match = TAG.exec(html)) {
    data(unescape(html.slice(at, match.index)));
    at = TAG.lastIndex;
    const [, closing, opening, attrs = ""] = match;
    if (closing) {
      end(closing.toLowerCase());
    } else if (opening) {
      const tag = opening.toLowerCase();
      start(tag, attrs);
      if (attrs.trimEnd().endsWith("/")) {
        end(tag);
      } else if (RAW_TEXT.has(tag)) {
        const close = html.slice(at).search(new RegExp(`</${tag}[\\s>/]`, "i"));
        const stop = close < 0 ? html.length : at + close;
        data(html.slice(at, stop));
        TAG.lastIndex = at = stop;
      }
    }
  }
  data(unescape(html.slice(at)));
  return { chunks, regions };
}

/** @param {string} text */
function normalize(text) {
  /** @type {string[]} */
  const out = [];
  let blanks = 0;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const collapsed = line.split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) {
      out.push(collapsed);
      blanks = 0;
    } else {
      blanks += 1;
      if (blanks < 2) out.push("");
    }
  }
  return out.join("\n").trim();
}

/**
 * Reduce a GTN page to readable text, preferring its most specific region.
 * @param {string} html @returns {string}
 */
export function gtnPageText(html) {
  const { chunks, regions } = extract(html);
  for (const name of CONTENT_REGIONS) {
    const chunk = regions[name];
    if (chunk && chunk.join("").trim()) return normalize(chunk.join(""));
  }
  return normalize(chunks.join(""));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The topics listing as the GTN API answers it, or undefined when the payload isn't one.
 * @param {unknown} data
 */
export function gtnTopics(data) {
  if (!isRecord(data)) return undefined;
  const topics = Object.values(data)
    .filter(isRecord)
    .map((t) => ({ name: t.name ?? null, title: t.title ?? null, summary: t.summary ?? null }));
  return {
    count: topics.length,
    topics,
    hint: "Use gtn_search with a topic name to list its tutorials.",
  };
}

/**
 * A topic's tutorials as the GTN API answers them, filtered on title and objectives when a query
 * is given, or undefined when the payload isn't a topic.
 * @param {unknown} data @param {string} [query]
 */
export function gtnTutorials(data, query) {
  if (!isRecord(data)) return undefined;
  let tutorials = (Array.isArray(data.materials) ? data.materials : [])
    .filter(isRecord)
    .map((m) => {
      const url = typeof m.url === "string" ? m.url : "";
      return {
        title: m.title ?? null,
        url: url.startsWith("/") ? `${GTN_BASE}${url}` : url,
        id: m.id || m.tutorial_name || null,
        level: m.level ?? null,
        time_estimation: m.time_estimation ?? null,
        objectives: /** @type {(string | null)[]} */ (m.objectives || []),
      };
    });
  if (query) {
    const needle = query.toLowerCase();
    tutorials = tutorials.filter(
      (t) =>
        String(t.title || "")
          .toLowerCase()
          .includes(needle) || t.objectives.some((o) => (o || "").toLowerCase().includes(needle)),
    );
  }
  return {
    topic: data.title ?? null,
    count: tutorials.length,
    ...(query ? { query } : {}),
    tutorials,
    hint: "Use gtn_fetch with a tutorial URL to read its full content.",
  };
}

/**
 * The parsed url when gtn_fetch may follow it: http(s) on the GTN host, nothing else (a userinfo
 * trick or another scheme is refused). Otherwise the reason.
 * @param {string} url @returns {{ url: URL } | { problem: string }}
 */
export function gtnUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const host = parsed?.hostname ?? "";
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || host !== GTN_HOST) {
    return { problem: `Only URLs on ${GTN_HOST} are allowed. Got: ${host || url}` };
  }
  return { url: parsed };
}
