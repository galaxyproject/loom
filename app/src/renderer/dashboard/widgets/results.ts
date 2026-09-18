/**
 * Results widget -- a gallery of what the analysis has produced.
 *
 * The panel answers "what did it make, and can I recognise it": plots as
 * thumbnails, small delimited files as their first few rows, everything else
 * as a named row with its size. A panel can also be pinned to one file, so
 * "keep the volcano plot visible" is a single panel rather than a habit of
 * re-opening the files tree.
 *
 * Two rules shape the implementation:
 *
 *  - **No new way to read the disk.** Everything about *which* files exist
 *    comes from `ctx.sources.files`; everything about their *contents* goes
 *    through the cwd-jailed `orbit-artifact://` scheme the notebook figures and
 *    the File pane's markdown preview already use, via that pane's own
 *    `rewritePreviewImageHref`. The widget never touches `window.orbit`.
 *  - **File contents are hostile.** An SVG is a script carrier, so every image
 *    goes through `<img>` and nothing is ever built from file bytes as HTML.
 *    Table cells reach the DOM through `textContent`.
 */

import { extOf } from "../../files/image-preview.js";
import { rewritePreviewImageHref } from "../../files/markdown-preview.js";
import type { FileNode } from "../../../preload/preload.js";
import type { FilesSnapshot, WidgetDefinition, WidgetDispose } from "../widget-api.js";
import { safeNameOr } from "./text-safety.js";

type ResultsConfig = {
  /** `gallery` shows everything that matches; `pinned` shows one file. */
  mode: "gallery" | "pinned";
  /** Pinned mode: the cwd-relative file this panel keeps in view. */
  path?: string;
  /** Gallery mode: a glob narrowing what is considered a result. */
  glob?: string;
  /** How many entries a gallery draws. */
  limit: number;
};

export type ResultKind = "image" | "table" | "document" | "other";

export interface ResultFile {
  name: string;
  relPath: string;
  /** Null where the shell could not stat the file, which is not the same as empty. */
  size: number | null;
  kind: ResultKind;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
// `.tabular` is Galaxy's name for a tab-delimited text file, and loom#269 is
// the reminder that a last-extension allowlist is the only thing keeping it
// out of the binary bucket.
const TABLE_EXTS = new Set([".csv", ".tsv", ".tab", ".tabular"]);
const DOCUMENT_EXTS = new Set([".pdf", ".html", ".htm", ".md", ".txt", ".log"]);

/** Files the workspace keeps for its own bookkeeping, not results. */
const HOUSEKEEPING = new Set(["notebook.md", "activity.jsonl", "session.jsonl"]);

const KIND_ORDER: Record<ResultKind, number> = { image: 0, table: 1, document: 2, other: 3 };

/** Past this a thumbnail costs more than it is worth; the file becomes a row. */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a delimited file is pulled across to draw a handful of rows. */
const TABLE_HEAD_BYTES = 32 * 1024;
/** A single cell wider than this is a wall of text, not a value. */
const MAX_CELL_CHARS = 60;

/** A glob is a few characters someone typed, never a payload. */
const MAX_GLOB_CHARS = 200;
/** How many patterns `{a,b}` alternation may expand to before it stops. */
const MAX_GLOB_VARIANTS = 16;
/** However hostile the layout file is, a panel draws a panel's worth. */
const MAX_LIMIT = 60;
/**
 * How long a listing may take before the panel stops saying it is looking.
 * The files source reports "not available" before the host has asked the
 * shell, in a shell that has no listing at all, and for the moment after a
 * reset -- and only time tells them apart from in here. A host that marked the
 * shell-has-no-listing case would be better: `FilesSnapshot` wants an `exists`
 * alongside `available`, and the log panel needs the same thing for the same
 * reason.
 */
const LISTING_GRACE_MS = 1200;

/**
 * How often an image already on screen is offered back to the disk.
 *
 * A file listing carries a name and a size and no mtime, so a plot regenerated
 * from new data at the same dimensions -- which lands on the same byte count
 * far more often than it sounds like it would -- is indistinguishable from the
 * old one. Both the redraw signature and the cache-buster are built from that
 * size, so the panel kept showing the previous figure for the rest of the
 * session. Nothing in the widget can detect the rewrite, so the images are
 * re-fetched on a slow tick instead, and only when the file listing has moved
 * since they were drawn.
 *
 * Be honest about what that costs. "The listing has moved" is every
 * `files:changed` the shell reports, and during an active analysis the brain is
 * rewriting `notebook.md` and appending to `activity.jsonl` continuously -- so
 * in practice every drawn image is re-read once per tick for as long as the
 * session is busy. On an idle analysis it is nothing. A tighter guard is not
 * available: the one signal that would say "this plot changed" is the one the
 * listing does not carry.
 *
 * **Table previews have the identical bug and are not covered here.** The same
 * byte count gives `renderTable` the same URL and the same signature, so a
 * regenerated counts file keeps its old rows. Re-running a table preview means
 * re-rendering the entry rather than swapping one attribute, which is a bigger
 * change than this one and wants the real fix instead.
 *
 * The real fix is an mtime on `FileNode`. The main process already stats every
 * file to fill in the size (`app/src/main/files-handler.ts`), and so does the
 * web file surface, so it is one field and this whole tick goes away.
 */
const IMAGE_RECHECK_MS = 30_000;

const GALLERY_TABLE_ROWS = 4;
const GALLERY_TABLE_COLS = 4;
const PINNED_TABLE_ROWS = 10;
const PINNED_TABLE_COLS = 8;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * What a file is, by its last extension. `sample.raw.counts.tsv` is a table and
 * `plot.v2.final.png` is an image; a compressed `counts.tsv.gz` is neither,
 * because nothing here can decompress it.
 */
export function classifyResult(relPath: string): ResultKind {
  const ext = extOf(relPath);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TABLE_EXTS.has(ext)) return "table";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "other";
}

