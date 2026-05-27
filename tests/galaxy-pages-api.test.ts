/**
 * Tests for the Galaxy Pages REST client.
 *
 * Fixtures match Galaxy PR #22361 @ 8c702ecd. Re-verify against the merged
 * contract before wiring tools to this client; if these tests pass but real
 * Galaxy calls fail, the upstream schema has moved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as galaxyApi from "../extensions/loom/galaxy-api";
import {
  createPage,
  getPage,
  getPageRevisionDetails,
  getPageRevisions,
  listHistoryPages,
  updatePage,
  type GalaxyPage,
  type GalaxyPageRevisionDetails,
  type GalaxyPageRevisionSummary,
  type GalaxyPageSummary,
} from "../extensions/loom/galaxy-pages-api";

const origUrl = process.env.GALAXY_URL;
const origKey = process.env.GALAXY_API_KEY;

beforeEach(() => {
  process.env.GALAXY_URL = "https://usegalaxy.org";
  process.env.GALAXY_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (origUrl !== undefined) process.env.GALAXY_URL = origUrl;
  else delete process.env.GALAXY_URL;
  if (origKey !== undefined) process.env.GALAXY_API_KEY = origKey;
  else delete process.env.GALAXY_API_KEY;
});

describe("listHistoryPages", () => {
  it("hits /pages with the history_id query param", async () => {
    const get = vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue([] as GalaxyPageSummary[]);
    await listHistoryPages("hist-123");
    expect(get).toHaveBeenCalledWith("/pages?history_id=hist-123", undefined);
  });

  it("url-encodes the history id", async () => {
    const get = vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue([] as GalaxyPageSummary[]);
    await listHistoryPages("hist with spaces/and slashes");
    expect(get).toHaveBeenCalledWith(
      "/pages?history_id=hist%20with%20spaces%2Fand%20slashes",
      undefined,
    );
  });
});

describe("getPage", () => {
  it("returns the page with content + content_format", async () => {
    const fixture: GalaxyPage = {
      id: "page-abc",
      title: "My Analysis",
      slug: "my-analysis",
      history_id: "hist-1",
      content: "# Hello\n",
      content_format: "markdown",
      edit_source: "agent",
      create_time: "2026-04-01T00:00:00Z",
      update_time: "2026-05-14T00:00:00Z",
      latest_revision_id: "rev-3",
      revision_ids: ["rev-1", "rev-2", "rev-3"],
    };
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(fixture);
    const got = await getPage("page-abc");
    expect(got).toEqual(fixture);
  });
});

describe("createPage", () => {
  it("posts /pages with markdown content_format and no edit_source", async () => {
    const post = vi.spyOn(galaxyApi, "galaxyPost").mockResolvedValue({
      id: "page-new",
      title: "T",
      slug: "t",
      history_id: "h",
      latest_revision_id: "rev-1",
      create_time: "2026-05-14T00:00:00Z",
      update_time: "2026-05-14T00:00:00Z",
    } as GalaxyPageSummary);

    await createPage({
      title: "My Analysis",
      content: "# heading",
      history_id: "hist-1",
    });

    expect(post).toHaveBeenCalledWith(
      "/pages",
      {
        title: "My Analysis",
        content: "# heading",
        content_format: "markdown",
        history_id: "hist-1",
      },
      undefined,
    );
    // edit_source must NOT appear in the create body — upstream CreatePagePayload
    // doesn't expose it and would silently drop it (extra="allow").
    expect(post.mock.calls[0][1]).not.toHaveProperty("edit_source");
  });

  it("passes optional slug + annotation through when provided", async () => {
    const post = vi.spyOn(galaxyApi, "galaxyPost").mockResolvedValue({
      id: "page-new",
      title: "T",
      slug: "custom",
      history_id: "h",
      latest_revision_id: "rev-1",
      create_time: "x",
      update_time: "x",
    } as GalaxyPageSummary);

    await createPage({
      title: "T",
      content: "c",
      history_id: "h",
      slug: "custom",
      annotation: "for review",
    });

    expect(post.mock.calls[0][1]).toMatchObject({
      slug: "custom",
      annotation: "for review",
    });
  });
});

describe("updatePage", () => {
  function mockPutOk() {
    return vi.spyOn(galaxyApi, "galaxyPut").mockResolvedValue({
      id: "page-1",
      title: "T",
      slug: "t",
      history_id: "h",
      latest_revision_id: "rev-2",
      create_time: "x",
      update_time: "y",
    } as GalaxyPageSummary);
  }

  it("puts /pages/{id} with markdown content_format and the given edit_source", async () => {
    const put = mockPutOk();
    await updatePage("page-1", {
      content: "new body",
      title: "Updated Title",
      edit_source: "agent",
    });

    expect(put).toHaveBeenCalledWith(
      "/pages/page-1",
      {
        content: "new body",
        content_format: "markdown",
        edit_source: "agent",
        title: "Updated Title",
      },
      undefined,
    );
  });

  it("defaults edit_source to \"agent\" when the caller doesn't supply one", async () => {
    // This client only sees Loom-authored sync writes, so making each
    // call site remember `edit_source: "agent"` is a footgun. Default it
    // here; callers can override with an explicit value if needed.
    const put = mockPutOk();
    await updatePage("page-1", { content: "x" });

    expect(put.mock.calls[0][1]).toEqual({
      content: "x",
      content_format: "markdown",
      edit_source: "agent",
    });
  });

  it("honors an explicit edit_source override", async () => {
    const put = mockPutOk();
    await updatePage("page-1", { content: "x", edit_source: "user" });

    expect(put.mock.calls[0][1]).toMatchObject({ edit_source: "user" });
  });

  it("omits title and annotation when unset", async () => {
    const put = mockPutOk();
    await updatePage("page-1", { content: "x" });

    const body = put.mock.calls[0][1];
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("annotation");
  });
});

describe("getPageRevisions vs getPageRevisionDetails — the revision split", () => {
  // The main contract correction in this client. The list endpoint returns
  // PageRevisionSummary[] — id, page_id, edit_source, create_time,
  // update_time — and *not* content or title. To get the body you must
  // call the per-revision details endpoint. The summary type and details
  // type are intentionally distinct so a misuse (reading rev.content from
  // the list) is a compile-time error, not a runtime undefined.

  it("getPageRevisions returns summaries without content", async () => {
    const summary: GalaxyPageRevisionSummary = {
      id: "rev-1",
      page_id: "page-1",
      edit_source: "agent",
      create_time: "2026-05-14T00:00:00Z",
      update_time: "2026-05-14T00:00:00Z",
    };
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue([summary]);

    const got = await getPageRevisions("page-1");
    expect(got).toEqual([summary]);
    // Belt-and-suspenders: the summary fixture has no content field.
    expect((got[0] as Record<string, unknown>).content).toBeUndefined();
  });

  it("getPageRevisionDetails returns content + title", async () => {
    const details: GalaxyPageRevisionDetails = {
      id: "rev-1",
      page_id: "page-1",
      edit_source: "agent",
      create_time: "2026-05-14T00:00:00Z",
      update_time: "2026-05-14T00:00:00Z",
      title: "My Analysis (rev 1)",
      content: "# heading\n",
      content_format: "markdown",
    };
    vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue(details);

    const got = await getPageRevisionDetails("page-1", "rev-1");
    expect(got.content).toBe("# heading\n");
    expect(got.title).toBe("My Analysis (rev 1)");
  });

  it("getPageRevisionDetails url-encodes both ids", async () => {
    const get = vi.spyOn(galaxyApi, "galaxyGet").mockResolvedValue({
      id: "r",
      page_id: "p",
      create_time: "x",
      update_time: "x",
    } as GalaxyPageRevisionDetails);

    await getPageRevisionDetails("page/with/slashes", "rev:with:colons");
    expect(get).toHaveBeenCalledWith(
      "/pages/page%2Fwith%2Fslashes/revisions/rev%3Awith%3Acolons",
      undefined,
    );
  });
});
