import {
  galaxyArtifactReferences,
  galaxyLinkServerInText,
} from "../../../../shared/galaxy-artifact-links.js";

/**
 * Link explicit Galaxy references in an already sanitized DOM. Text and code
 * remain byte-for-byte copyable; existing links and executable code fences are
 * untouched. Never infer an artifact's type from a bare hash.
 */
export function linkGalaxyArtifacts(
  root: HTMLElement | DocumentFragment,
  serverUrl?: string | null,
): void {
  const scopes = Array.from(root.querySelectorAll<HTMLElement>("pre, p, li, td, th")).filter(
    (el) => !el.querySelector("pre, p, li, td, th"),
  );
  if (!scopes.length && root instanceof HTMLElement) scopes.push(root);
  // Only typed metadata declares a server. A normal web link is not a Galaxy
  // connection. Multiple explicit servers disable the document-wide fallback.
  const declared = scopes
    .filter(eligible)
    .map((el) => galaxyLinkServerInText(el.textContent ?? ""));
  const explicit = new Set(declared.filter((value) => value !== null));
  const fallback = explicit.size ? (explicit.size === 1 ? [...explicit][0] : null) : serverUrl;
  for (const scope of scopes) {
    if (!eligible(scope)) continue;
    const text = scope.textContent ?? "";
    // Reverse order keeps earlier text offsets stable while inserting anchors.
    for (const ref of galaxyArtifactReferences(text, fallback).reverse()) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let start: { node: Text; offset: number } | undefined;
      let end: { node: Text; offset: number } | undefined;
      let blocked = false;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const next = offset + node.length;
        if (next > ref.start && offset < ref.end) {
          if (node.parentElement?.closest("a, button, script, style, textarea")) blocked = true;
          start ??= { node, offset: Math.max(0, ref.start - offset) };
          end = { node, offset: Math.min(node.length, ref.end - offset) };
        }
        offset = next;
      }
      if (blocked || !start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const link = document.createElement("a");
      link.href = ref.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "galaxy-artifact-link";
      link.title =
        ref.kind === "revision"
          ? "View saved Galaxy page revision (JSON)"
          : `Open Galaxy ${ref.kind}`;
      link.appendChild(range.extractContents());
      range.insertNode(link);
    }
  }
}

function eligible(el: HTMLElement): boolean {
  if (el.tagName !== "PRE") return true;
  const language = el.querySelector("code")?.className ?? "";
  // Don't turn Python, shell scripts, or Markdown examples into UI controls.
  return (
    !language ||
    /\blanguage-(?:loom-galaxy-page|loom-invocation|loom-job|ya?ml|json|text)\b/.test(language)
  );
}
