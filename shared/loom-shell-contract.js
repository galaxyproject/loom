export const LoomWidgetKey = {
  Plan: "plan",
  Steps: "steps",
  Results: "results",
  Parameters: "parameters",
  Notebook: "notebook",
  NotebookEmbed: "notebook-embed",
  EmbedToken: "embed-token",
  PlanView: "plan-view",
  Activity: "activity",
};

export function encodeMarkdownWidget(markdown) {
  return [markdown];
}

export function decodeMarkdownWidget(lines) {
  return (lines || []).join("\n");
}

export function encodeJsonWidget(value) {
  return [JSON.stringify(value)];
}

export function decodeJsonWidget(lines) {
  if (!lines || lines.length === 0) {
    throw new Error("Widget payload missing");
  }
  return JSON.parse(lines[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// NotebookEmbed — binding/embed state for the server-side Galaxy iframe view.
// Shell-neutral: carries the absolute embed URL + binding identity, never the
// embed token (that goes to the shell's privileged process out of band).
// ─────────────────────────────────────────────────────────────────────────────

export function encodeNotebookEmbed(payload) {
  return encodeJsonWidget(payload);
}

export function decodeNotebookEmbed(lines) {
  return decodeJsonWidget(lines);
}

// ─────────────────────────────────────────────────────────────────────────────
// EmbedToken — the short-lived, page-scoped embed token. Unlike every other
// widget this NEVER reaches the renderer: the brain emits it on this dedicated
// key and the shell's privileged process (Orbit main) intercepts and holds it,
// injecting it into the locked-down iframe partition's request headers. A shell
// without a privileged interceptor (the Loom CLI) simply ignores the key.
// ─────────────────────────────────────────────────────────────────────────────

export function encodeEmbedToken(payload) {
  return encodeJsonWidget(payload);
}

export function decodeEmbedToken(lines) {
  return decodeJsonWidget(lines);
}
