import { describe, expect, it } from "vitest";

import type { Galaxy } from "./galaxy";
import { recordsOn, slugForSession } from "./records";

const SESSION = "4f2a9c1b-7d3e-4a21-9f00-1b2c3d4e5f60";
const NOVA = { id: "nova", name: "Nova" };

/** A Galaxy answering each path with what `get` says. */
const galaxy = (get: (path: string) => unknown) =>
  ({ get: async (path: string) => get(path) }) as unknown as Galaxy;

describe("a session's record page", () => {
  it("derives a legal Galaxy slug from the session", () => {
    const slug = slugForSession(SESSION);
    expect(slug).toBe(`orbit-${SESSION}`);
    expect(slugForSession(SESSION, NOVA)).toBe(`nova-${SESSION}`);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("gives two sessions different slugs", () => {
    expect(slugForSession(SESSION)).not.toBe(
      slugForSession("9a8b7c6d-0000-4000-8000-111122223333"),
    );
  });
});

describe("the records attached to a history", () => {
  it("lists the brand's records attached to a history, by the session each belongs to", async () => {
    const g = galaxy((path) =>
      path === "api/pages?history_id=h1"
        ? [
            { id: "p1", slug: "orbit-a", title: "A", create_time: "1", update_time: "2026-10-01" },
            { id: "p2", slug: "orbit-b", title: "B", create_time: "1", update_time: "2026-10-03" },
            { id: "p3", slug: "results", title: "Not a record", update_time: "2026-10-04" },
            { id: "p4", slug: "orbit-c", title: "Gone", deleted: true },
          ]
        : [],
    );
    const records = await recordsOn(g, "h1");
    expect(records.map((r) => [r.pageId, r.sessionId])).toEqual([
      ["p2", "b"],
      ["p1", "a"],
    ]);
  });
});
