// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  historyToMarkdown,
  fragmentToMarkdown,
  computeCopyButtonPlacement,
  type MessageRecord,
} from "../app/src/renderer/chat/chat-panel.js";

// ── historyToMarkdown ────────────────────────────────────────────────────────

describe("historyToMarkdown", () => {
  it("returns empty string for empty history", () => {
    expect(historyToMarkdown([])).toBe("");
  });

  it("formats a user message", () => {
    const records: MessageRecord[] = [{ role: "user", text: "hello" }];
    expect(historyToMarkdown(records)).toBe("**You**\n\nhello\n");
  });

  it("formats an assistant message", () => {
    const records: MessageRecord[] = [{ role: "assistant", text: "hi there" }];
    expect(historyToMarkdown(records)).toBe("**Assistant**\n\nhi there\n");
  });

  it("formats a tool call with done status and no result", () => {
    const records: MessageRecord[] = [{ role: "tool", id: "t1", name: "bash", status: "done" }];
    expect(historyToMarkdown(records)).toBe("*Tool call ✓: `bash`*\n");
  });

  it("formats a tool call with error status", () => {
    const records: MessageRecord[] = [{ role: "tool", id: "t1", name: "bash", status: "error" }];
    expect(historyToMarkdown(records)).toBe("*Tool call ✗: `bash`*\n");
  });

  it("formats a running tool call", () => {
    const records: MessageRecord[] = [{ role: "tool", id: "t1", name: "bash", status: "running" }];
    expect(historyToMarkdown(records)).toBe("*Tool call …: `bash`*\n");
  });

  it("includes tool result in a code fence when present", () => {
    const records: MessageRecord[] = [
      { role: "tool", id: "t1", name: "bash", status: "done", result: "hello world" },
    ];
    expect(historyToMarkdown(records)).toBe("*Tool call ✓: `bash`*\n\n```\nhello world\n```\n");
  });

  it("formats an error message", () => {
    const records: MessageRecord[] = [{ role: "error", text: "something broke" }];
    expect(historyToMarkdown(records)).toBe("*Error: something broke*\n");
  });

  it("skips info records", () => {
    const records: MessageRecord[] = [{ role: "info", text: "— Resumed —" }];
    expect(historyToMarkdown(records)).toBe("");
  });

  it("joins multiple records with --- separators", () => {
    const records: MessageRecord[] = [
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ];
    expect(historyToMarkdown(records)).toBe(
      "**You**\n\nquestion\n\n---\n\n**Assistant**\n\nanswer\n",
    );
  });
});

// ── fragmentToMarkdown ───────────────────────────────────────────────────────

function html(markup: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = markup;
  return div;
}

