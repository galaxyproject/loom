import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  galaxyCredentials,
  galaxyGet,
  galaxyGetJobDetails,
  galaxyListHistoryJobs,
  getGalaxyConfig,
  isGalaxyEncodedId,
  isGalaxyFetchOverridden,
  setGalaxyFetchOverride,
  setGalaxyTransport,
} from "../extensions/loom/galaxy-api";

describe("getGalaxyConfig", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  afterEach(() => {
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("returns null when env vars missing", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns null when only URL is set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org";
    delete process.env.GALAXY_API_KEY;
    expect(getGalaxyConfig()).toBeNull();
  });

  it("returns config when env vars set", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org/";
    process.env.GALAXY_API_KEY = "test-key-123";

    const config = getGalaxyConfig();
    expect(config).not.toBeNull();
    expect(config!.url).toBe("https://usegalaxy.org");
    expect(config!.apiKey).toBe("test-key-123");
  });

  it("strips trailing slashes from URL", () => {
    process.env.GALAXY_URL = "https://usegalaxy.org///";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://usegalaxy.org");
  });

  it("prepends https:// when the URL is scheme-less", () => {
    // Config profiles / env often store the host without a scheme
    // ("test.galaxyproject.org/"), which fetch() cannot parse.
    process.env.GALAXY_URL = "test.galaxyproject.org/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("https://test.galaxyproject.org");
  });

  it("preserves an explicit http:// scheme", () => {
    process.env.GALAXY_URL = "http://localhost:8080/";
    process.env.GALAXY_API_KEY = "key";

    const config = getGalaxyConfig();
    expect(config!.url).toBe("http://localhost:8080");
  });
});

describe("galaxyCredentials and the transport", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;

  afterEach(() => {
    setGalaxyTransport(null);
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("reads process env raw by default", () => {
    process.env.GALAXY_URL = "test.galaxyproject.org/";
    process.env.GALAXY_API_KEY = "k";
    expect(galaxyCredentials()).toEqual({ url: "test.galaxyproject.org/", apiKey: "k" });
  });

  it("reads a given env instead of process env", () => {
    process.env.GALAXY_URL = "https://live.example";
    expect(galaxyCredentials({ GALAXY_URL: "https://given.example" })).toEqual({
      url: "https://given.example",
      apiKey: undefined,
    });
  });

  it("lets a transport supply credentials and fetch without marking them a fixture", async () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    const seen: Array<[string, unknown]> = [];
    setGalaxyTransport({
      credentials: () => ({ url: "https://worker.example/", apiKey: "wk" }),
      fetch: async (url, init) => {
        seen.push([url, (init.headers as Record<string, string>)["x-api-key"]]);
        return new Response("{}", { status: 200 });
      },
    });
    expect(getGalaxyConfig()).toEqual({ url: "https://worker.example", apiKey: "wk" });
    await galaxyGet("/whoami");
    expect(seen).toEqual([["https://worker.example/api/whoami", "wk"]]);
    expect(isGalaxyFetchOverridden()).toBe(false);
  });

  it("keeps setGalaxyFetchOverride a fixture", () => {
    setGalaxyFetchOverride(async () => new Response("{}"));
    expect(isGalaxyFetchOverridden()).toBe(true);
    setGalaxyFetchOverride(null);
    expect(isGalaxyFetchOverridden()).toBe(false);
  });

  it("leaves installed credentials alone when a fetch override comes and goes", () => {
    delete process.env.GALAXY_URL;
    setGalaxyTransport({ credentials: () => ({ url: "https://worker.example", apiKey: "wk" }) });
    setGalaxyFetchOverride(async () => new Response("{}"));
    expect(galaxyCredentials().url).toBe("https://worker.example");
    setGalaxyFetchOverride(null);
    expect(galaxyCredentials().url).toBe("https://worker.example");
  });

  it("puts the transport's own fetch back when a fetch override is cleared", async () => {
    process.env.GALAXY_URL = "https://galaxy.example";
    process.env.GALAXY_API_KEY = "k";
    const seen: string[] = [];
    const tagged = (tag: string) => async (url: string) => {
      seen.push(`${tag} ${url}`);
      return new Response("{}", { status: 200 });
    };
    setGalaxyTransport({ fetch: tagged("live") });
    setGalaxyFetchOverride(tagged("fixture"));
    setGalaxyFetchOverride(tagged("fixture2"));
    await galaxyGet("/a");
    setGalaxyFetchOverride(null);
    await galaxyGet("/b");
    expect(seen).toEqual([
      "fixture2 https://galaxy.example/api/a",
      "live https://galaxy.example/api/b",
    ]);
    expect(isGalaxyFetchOverridden()).toBe(false);
  });
});

describe("job details and listing requests", () => {
  const origUrl = process.env.GALAXY_URL;
  const origKey = process.env.GALAXY_API_KEY;
  const seen: string[] = [];

  beforeEach(() => {
    process.env.GALAXY_URL = "https://galaxy.example";
    process.env.GALAXY_API_KEY = "k";
    seen.length = 0;
    setGalaxyFetchOverride(async (url) => {
      seen.push(url);
      const body = url.includes("/jobs?") ? [{ id: "aa" }, { nope: 1 }, "x"] : { id: "aa" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });

  afterEach(() => {
    setGalaxyFetchOverride(null);
    if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
    else delete process.env.GALAXY_URL;
    if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
    else delete process.env.GALAXY_API_KEY;
  });

  it("asks for full details only when told to", async () => {
    await galaxyGetJobDetails("aa");
    await galaxyGetJobDetails("aa", undefined, { full: true });
    expect(seen).toEqual([
      "https://galaxy.example/api/jobs/aa",
      "https://galaxy.example/api/jobs/aa?full=true",
    ]);
  });

  it("lists a history's jobs by day and drops rows without an id", async () => {
    const rows = await galaxyListHistoryJobs({
      historyId: "0a248a1f62a0cc04",
      sinceDay: "2026-10-01",
      limit: 50,
      offset: 100,
    });
    expect(rows).toEqual([{ id: "aa" }]);
    const url = new URL(seen[0]);
    expect(url.pathname).toBe("/api/jobs");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      history_id: "0a248a1f62a0cc04",
      date_range_min: "2026-10-01",
      limit: "50",
      offset: "100",
      order_by: "create_time",
    });
  });

  it("knows a Galaxy id from a path segment", () => {
    expect(isGalaxyEncodedId("0a248a1f62a0cc04")).toBe(true);
    for (const bad of [".", "..", "a/b", "", "0a24 8a", 7]) {
      expect(isGalaxyEncodedId(bad)).toBe(false);
    }
  });
});