/**
 * Expand `{a,b}` alternation into concrete patterns. Bounded: past
 * `MAX_GLOB_VARIANTS` the expansion stops and the remaining braces match as
 * literal characters, which is wrong but cheap and cannot be made to hang.
 */
export function expandBraces(pattern: string): string[] {
  let out = [pattern];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const candidate of out) {
      const open = candidate.indexOf("{");
      const close = open < 0 ? -1 : candidate.indexOf("}", open);
      if (open < 0 || close < 0) {
        next.push(candidate);
        continue;
      }
      expanded = true;
      const head = candidate.slice(0, open);
      const tail = candidate.slice(close + 1);
      for (const alt of candidate.slice(open + 1, close).split(",")) next.push(head + alt + tail);
    }
    if (!expanded) return next;
    if (next.length > MAX_GLOB_VARIANTS) return out;
    out = next;
  }
}

/**
 * `*` and `?` inside one path segment.
 *
 * This is the linear wildcard match with a single backtrack point, not a
 * regular expression, and that is the whole reason it exists. `[^/]*` repeated
 * -- which `*a*a*a*a*a*a*a*a*b` compiles to -- backtracks exponentially, and a
 * seventeen-character pattern in the layout file froze the renderer for over
 * four seconds per file. The layout file is untrusted, this runs once per file
 * on the main thread, and there is no length cap that makes a regex safe here.
 */
function matchSegment(pattern: string, subject: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < subject.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === subject[s])) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** The same algorithm one level up, where a `**` segment stands for any depth. */
function matchPath(pattern: string[], subject: string[]): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < subject.length) {
    if (p < pattern.length && pattern[p] !== "**" && matchSegment(pattern[p], subject[s])) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === "**") {
      star = p++;
      mark = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "**") p++;
  return p === pattern.length;
}

/**
 * Compile once, match many. A small glob dialect: `*` within a path segment,
 * `**` across segments, `?` for one character, `{a,b}` alternation. A pattern
 * with no `/` is matched against the file name alone, so `*.png` finds
 * `figures/volcano.png` -- which is what someone typing it into a panel means.
 * An empty pattern matches everything.
 */
