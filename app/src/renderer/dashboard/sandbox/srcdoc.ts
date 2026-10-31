/**
 * Assembles the document that goes into the frame.
 *
 * The one invariant worth stating plainly: **nothing the agent wrote can
 * appear before the CSP meta**. It holds by construction here -- the policy,
 * the charset and the bridge are concatenated first and the content is
 * appended after -- and a test asserts it rather than trusting the reading.
 *
 * A second `<meta>` CSP inside the content cannot help an attacker: policies
 * compose by intersection, so an additional one can only narrow what is
 * already allowed. That is a claim about the browser and not about this code,
 * so the tests below pin only what this file controls -- that ours is first
 * and intact.
 */

import { SANDBOX_FRAME_CSP } from "./policy.js";
import { SANDBOX_BRIDGE_SOURCE } from "./bridge.js";

export interface SandboxDocumentOptions {
  /** The agent-authored markup, dropped into `<body>` as-is. */
  html: string;
  /** Shown as the frame's document title; never rendered by us. */
  title?: string;
  /** Orbit's current theme, so the content is not black-on-black. */
  theme?: "dark" | "light";
}

/** Escapes text destined for RCDATA (`<title>`) or an attribute value. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DARK = {
  fg: "#f0f2f8",
  muted: "rgba(240, 242, 248, 0.72)",
  bg: "#343a50",
  deep: "#232838",
  border: "rgba(255, 255, 255, 0.15)",
  accent: "#ffd700",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  scheme: "dark",
};

const LIGHT = {
  fg: "#1f2937",
  muted: "rgba(31, 41, 55, 0.72)",
  bg: "#ffffff",
  deep: "#e8edf5",
  border: "rgba(31, 41, 55, 0.22)",
  accent: "#b77900",
  ok: "#17803d",
  warn: "#b77900",
  bad: "#c03434",
  scheme: "light",
};

/**
 * The frame cannot load a font (`default-src 'none'` and no `font-src`), so
 * the stack is whatever the OS already has. Orbit's own Inter is a bundled
 * file and deliberately out of reach.
 */
function baseStyle(theme: "dark" | "light"): string {
  const t = theme === "light" ? LIGHT : DARK;
  return `
:root {
  color-scheme: ${t.scheme};
  --loom-fg: ${t.fg};
  --loom-muted: ${t.muted};
  --loom-bg: ${t.bg};
  --loom-deep: ${t.deep};
  --loom-border: ${t.border};
  --loom-accent: ${t.accent};
  --loom-ok: ${t.ok};
  --loom-warn: ${t.warn};
  --loom-bad: ${t.bad};
}
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  color: var(--loom-fg);
  background: transparent;
  overflow-x: hidden;
  overflow-wrap: anywhere;
}
a { color: var(--loom-accent); }
`.trim();
}

/**
 * A `<script>` or `<style>` element ends at the first matching close tag in
 * its text, so anything we inline must not contain one. Ours do not; this
 * turns "must not" into a failure rather than a subtle breakout.
 */
function assertNoCloseTag(source: string, tag: "script" | "style"): void {
  if (new RegExp(`</\\s*${tag}`, "i").test(source)) {
    throw new Error(`sandbox ${tag} source contains a closing ${tag} tag`);
  }
}

export function buildSandboxDocument(opts: SandboxDocumentOptions): string {
  const theme = opts.theme === "light" ? "light" : "dark";
  const style = baseStyle(theme);
  assertNoCloseTag(style, "style");
  assertNoCloseTag(SANDBOX_BRIDGE_SOURCE, "script");

  // The config this comes from is whatever was in the layout file, so `title`
  // can be a number, an object, anything. A view should not become an error
  // card over a typo in a field we only use for the document title.
  const rawTitle = typeof opts.title === "string" ? opts.title : "";
  const title = escapeText(rawTitle.slice(0, 200) || "Custom view");

  // Order is the point of this function. Policy, then charset, then our own
  // style and bridge, then -- last, and only last -- the agent's markup.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${escapeText(SANDBOX_FRAME_CSP)}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${title}</title>`,
    `<style>\n${style}\n</style>`,
    `<script>${SANDBOX_BRIDGE_SOURCE}</script>`,
    "</head>",
    "<body>",
    opts.html,
    "</body>",
    "</html>",
  ].join("\n");
}
