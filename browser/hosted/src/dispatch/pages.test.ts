import { describe, expect, it } from "vitest";

import type { ConversationRow } from "./conversations";
import { galaxyPageCreator } from "./pages";

const conversation: ConversationRow = {
  id: "Conv1",
  ownerSub: "alice",
  title: "Variants",
  storeId: "store-1",
  pageId: null,
  durableConversationId: null,
  interrupted: false,
  paused: false,
  lastActiveAt: new Date(),
};

/** A Galaxy that keeps pages by slug and refuses a second one with the same slug, as PageManager.create does. */
function stubGalaxy() {
  const pages = new Map<string, string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const { slug } = JSON.parse(String(init.body)) as { slug: string };
      if (pages.has(slug))
        return Response.json(
          { err_msg: "Page identifier must be unique", err_code: 400008 },
          { status: 400 },
        );
      const id = `page-${pages.size + 1}`;
      pages.set(slug, id);
      return Response.json({ id, slug });
    }
    const search = url.searchParams.get("search") ?? "";
    const term = search.replace(/^slug:/, "").replace(/'/g, "");
    return Response.json(
      [...pages].filter(([slug]) => slug.includes(term)).map(([slug, id]) => ({ id, slug })),
    );
  }) as typeof fetch;
  return { pages, fetchImpl };
}

describe("galaxyPageCreator", () => {
  it("creates the conversation's page", async () => {
    const galaxy = stubGalaxy();
    const pageFor = galaxyPageCreator({
      galaxyUrl: "https://galaxy.test",
      tokens: { token: async () => "t", forget() {} },
      fetch: galaxy.fetchImpl,
    });
    expect(await pageFor(conversation)).toBe("page-1");
    expect(galaxy.pages.get("orbit-conv1")).toBe("page-1");
  });

  it("adopts the page an earlier boot created but never recorded, instead of failing on the slug forever", async () => {
    const galaxy = stubGalaxy();
    const pageFor = galaxyPageCreator({
      galaxyUrl: "https://galaxy.test",
      tokens: { token: async () => "t", forget() {} },
      fetch: galaxy.fetchImpl,
    });
    await pageFor(conversation);
    expect(await pageFor(conversation)).toBe("page-1");
    expect(galaxy.pages.size).toBe(1);
  });

  it("still fails when Galaxy refuses for another reason", async () => {
    const pageFor = galaxyPageCreator({
      galaxyUrl: "https://galaxy.test",
      tokens: { token: async () => "t", forget() {} },
      fetch: (async () => Response.json([], { status: 403 })) as typeof fetch,
    });
    await expect(pageFor(conversation)).rejects.toThrow("HTTP 403");
  });
});
