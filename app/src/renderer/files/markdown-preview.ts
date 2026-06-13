/**
 * Markdown-preview helpers for the File pane (#283).
 *
 * The File pane's Preview renders agent/report-authored markdown that often
 * embeds local images via relative paths (`![plot](plot.svg)`). Rendered with
 * the default `marked`, those `<img src="plot.svg">` resolve against the
 * renderer document's base URL (the app's index.html), not the markdown file's
 * directory, so valid reports show broken images.
 *
 * The notebook pane already solved the same class of problem by rewriting
 * relative srcs to the cwd-jailed `orbit-artifact://` scheme served by the main
 * process (see `artifacts/artifact-panel.ts` + the `protocol.handle` in
 * `main/main.ts`). The File pane reuses that exact scheme — no new file-access
 * surface — with one difference: a File-pane markdown file can live in a
 * subdirectory of the cwd, so a relative ref must resolve against the file's
 * directory, not the cwd root.
 *
 * These helpers are kept DOM-free (the `marked` import is pure JS) so they can
 * be unit-tested in a plain Node/happy-dom environment, mirroring
 * `image-preview.ts`.
 */

import { Marked } from "marked";

/** Leading scheme (`https:`, `data:`, `orbit-artifact:`) or protocol-relative `//`. */
const ABSOLUTE_OR_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * POSIX dirname of a cwd-relative path (paths from `files:list` always use
 * forward slashes). `reports/summary.md` → `reports`; `summary.md` → ``.
 */
export function previewImageBaseDir(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

/** Collapse `.`/`..` segments in a POSIX path, preserving any leading `..`. */
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/**
 * Rewrite a relative image href to the cwd-jailed `orbit-artifact://` scheme,
 * resolved against `baseDir` (the markdown file's directory, relative to cwd).
 * Absolute URLs, other schemes, and protocol-relative URLs pass through
 * untouched. A leading-slash href is treated as cwd-root relative (baseDir
 * ignored), matching the notebook pane's convention.
 *
 * The `orbit-artifact` protocol handler re-resolves the path against the live
 * cwd and refuses anything that escapes it via `..`/symlinks, so this is the
 * single security boundary — we only produce a best-effort clean path here.
 */
export function rewritePreviewImageHref(baseDir: string, href: string): string {
  if (ABSOLUTE_OR_SCHEME.test(href)) return href;
  const rooted = href.startsWith("/");
  const joined = rooted || !baseDir ? href.replace(/^\/+/, "") : `${baseDir}/${href}`;
  const normalized = normalizePosix(joined);
  return `orbit-artifact://cwd/${normalized}`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A `Marked` instance whose image renderer resolves relative srcs against
 * `baseDir`. Only images are overridden — links keep marked's default
 * rendering so click/navigation behavior is unchanged. Pass the result as the
 * second arg to `renderMarkdown(...)` so the shared sanitizer still runs.
 */
export function buildPreviewMarked(baseDir: string): Marked {
  return new Marked({
    renderer: {
      image({ href, title, text }) {
        const rewritten = rewritePreviewImageHref(baseDir, href ?? "");
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<img src="${escapeAttr(rewritten)}" alt="${escapeAttr(text ?? "")}"${titleAttr}>`;
      },
    },
  });
}
