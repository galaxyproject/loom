/**
 * Galaxy Pages API client — typed wrappers for the /api/pages endpoints
 * introduced in galaxyproject/galaxy#22361 (Galaxy Notebooks).
 *
 * Contract matches Galaxy PR #22361 @ 8c702ecd. The PR is still open and the
 * shape may move; tests use hand-rolled fixtures pinned to that SHA. When the
 * PR merges, re-verify against the released contract.
 *
 * Notes on the contract corrections this client makes vs. an earlier draft:
 *
 *   - `GET /api/pages/{id}/revisions` returns `PageRevisionSummary[]` —
 *     `{id, page_id, edit_source, create_time, update_time}` only, no
 *     content or title. Full body is at
 *     `GET /api/pages/{id}/revisions/{revision_id}` which returns
 *     `PageRevisionDetails`. Two calls, not one.
 *
 *   - `edit_source` is only meaningful on the update payload. The create
 *     payload silently drops it (`extra="allow"` on the pydantic model),
 *     so don't send it on create.
 *
 *   - `content_format` defaults to `"html"` server-side; always pass
 *     `"markdown"` explicitly for notebook content.
 *
 * No tools are registered against these calls yet — the client lands now,
 * the tool wiring waits for #22361 to merge.
 */

import { galaxyGet, galaxyPost, galaxyPut } from "./galaxy-api";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed subset of upstream `PageSummary` (galaxyproject/galaxy schema.py).
 * Includes only the fields the sync layer consumes; other required fields
 * (username, email_hash, published, deleted, etc.) are returned by the API
 * but unused here. `latest_revision_id` is the field push/pull stores into
 * the binding's `last_synced_revision` after every successful sync.
 */
export interface GalaxyPageSummary {
  id: string;
  title: string;
  slug: string | null;
  history_id?: string | null;
  latest_revision_id: string;
  revision_ids?: string[];
  create_time: string;
  update_time: string;
}

export interface GalaxyPage extends GalaxyPageSummary {
  content?: string;
  content_format?: "markdown" | "html";
  edit_source?: "user" | "agent" | "restore";
  /**
   * Chrome-free, frame-embeddable URL for the page's latest revision. Galaxy
   * returns this *path-relative* (honors a deployment prefix, no host), so the
   * brain builds the absolute embed URL itself via galaxy-embed.ts rather than
   * consuming this directly. Present only on `PageDetails` (the `getPage` shape).
   */
  embed_url?: string | null;
}

/**
 * Response of `POST /api/pages/{id}/embed_token` (upstream `PageEmbedToken`):
 * a short-lived, page-scoped token authenticating a read-only embedded render,
 * plus its UTC expiry. See galaxy schema.py `PageEmbedToken`.
 */
export interface GalaxyEmbedToken {
  token: string;
  expires_at: string;
}

/** What `GET /api/pages/{id}/revisions` actually returns — no content. */
export interface GalaxyPageRevisionSummary {
  id: string;
  page_id: string;
  edit_source?: "user" | "agent" | "restore";
  create_time: string;
  update_time: string;
}

/** What `GET /api/pages/{id}/revisions/{revision_id}` returns — full body. */
export interface GalaxyPageRevisionDetails extends GalaxyPageRevisionSummary {
  title?: string;
  content?: string;
  content_format?: "markdown" | "html";
}

export interface CreatePageParams {
  title: string;
  content: string;
  history_id: string;
  slug?: string;
  content_format?: "markdown" | "html";
  annotation?: string;
}