export function compileGlob(pattern: string): (relPath: string) => boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return () => true;
  // Not a safety measure any more, just a sanity bound: a glob is a few
  // characters someone typed.
  if (trimmed.length > MAX_GLOB_CHARS) return () => false;
  const wholePath = trimmed.includes("/");
  const variants = expandBraces(trimmed.toLowerCase()).map((v) => v.split("/"));
  return (relPath) => {
    const subject = wholePath ? relPath : (relPath.split("/").pop() ?? relPath);
    const segments = subject.toLowerCase().split("/");
    return variants.some((variant) => matchPath(variant, segments));
  };
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  return compileGlob(pattern)(relPath);
}

/** Flatten the file tree into result candidates, skipping the workspace's own bookkeeping. */
export function collectResultFiles(root: FileNode | null): ResultFile[] {
  const out: ResultFile[] = [];
  const walk = (entry: FileNode): void => {
    if (entry.type === "directory") {
      for (const child of entry.children ?? []) walk(child);
      return;
    }
    // Only at the root: `reports/notebook.md` is somebody's result, the one
    // beside the analysis is the log that already owns its own tab.
    if (entry.relPath === entry.name && HOUSEKEEPING.has(entry.name)) return;
    out.push({
      name: entry.name,
      relPath: entry.relPath,
      size: typeof entry.size === "number" ? entry.size : null,
      kind: classifyResult(entry.relPath),
    });
  };
  if (root) walk(root);
  return out;
}

/**
 * Rank and cut the candidates. Plots first, then tables, then documents: the
 * order someone reviewing a result looks in. `files:list` carries no
 * modification time, so "newest first" is not available -- see the report.
 */
export function selectResults(
  files: ResultFile[],
  opts: { glob?: string; limit: number },
): { shown: ResultFile[]; total: number } {
  const matches = compileGlob(opts.glob ?? "");
  const matched = files.filter((f) => matches(f.relPath));
  matched.sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const depthA = a.relPath.split("/").length;
    const depthB = b.relPath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.relPath.localeCompare(b.relPath);
  });
  const limit = normalizeLimit(opts.limit);
  return { shown: matched.slice(0, limit), total: matched.length };
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

/**
 * The panel's config arrives from a file a person or a model can write, so
 * every field is `unknown` however it is typed. Coerce once, here, rather than
 * guarding at each use.
 */
export function readResultsConfig(raw: Partial<ResultsConfig>): Required<ResultsConfig> {
  const value = raw as Record<string, unknown>;
  return {
    mode: value.mode === "pinned" ? "pinned" : "gallery",
    path: typeof value.path === "string" ? value.path : "",
    glob: typeof value.glob === "string" ? value.glob : "",
    limit: normalizeLimit(value.limit),
  };
}

export function delimiterFor(relPath: string): string {
  return extOf(relPath) === ".csv" ? "," : "\t";
}

/**
 * Split one line, honouring double-quoted fields with doubled quotes inside.
 * A quoted field containing a newline is not handled: this reads a head, and
 * the head is split into lines before it gets here.
 */
function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  out.push(cell);
  return out;
}

export interface TablePreview {
  /** Null when the file has no header row -- BED, GTF and most `.tabular`. */
  headers: string[] | null;
  rows: string[][];
  /** Columns beyond `maxCols` that were dropped from every row. */
  extraColumns: number;
  /** True when rows were cut, either by `maxRows` or by the byte budget. */
  moreRows: boolean;
}

function looksNumeric(cell: string): boolean {
  const trimmed = cell.trim();
  return trimmed !== "" && Number.isFinite(Number(trimmed));
}

/**
 * Galaxy's `.tabular`, and BED and GTF with it, are routinely headerless, and
 * drawing a row of real data bold as a column name is worse than drawing no
 * names at all. A header row is the one with no numbers in it.
 */
function looksLikeHeader(row: string[]): boolean {
  return row.length > 0 && !row.some(looksNumeric);
}