describe("fragmentToMarkdown", () => {
  it("converts plain text", () => {
    expect(fragmentToMarkdown(html("hello world"))).toBe("hello world");
  });

  it("converts <strong>", () => {
    expect(fragmentToMarkdown(html("<strong>bold</strong>"))).toBe("**bold**");
  });

  it("converts <b>", () => {
    expect(fragmentToMarkdown(html("<b>bold</b>"))).toBe("**bold**");
  });

  it("converts <em>", () => {
    expect(fragmentToMarkdown(html("<em>italic</em>"))).toBe("*italic*");
  });

  it("converts <i>", () => {
    expect(fragmentToMarkdown(html("<i>italic</i>"))).toBe("*italic*");
  });

  it("converts <del>", () => {
    expect(fragmentToMarkdown(html("<del>struck</del>"))).toBe("~~struck~~");
  });

  it("converts <s>", () => {
    expect(fragmentToMarkdown(html("<s>struck</s>"))).toBe("~~struck~~");
  });

  it("converts inline <code>", () => {
    expect(fragmentToMarkdown(html("<code>fn()</code>"))).toBe("`fn()`");
  });

  it("converts <pre><code> with language", () => {
    expect(fragmentToMarkdown(html('<pre><code class="language-python">x = 1</code></pre>'))).toBe(
      "```python\nx = 1\n```",
    );
  });

  it("converts <pre><code> without language", () => {
    expect(fragmentToMarkdown(html("<pre><code>x = 1</code></pre>"))).toBe("```\nx = 1\n```");
  });

  it("does not double-wrap <code> inside <pre>", () => {
    const result = fragmentToMarkdown(html("<pre><code>x</code></pre>"));
    expect(result).not.toContain("``x``");
    expect(result).toBe("```\nx\n```");
  });

  it("converts <h1>", () => {
    expect(fragmentToMarkdown(html("<h1>Title</h1>"))).toBe("# Title");
  });

  it("converts <h2>", () => {
    expect(fragmentToMarkdown(html("<h2>Sub</h2>"))).toBe("## Sub");
  });

  it("converts <h3> through <h6>", () => {
    expect(fragmentToMarkdown(html("<h3>A</h3>"))).toBe("### A");
    expect(fragmentToMarkdown(html("<h4>A</h4>"))).toBe("#### A");
    expect(fragmentToMarkdown(html("<h5>A</h5>"))).toBe("##### A");
    expect(fragmentToMarkdown(html("<h6>A</h6>"))).toBe("###### A");
  });

  it("converts <p>", () => {
    expect(fragmentToMarkdown(html("<p>paragraph</p>"))).toBe("paragraph");
  });

  it("converts <br>", () => {
    expect(fragmentToMarkdown(html("line1<br>line2"))).toBe("line1\nline2");
  });

  it("converts <ul>", () => {
    expect(fragmentToMarkdown(html("<ul><li>a</li><li>b</li></ul>"))).toBe("- a\n- b");
  });

  it("converts <ol> with sequential numbering", () => {
    expect(fragmentToMarkdown(html("<ol><li>first</li><li>second</li></ol>"))).toBe(
      "1. first\n2. second",
    );
  });

  it("converts <a>", () => {
    expect(fragmentToMarkdown(html('<a href="https://example.com">link</a>'))).toBe(
      "[link](https://example.com)",
    );
  });

  it("converts <blockquote>", () => {
    expect(fragmentToMarkdown(html("<blockquote>quoted</blockquote>"))).toBe("> quoted");
  });

  it("converts <hr>", () => {
    expect(fragmentToMarkdown(html("<hr>"))).toBe("---");
  });

  it("handles nested formatting: bold inside paragraph", () => {
    expect(fragmentToMarkdown(html("<p><strong>bold</strong> plain</p>"))).toBe("**bold** plain");
  });

  it("handles nested formatting: italic inside bold", () => {
    expect(fragmentToMarkdown(html("<strong><em>both</em></strong>"))).toBe("***both***");
  });
});

// ── computeCopyButtonPlacement ───────────────────────────────────────────────

describe("computeCopyButtonPlacement", () => {
  const viewport = { width: 1000, height: 800 };
  const cont = { top: 100, bottom: 700 };

  it("hides when the selection has no size", () => {
    const r = { top: 0, bottom: 0, right: 0, width: 0, height: 0 };
    expect(computeCopyButtonPlacement(r, cont, viewport)).toEqual({ hidden: true });
  });

  it("hides when the selection scrolled above the chat's visible area", () => {
    const r = { top: 40, bottom: 60, right: 500, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(r, cont, viewport)).toEqual({ hidden: true });
  });

  it("hides when the selection scrolled below the chat's visible area", () => {
    const r = { top: 720, bottom: 740, right: 500, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(r, cont, viewport)).toEqual({ hidden: true });
  });

  it("pins just below a selection that is comfortably in view", () => {
    const r = { top: 300, bottom: 320, right: 500, width: 200, height: 20 };
    const p = computeCopyButtonPlacement(r, cont, viewport);
    expect(p.hidden).toBe(false);
    if (!p.hidden) expect(p.top).toBe(324); // bottom + 4
  });

  it("flips above the selection near the viewport bottom", () => {
    // A chat that fills the viewport: selection sits low enough that the button
    // would overflow the bottom edge, so it flips above the selection.
    const tallCont = { top: 100, bottom: 790 };
    const r = { top: 760, bottom: 780, right: 500, width: 200, height: 20 };
    const p = computeCopyButtonPlacement(r, tallCont, viewport);
    expect(p.hidden).toBe(false);
    if (!p.hidden) expect(p.top).toBe(760 - 28 - 4); // top - bh - 4
  });

  it("clamps the left edge into the viewport", () => {
    const r = { top: 300, bottom: 320, right: 4, width: 4, height: 20 };
    const p = computeCopyButtonPlacement(r, cont, viewport);
    expect(p.hidden).toBe(false);
    if (!p.hidden) expect(p.left).toBe(4); // clamped to min 4
  });

  it("clamps the right edge into the viewport", () => {
    const r = { top: 300, bottom: 320, right: 1200, width: 200, height: 20 };
    const p = computeCopyButtonPlacement(r, cont, viewport);
    expect(p.hidden).toBe(false);
    if (!p.hidden) expect(p.left).toBe(1000 - 80 - 4); // viewport.width - bw - 4
  });
});
