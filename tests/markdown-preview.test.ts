// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  previewImageBaseDir,
  rewritePreviewImageHref,
  buildPreviewMarked,
} from "../app/src/renderer/files/markdown-preview.js";
import { renderMarkdown } from "../app/src/renderer/chat/markdown.js";

/**
 * Issue #283: the File pane's markdown Preview renders relative image
 * references (`![plot](plot.svg)`) with the default `marked` instance, so the
 * `<img src="plot.svg">` resolves against the renderer document's base URL
 * (the app's index.html) instead of the markdown file's directory — broken
 * image. The notebook pane already solved this by rewriting relative srcs to
 * the cwd-jailed `orbit-artifact://` scheme; the File pane just never adopted
 * it. The wrinkle the File pane adds: a markdown file can live in a
 * subdirectory, so refs must resolve against the file's directory, not cwd.
 */

describe("previewImageBaseDir", () => {
  it("returns the POSIX dirname of a file in a subdirectory", () => {
    expect(previewImageBaseDir("reports/summary.md")).toBe("reports");
  });

  it("handles deeply nested files", () => {
    expect(previewImageBaseDir("a/b/c/notes.md")).toBe("a/b/c");
  });

  it("returns empty string for a file at the cwd root", () => {
    expect(previewImageBaseDir("summary.md")).toBe("");
  });

  it("returns empty string for an empty path", () => {
    expect(previewImageBaseDir("")).toBe("");
  });
});

describe("rewritePreviewImageHref", () => {
  it("resolves a relative src against the file's subdirectory", () => {
    expect(rewritePreviewImageHref("reports", "plot.svg")).toBe(
      "orbit-artifact://cwd/reports/plot.svg",
    );
  });

  it("resolves a relative src against the cwd root when baseDir is empty", () => {
    expect(rewritePreviewImageHref("", "plot.svg")).toBe("orbit-artifact://cwd/plot.svg");
  });

  it("normalizes a leading ./", () => {
    expect(rewritePreviewImageHref("reports", "./plot.svg")).toBe(
      "orbit-artifact://cwd/reports/plot.svg",
    );
  });

  it("resolves ../ against the parent directory", () => {
    expect(rewritePreviewImageHref("reports/sub", "../plot.svg")).toBe(
      "orbit-artifact://cwd/reports/plot.svg",
    );
  });

  it("treats a leading-slash href as cwd-root relative (ignores baseDir)", () => {
    expect(rewritePreviewImageHref("reports", "/shared/logo.png")).toBe(
      "orbit-artifact://cwd/shared/logo.png",
    );
  });

  it("leaves absolute http(s) URLs untouched", () => {
    expect(rewritePreviewImageHref("reports", "https://example.com/x.png")).toBe(
      "https://example.com/x.png",
    );
    expect(rewritePreviewImageHref("reports", "http://example.com/x.png")).toBe(
      "http://example.com/x.png",
    );
  });

  it("leaves data: URLs untouched", () => {
    expect(rewritePreviewImageHref("reports", "data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("leaves protocol-relative URLs untouched", () => {
    expect(rewritePreviewImageHref("reports", "//cdn.example.com/x.png")).toBe(
      "//cdn.example.com/x.png",
    );
  });

  it("leaves an already-rewritten orbit-artifact URL untouched", () => {
    expect(rewritePreviewImageHref("reports", "orbit-artifact://cwd/x.png")).toBe(
      "orbit-artifact://cwd/x.png",
    );
  });
});

describe("buildPreviewMarked", () => {
  it("rewrites a relative image src to the file's directory through renderMarkdown", () => {
    const html = renderMarkdown("![plot](plot.svg)", buildPreviewMarked("reports"));
    expect(html).toContain('src="orbit-artifact://cwd/reports/plot.svg"');
    expect(html).toContain('alt="plot"');
  });

  it("preserves the image alt/title text", () => {
    const html = renderMarkdown('![a plot](chart.png "Figure 1")', buildPreviewMarked(""));
    expect(html).toContain('src="orbit-artifact://cwd/chart.png"');
    expect(html).toContain('title="Figure 1"');
  });

  it("does not rewrite absolute image URLs", () => {
    const html = renderMarkdown("![remote](https://example.com/x.png)", buildPreviewMarked("reports"));
    expect(html).toContain('src="https://example.com/x.png"');
    expect(html).not.toContain("orbit-artifact");
  });

  it("leaves relative links (non-images) to default rendering — only images are rewritten", () => {
    const html = renderMarkdown("[see data](data.csv)", buildPreviewMarked("reports"));
    expect(html).not.toContain("orbit-artifact");
  });

  it("the rewritten src survives DOMPurify sanitization", () => {
    // orbit-artifact: is allow-listed in markdown.ts's ALLOWED_URI_REGEXP, so
    // the rewritten src must not be stripped by the sanitizer.
    const html = renderMarkdown("![plot](fig/plot.svg)", buildPreviewMarked("reports"));
    expect(html).toContain("orbit-artifact://cwd/reports/fig/plot.svg");
  });
});

describe("default marked (regression contrast)", () => {
  it("does NOT rewrite relative image srcs — this is the #283 bug", () => {
    const html = renderMarkdown("![plot](plot.svg)");
    expect(html).toContain('src="plot.svg"');
    expect(html).not.toContain("orbit-artifact");
  });
});