export interface UpdatePageParams {
  content: string;
  title?: string;
  content_format?: "markdown" | "html";
  annotation?: string;
  /** Agent-authored edits should set this to "agent" for provenance. */
  edit_source?: "user" | "agent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages API
// ─────────────────────────────────────────────────────────────────────────────

export async function listHistoryPages(
  historyId: string,
  signal?: AbortSignal,
): Promise<GalaxyPageSummary[]> {
  return galaxyGet<GalaxyPageSummary[]>(
    `/pages?history_id=${encodeURIComponent(historyId)}`,
    signal,
  );
}

/** A page entry trimmed to what the discovery tool surfaces. `history_id` is
 *  the load-bearing field: a real history notebook has one, a workflow
 *  *invocation report* has `null` -- only the former can be resumed and read
 *  back as a bound history. */
export interface RecentPage {
  page_id: string;
  title: string;
  slug: string | null;
  history_id: string | null;
  update_time: string;
}

/**
 * List the user's own pages, most-recently-updated first. Wraps the unscoped
 * `GET /api/pages` (which Galaxy returns in ascending update order, so we sort
 * client-side) and projects each entry down to the fields a cold-start resume
 * needs to pick a page. `limit` caps the returned list; pass 0 / omit for all.
 */
export async function listRecentPages(
  opts: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<RecentPage[]> {
  const pages = await galaxyGet<GalaxyPageSummary[]>("/pages", signal);
  const sorted = [...pages].sort((a, b) =>
    (b.update_time ?? "").localeCompare(a.update_time ?? ""),
  );
  const limited = opts.limit && opts.limit > 0 ? sorted.slice(0, opts.limit) : sorted;
  return limited.map((p) => ({
    page_id: p.id,
    title: p.title,
    slug: p.slug ?? null,
    history_id: p.history_id ?? null,
    update_time: p.update_time,
  }));
}

export async function getPage(pageId: string, signal?: AbortSignal): Promise<GalaxyPage> {
  return galaxyGet<GalaxyPage>(`/pages/${encodeURIComponent(pageId)}`, signal);
}

export async function createPage(
  params: CreatePageParams,
  signal?: AbortSignal,
): Promise<GalaxyPageSummary> {
  const body: Record<string, unknown> = {
    title: params.title,
    content: params.content,
    content_format: params.content_format ?? "markdown",
    history_id: params.history_id,
  };
  if (params.slug !== undefined) body.slug = params.slug;
  if (params.annotation !== undefined) body.annotation = params.annotation;
  return galaxyPost<GalaxyPageSummary>("/pages", body, signal);
}

export async function updatePage(
  pageId: string,
  params: UpdatePageParams,
  signal?: AbortSignal,
): Promise<GalaxyPageSummary> {
  // Every update flowing through this client is Loom-authored sync, so
  // default `edit_source` to "agent" rather than making each call site
  // remember to set it. Callers can still pass an explicit value to
  // override (e.g. a future "manual revert" path setting "user").
  const body: Record<string, unknown> = {
    content: params.content,
    content_format: params.content_format ?? "markdown",
    edit_source: params.edit_source ?? "agent",
  };
  if (params.title !== undefined) body.title = params.title;
  if (params.annotation !== undefined) body.annotation = params.annotation;
  return galaxyPut<GalaxyPageSummary>(`/pages/${encodeURIComponent(pageId)}`, body, signal);
}

/**
 * Mint a short-lived, page-scoped embed token for `pageId`. Auth is the normal
 * API key (this client's `galaxyPost`); Galaxy authorizes the caller as the page
 * owner/sharer before minting. The token authenticates the read-only embedded
 * render and its nested dataset/viz frames; the brain refreshes it before
 * `expires_at` (see galaxy-embed.ts `shouldRefreshToken`).
 */
export async function mintEmbedToken(
  pageId: string,
  signal?: AbortSignal,
): Promise<GalaxyEmbedToken> {
  return galaxyPost<GalaxyEmbedToken>(
    `/pages/${encodeURIComponent(pageId)}/embed_token`,
    {},
    signal,
  );
}

export async function getPageRevisions(
  pageId: string,
  signal?: AbortSignal,
): Promise<GalaxyPageRevisionSummary[]> {
  return galaxyGet<GalaxyPageRevisionSummary[]>(
    `/pages/${encodeURIComponent(pageId)}/revisions`,
    signal,
  );
}

export async function getPageRevisionDetails(
  pageId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<GalaxyPageRevisionDetails> {
  return galaxyGet<GalaxyPageRevisionDetails>(
    `/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revisionId)}`,
    signal,
  );
}
