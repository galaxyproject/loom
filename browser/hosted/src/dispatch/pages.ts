/**
 * Each conversation's record lives on a Galaxy page of its own, created as the user the first time a
 * worker boots for it. Slice 3's page binding (commit 7) will let Orbit create and bind pages itself;
 * until then the host makes one so the page record store has somewhere to write.
 */
import { fetchSameOriginOnly } from "../../../../shared/redirect-guard.js";
import type { TokenCache } from "../tokens/token-cache";
import type { ConversationRow } from "./conversations";

interface PageOptions {
  readonly galaxyUrl: string;
  readonly tokens: TokenCache;
  readonly fetch?: typeof fetch;
}

/** A request to Galaxy's pages API as the conversation's owner. */
async function asOwner(
  options: PageOptions,
  ownerSub: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  const token = await options.tokens.token(ownerSub);
  return fetchSameOriginOnly(
    new URL(path, options.galaxyUrl).href,
    {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { fetchImpl: options.fetch, serverLabel: "The Galaxy server" },
  );
}

export function galaxyPageCreator(options: PageOptions): (conversation: ConversationRow) => Promise<string> {
  return async (conversation) => {
    // Galaxy wants a slug unique per user, of lowercase letters, digits and dashes.
    const slug = `orbit-${conversation.id.toLowerCase()}`;
    const response = await asOwner(options, conversation.ownerSub, "/api/pages", "POST", {
      slug,
      title: conversation.title ?? "Orbit conversation",
      content_format: "markdown",
      content: "",
    });
    if (!response.ok) {
      // A boot that created the page but died before recording it leaves the slug taken, and every
      // later create is refused: adopt that page.
      if (response.status === 400) {
        const existing = await existingPage((path) => asOwner(options, conversation.ownerSub, path, "GET"), slug);
        if (existing) return existing;
      }
      throw new Error(`Galaxy refused to create the conversation's page: HTTP ${response.status}`);
    }
    const page = (await response.json()) as { id?: unknown };
    if (typeof page.id !== "string")
      throw new Error("Galaxy created the page but didn't say its id");
    return page.id;
  };
}

/**
 * Give an existing page the conversation's title. A page made before the conversation had one is
 * named generically; a title-only update changes the page's name without adding a revision.
 */
export function galaxyPageRetitler(options: PageOptions): (conversation: ConversationRow) => Promise<void> {
  return async (conversation) => {
    if (conversation.pageId === null || conversation.title === null) return;
    const response = await asOwner(options, conversation.ownerSub, `/api/pages/${encodeURIComponent(conversation.pageId)}`, "PUT", {
      title: conversation.title,
    });
    if (!response.ok) throw new Error(`Galaxy refused to retitle the conversation's page: HTTP ${response.status}`);
  };
}

async function existingPage(
  request: (path: string) => Promise<Response>,
  slug: string,
): Promise<string | undefined> {
  // An unquoted slug filter is a substring match, so the exact slug is checked here.
  const response = await request(
    `/api/pages?${new URLSearchParams({ show_own: "true", search: `slug:${slug}` })}`,
  );
  if (!response.ok) return undefined;
  const pages = (await response.json()) as { id?: unknown; slug?: unknown }[];
  const page = Array.isArray(pages) ? pages.find((p) => p.slug === slug) : undefined;
  return typeof page?.id === "string" ? page.id : undefined;
}
