/**
 * The records a brand keeps attached to a history: Galaxy pages named after the session that owns
 * each, so a session the browser no longer holds can be found again through its history.
 */
import { query, type Galaxy } from "./galaxy";
import { DEFAULT_BRAND, type Brand } from "./brand";

type Page = Record<string, any>;

/** The slug of a session's record page: the brand's, then the session's id. */
export const slugForSession = (sessionId: string, brand: Brand = DEFAULT_BRAND) =>
  `${brand.id}-${sessionId}`;

/**
 * A record of this brand's attached to a history: the session that owns it, found again through the
 * history it was started on once the browser holds nothing of that session.
 */
export interface RecordSummary {
  pageId: string;
  sessionId: string;
  title: string;
  created: string;
  updated: string;
}

/** The brand's records Galaxy keeps attached to `historyId`, most recently updated first. */
export async function recordsOn(
  galaxy: Galaxy,
  historyId: string,
  brand: Brand = DEFAULT_BRAND,
): Promise<RecordSummary[]> {
  const prefix = slugForSession("", brand);
  const pages: unknown = await galaxy.get(`api/pages${query({ history_id: historyId })}`);
  return (Array.isArray(pages) ? (pages as Page[]) : [])
    .flatMap((page) => {
      const slug = typeof page.slug === "string" ? page.slug : "";
      const session = slug.startsWith(prefix) ? slug.slice(prefix.length) || undefined : undefined;
      return session && !page.deleted
        ? [
            {
              pageId: String(page.id),
              sessionId: session,
              title: String(page.title ?? page.slug),
              created: String(page.create_time ?? ""),
              updated: String(page.update_time ?? ""),
            },
          ]
        : [];
    })
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
