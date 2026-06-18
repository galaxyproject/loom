import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { galaxyGetMostRecentHistory } from "./galaxy-api.js";

describe("galaxyGetMostRecentHistory", () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env.GALAXY_URL = "https://g.example";
    process.env.GALAXY_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = origFetch;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    vi.restoreAllMocks();
  });

  it("calls most_recently_used with the api key and returns the history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "h1", name: "My History" }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const h = await galaxyGetMostRecentHistory();
    expect(h?.id).toBe("h1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://g.example/api/histories/most_recently_used",
      expect.objectContaining({ headers: { "x-api-key": "k" } }),
    );
  });

  it("returns null when Galaxy returns an empty body", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => null }) as unknown as typeof fetch;
    expect(await galaxyGetMostRecentHistory()).toBeNull();
  });
});