/**
 * First rows of a delimited file, capped in every direction. `partial` says the
 * text was cut at a byte budget, so the last line is dropped -- half a row of
 * numbers looks like a real row and is not one.
 */
export function parseDelimitedPreview(
  text: string,
  opts: { delimiter: string; maxRows: number; maxCols: number; partial?: boolean },
): TablePreview | null {
  const lines = text.split(/\r?\n/);
  if (opts.partial) lines.pop();
  const usable = lines.filter((line) => line.trim() !== "");
  if (usable.length === 0) return null;

  const cut = (cell: string): string =>
    cell.length > MAX_CELL_CHARS ? `${cell.slice(0, MAX_CELL_CHARS)}...` : cell;

  const first = splitRow(usable[0], opts.delimiter).map(cut);
  const titled = looksLikeHeader(first);
  const parsed = usable
    .slice(0, titled ? opts.maxRows + 1 : opts.maxRows)
    .map((line, index) => (index === 0 ? first : splitRow(line, opts.delimiter).map(cut)));
  const widest = parsed.reduce((max, row) => Math.max(max, row.length), 0);
  const body = titled ? parsed.slice(1) : parsed;

  return {
    headers: titled ? parsed[0].slice(0, opts.maxCols) : null,
    rows: body.map((row) => row.slice(0, opts.maxCols)),
    extraColumns: Math.max(0, widest - opts.maxCols),
    moreRows: usable.length > parsed.length || Boolean(opts.partial),
  };
}

export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * The cwd-jailed URL for a workspace file. `./` in front of the path stops a
 * legal-but-awkward file name like `run:1.png` from reading as a URL scheme
 * and passing through unrewritten -- the rewriter documents that prefix as the
 * way to force a relative reading. Returns "" for anything it cannot jail.
 */
export function artifactUrl(relPath: string, cacheKey?: string | number | null): string {
  const base = rewritePreviewImageHref("", `./${relPath}`);
  if (!base) return "";
  // The protocol handler reads only the path, so a query is a free cache-buster
  // for a plot that was overwritten in place.
  return cacheKey ? `${base}?v=${encodeURIComponent(String(cacheKey))}` : base;
}

// ── Reading a head over the artifact scheme ──────────────────────────────────

/**
 * How far past the budget a body-less response may declare itself and still be
 * worth reading whole. Generous, because `content-length` is bytes while the
 * budget and the slice below it are characters -- a multibyte text file needs
 * headroom for the two to mean the same thing -- and because a few multiples of
 * 32 KB is nothing; bounded, because the alternative on that path is the whole
 * file.
 */
const NO_BODY_BUDGET_MULTIPLE = 8;

/**
 * Pull at most `budget` bytes and stop. The stream is cancelled rather than
 * drained, so a 2 GB counts table costs the same as a 2 KB one, and the
 * fallback for a response with no body at all refuses to read one it cannot
 * prove is small. Exported so that "does not read more than it shows" is a
 * test rather than a claim.
 */
