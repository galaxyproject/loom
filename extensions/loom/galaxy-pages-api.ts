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
