export const LoomWidgetKey: {
  readonly Plan: "plan";
  readonly Steps: "steps";
  readonly Results: "results";
  readonly Parameters: "parameters";
  readonly Notebook: "notebook";
  readonly NotebookEmbed: "notebook-embed";
  readonly EmbedToken: "embed-token";
  readonly PlanView: "plan-view";
  readonly Activity: "activity";
};

export interface ShellActivityEvent {
  timestamp: string;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

export interface ShellStep {
  id: string;
  name: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  dependsOn: string[];
  result?: string;
  command?: string;
}

export interface ResultBlock {
  stepName?: string;
  type: "markdown" | "table" | "image" | "file";
  content?: string;
  headers?: string[];
  rows?: string[][];
  path?: string;
  caption?: string;
}

export interface ParameterOption {
  label: string;
  value: string;
}

export interface ParameterSpec {
  name: string;
  type: "text" | "integer" | "float" | "boolean" | "select" | "file";
  label: string;
  help: string;
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: ParameterOption[];
  fileFilter?: string;
  usedBy?: string[];
}

export interface ParameterGroup {
  title: string;
  description: string;
  params: ParameterSpec[];
}

export interface ParameterFormPayload {
  planId: string;
  title: string;
  description: string;
  groups: ParameterGroup[];
}

/**
 * Binding/embed state for the server-side Galaxy notebook iframe view.
 *
 * When `bound` is false the notebook has no `loom-galaxy-page` binding and every
 * other field is null — shells render the "run /sync push to view in Galaxy"
 * fallback. `embedUrl` is absolute and ready for an `<iframe src>`. The embed
 * token is intentionally absent: it is delivered to the shell's privileged
 * process out of band and never reaches the renderer.
 */
export interface NotebookEmbedPayload {
  bound: boolean;
  pageId: string | null;
  historyId: string | null;
  galaxyUrl: string | null;
  embedUrl: string | null;
  lastSyncedRevision: string | null;
}

export function encodeMarkdownWidget(markdown: string): string[];
export function decodeMarkdownWidget(lines: string[] | undefined): string;
export function encodeJsonWidget<T>(value: T): string[];
export function decodeJsonWidget<T>(lines: string[] | undefined): T;
export function encodeNotebookEmbed(payload: NotebookEmbedPayload): string[];
export function decodeNotebookEmbed(lines: string[] | undefined): NotebookEmbedPayload;

/**
 * The short-lived, page-scoped embed token plus its expiry. Delivered on the
 * dedicated `EmbedToken` widget key, which — unlike all other widgets — the
 * shell's privileged process intercepts and never forwards to the renderer (see
 * loom-shell-contract.js). `expiresAt` is an ISO-8601 UTC timestamp.
 */
export interface EmbedTokenWidgetPayload {
  pageId: string;
  token: string;
  expiresAt: string;
}

export function encodeEmbedToken(payload: EmbedTokenWidgetPayload): string[];
export function decodeEmbedToken(lines: string[] | undefined): EmbedTokenWidgetPayload;