export async function readHead(
  url: string,
  budget: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean } | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    if (!res.body) {
      // A Response with no body cannot be read incrementally, so the only way
      // to slice a head out of it is to materialise the whole thing -- which is
      // the one thing this function promises not to do, and against a 200 MB
      // counts table it is 200 MB on the main thread. So this path reads only
      // what the response has proved is small: no declared length, or a length
      // well past the budget, and the caller gets nothing and draws a plain row
      // instead. Electron's net.fetch always gives a body, so this is a
      // fallback for shells that do not.
      const declared = res.headers?.get?.("content-length");
      const bytes = declared === null || declared === undefined ? NaN : Number(declared);
      if (!Number.isFinite(bytes) || bytes > budget * NO_BODY_BUDGET_MULTIPLE) return null;
      const all = await res.text();
      return { text: all.slice(0, budget), truncated: all.length > budget };
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let seen = 0;
    let truncated = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      // `>` rather than `>=`: a body that is exactly the budget was read whole,
      // and calling it truncated costs the caller its last row.
      if (seen + value.byteLength > budget) {
        text += decoder.decode(value.subarray(0, budget - seen));
        truncated = true;
        break;
      }
      seen += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return { text, truncated };
  } catch {
    // No artifact scheme in this shell, a CSP that will not allow the read, a
    // file that vanished: the entry falls back to a named row either way.
    return null;
  } finally {
    // Not awaited: the caller has what it needs, and a cancel on an
    // already-closed stream rejects rather than throwing.
    if (reader) void reader.cancel().catch(() => {});
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export const resultsWidget: WidgetDefinition<ResultsConfig> = {
  type: "results",
  label: "Results",
  description: "Images, tables and files the analysis produced.",
  defaultConfig: { mode: "gallery", path: "", glob: "", limit: 8 },

  mount(el, ctx): WidgetDispose {
    el.classList.add("dash-results");
    const list = node("div", "dash-results-list");
    el.append(list);

    const count = node("span", "dash-results-meta");
    ctx.header.append(count);

    const showAll = node("button", "dash-panel-btn", "show all");
    showAll.type = "button";
    showAll.hidden = true;
    showAll.title = "Go back to every result in this folder";
    showAll.addEventListener("click", () => ctx.setConfig({ mode: "gallery", path: "" }));
    ctx.header.append(showAll);

    let controller = new AbortController();
    let signature = "";
    // A shell that cannot serve the artifact scheme, or whose CSP will not let
    // the renderer read it, fails every table the same way. The entries are
    // still correct as plain rows, so this is a note for whoever is looking at
    // a console rather than a card in the user's face.
    let warnedAboutReads = false;
    let graceExpired = false;
    let wasAvailable = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // Bumped by the re-check tick to build a URL the browser has not cached.
    let imageGeneration = 0;
    // The listing these images were drawn from. Nothing newer means nothing can
    // have been rewritten under them.
    let imagesDrawnFrom = 0;
    const drawnImages = new Map<HTMLImageElement, ResultFile>();
    ctx.onDispose(() => controller.abort());

    const imageUrl = (file: ResultFile): string =>
      artifactUrl(file.relPath, `${file.size ?? "?"}.${imageGeneration}`);

    const config = readResultsConfig(ctx.config);
    const pinned = config.mode === "pinned";
    const tableRows = pinned ? PINNED_TABLE_ROWS : GALLERY_TABLE_ROWS;
    const tableCols = pinned ? PINNED_TABLE_COLS : GALLERY_TABLE_COLS;

    const addCaption = (entry: HTMLElement, file: ResultFile): void => {
      const caption = node("div", "dash-results-caption");
      // A filename is whatever a tool wrote, so it gets the same treatment the
      // log panel gives a tool argument: an override in the middle of it would
      // otherwise render `a<RLO>gnp.exe` as `a...exe.png`. The click still
      // carries the real path -- only what the reader sees is normalized.
      const shownName = safeNameOr(file.name, "(unnamed file)");
      const shownPath = safeNameOr(file.relPath, "(unnamed file)");
      // A button only where the shell can actually open the file. Seeing the
      // plot and not being able to get to it was the weakest part of this
      // panel, but a name that looks clickable and does nothing is worse.
      if (ctx.openFile) {
        const open = node("button", "dash-results-name dash-results-open", shownName);
        open.type = "button";
        open.title = `Open ${shownPath}`;
        open.addEventListener("click", () => ctx.openFile?.(file.relPath));
        caption.append(open);
      } else {
        const name = node("span", "dash-results-name", shownName);
        name.title = shownPath;
        caption.append(name);
      }
      const size = formatSize(file.size);
      if (size) caption.append(node("span", "dash-results-meta", size));
      if (!pinned) {
        const pin = node("button", "dash-panel-btn dash-results-pin", "pin");
        pin.type = "button";
        pin.title = `Keep ${file.name} in this panel`;
        pin.addEventListener("click", () => ctx.setConfig({ mode: "pinned", path: file.relPath }));
        caption.append(pin);
      }
      entry.append(caption);
    };

    const renderTable = (entry: HTMLElement, file: ResultFile, token: AbortSignal): void => {
      const url = artifactUrl(file.relPath, file.size);
      if (!url) return;
      void readHead(url, TABLE_HEAD_BYTES, token)
        .then((head) => {
          if (token.aborted) return;
          if (!head) {
            if (!warnedAboutReads) {
              warnedAboutReads = true;
              console.warn(
                "[dashboard] could not read a table head over orbit-artifact:; tables will show as plain rows. " +
                  "This shell may not serve that scheme, or its CSP connect-src may not allow it.",
              );
            }
            return;
          }
          const preview = parseDelimitedPreview(head.text, {
            delimiter: delimiterFor(file.relPath),
            maxRows: tableRows,
            maxCols: tableCols,
            partial: head.truncated,
          });
          if (!preview) return;
          const wrap = node("div", "dash-results-table-wrap");
          const table = node("table", "dash-results-table");
          if (preview.headers) {
            const thead = document.createElement("thead");
            const headRow = document.createElement("tr");
            for (const header of preview.headers) headRow.append(node("th", undefined, header));
            thead.append(headRow);
            table.append(thead);
          }
          const tbody = document.createElement("tbody");
          for (const row of preview.rows) {
            const tr = document.createElement("tr");
            for (const cell of row) tr.append(node("td", undefined, cell));
            tbody.append(tr);
          }
          table.append(tbody);
          wrap.append(table);
          entry.prepend(wrap);
          const notes: string[] = [];
          // "first 0 rows" is what a read the byte budget cut inside the very
          // first row would otherwise say.
          if (preview.moreRows && preview.rows.length > 0) {
            notes.push(`first ${preview.rows.length} rows`);
          }
          if (preview.extraColumns > 0) {
            notes.push(
              `${preview.extraColumns} more column${preview.extraColumns === 1 ? "" : "s"}`,
            );
          }
          if (notes.length) wrap.after(node("div", "dash-results-note", notes.join(", ")));
        })
        // A throw in there would otherwise be an unhandled rejection: the panel
        // keeps its rows rather than turning into an error card over a preview.
        .catch((err) => console.error("[dashboard] results table preview failed:", err));
    };

    const renderEntry = (file: ResultFile, token: AbortSignal): HTMLElement => {
      const entry = node("div", "dash-results-entry");
      // A null size is a stat that threw -- a broken symlink, or a file racing
      // the write that is creating it -- not a small file. Drawing it anyway
      // put an uncapped <img> on the page for the one kind of file we know
      // least about, so it fails closed to a plain row and comes back as a
      // thumbnail on the next listing that can measure it.
      if (file.kind === "image" && file.size !== null && file.size <= IMAGE_MAX_BYTES) {
        const url = imageUrl(file);
        if (url) {
          // Always an <img>. An SVG is active content and inlining one would
          // run whatever a tool wrote into it.
          const img = node("img", pinned ? "dash-results-figure tall" : "dash-results-figure");
          img.src = url;
          img.alt = safeNameOr(file.name, "(unnamed file)");
          img.loading = "lazy";
          img.addEventListener("error", () => {
            drawnImages.delete(img);
            img.remove();
          });
          drawnImages.set(img, file);
          entry.append(img);
        }
      } else if (file.kind === "table") {
        renderTable(entry, file, token);
      }
      addCaption(entry, file);
      return entry;
    };

    const draw = (snapshot: FilesSnapshot): void => {
      // `available: false` covers three different things: the host has not
      // asked the shell yet, the shell has no listing to give, and the source
      // was just reset for a new analysis. Announcing anything about the shell
      // while a large workspace is still being walked is a lie the desktop user
      // would see on every startup, so a fresh `false` buys a grace period --
      // including a `false` that arrives after a `true`, which is what /new and
      // every cwd switch produce and what used to walk straight past a latch
      // that only ever expired once.
      if (wasAvailable && !snapshot.available) armGrace();
      wasAvailable = snapshot.available;
      const listing = snapshot.available ? "on" : graceExpired ? "off" : "pending";
      const files = collectResultFiles(snapshot.root);
      const pinnedFile = pinned ? (files.find((f) => f.relPath === config.path) ?? null) : null;
      const selection = pinned
        ? { shown: pinnedFile ? [pinnedFile] : [], total: pinnedFile ? 1 : 0 }
        : selectResults(files, { glob: config.glob, limit: config.limit });

      const next = [
        listing,
        config.mode,
        config.path,
        config.glob,
        String(config.limit),
        // The total as well as the selection: at limit 1 a workspace going from
        // three files to five changes the header and nothing else.
        String(selection.total),
        ...selection.shown.map((f) => `${f.relPath}:${f.size ?? "?"}`),
      ].join("|");
      if (next === signature) return;
      signature = next;

      controller.abort();
      controller = new AbortController();
      const token = controller.signal;
      list.textContent = "";
      drawnImages.clear();
      imagesDrawnFrom = snapshot.updatedAt;

      showAll.hidden = !pinned;
      count.textContent =
        listing !== "on" || pinned || selection.total === 0
          ? ""
          : selection.total > selection.shown.length
            ? `${selection.shown.length} of ${selection.total}`
            : `${selection.total} ${selection.total === 1 ? "file" : "files"}`;

      if (listing !== "on") {
        list.append(
          node(
            "div",
            "dash-results-empty",
            listing === "pending"
              ? "Looking for the files in this analysis."
              : // Which of the three it is, the panel cannot tell -- and it is
                // the shell's own File pane that would say otherwise, so the
                // old wording claimed a missing capability on a window that
                // reads files perfectly well.
                "Nothing has been listed for this analysis. Either nothing has been written yet, " +
                  "or this window cannot list the folder.",
          ),
        );
        return;
      }

      if (selection.shown.length === 0) {
        const message = pinned
          ? `Nothing at ${config.path || "that path"} yet. It will appear here as soon as a step writes it.`
          : config.glob
            ? `No files match ${config.glob} yet.`
            : "Nothing to show yet. Plots, tables and the files the analysis writes land here.";
        list.append(node("div", "dash-results-empty", message));
        return;
      }

      for (const file of selection.shown) list.append(renderEntry(file, token));
    };

    function armGrace(): void {
      clearTimeout(graceTimer);
      graceExpired = false;
      graceTimer = setTimeout(() => {
        graceExpired = true;
        const snapshot = ctx.sources.files.get();
        if (snapshot.available) return;
        signature = "";
        draw(snapshot);
      }, LISTING_GRACE_MS);
    }
    ctx.onDispose(() => clearTimeout(graceTimer));
    armGrace();

    // Through onDispose rather than the returned dispose, and with the throw
    // handed to ctx.fail by hand: a widget that throws never gets to return a
    // dispose, and a timer callback that throws otherwise disappears into the
    // event loop leaving a panel that has quietly stopped updating.
    const recheck = setInterval(() => {
      try {
        if (drawnImages.size === 0) return;
        const snapshot = ctx.sources.files.get();
        if (snapshot.updatedAt <= imagesDrawnFrom) return;
        imagesDrawnFrom = snapshot.updatedAt;
        imageGeneration++;
        for (const [img, file] of drawnImages) {
          // Through imageUrl, so the key has one shape: a redraw that follows a
          // tick then lands on the URL the tick already fetched instead of
          // paying for a third one.
          const url = imageUrl(file);
          if (url) img.src = url;
        }
      } catch (err) {
        // Not ctx.fail: this is a cosmetic refresh of something already on
        // screen, and the same file two functions up keeps its rows rather
        // than turning into an error card over a preview. Tearing the whole
        // panel down because a cache-buster threw would be the louder bug.
        console.error("[dashboard] results image re-check failed:", err);
      }
    }, IMAGE_RECHECK_MS);
    ctx.onDispose(() => clearInterval(recheck));

    ctx.subscribe(ctx.sources.files, draw);

    return () => {
      controller.abort();
      el.classList.remove("dash-results");
      el.textContent = "";
    };
  },
};
