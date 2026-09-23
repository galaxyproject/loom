import { describe, expect, it } from "vitest";
import {
  galaxyArtifactUrl,
  galaxyArtifactReferences,
  normalizeGalaxyLinkServer,
  type GalaxyArtifactKind,
} from "../shared/galaxy-artifact-links.js";

// Synthetic encoded IDs; these tests do not request real Galaxy artifacts.
const id = "0123456789abcdef";
const server = "https://example.org/galaxy";

describe("Galaxy artifact destinations", () => {
  it.each<[GalaxyArtifactKind, string]>([
    ["history", `/histories/view?id=${id}`],
    ["dataset", `/datasets/${id}`],
    ["collection", `/collection/${id}/sheet`],
    ["job", `/jobs/${id}/view`],
    ["invocation", `/workflows/invocations/${id}`],
    ["workflow", `/published/workflow?id=${id}`],
    ["page", `/published/page?id=${id}`],
    ["revision", `/api/pages/abcdef0123456789/revisions/${id}`],
  ])("builds a %s view URL preserving the server prefix", (kind, path) => {
    expect(galaxyArtifactUrl(`${server}///`, kind, id, { pageId: "abcdef0123456789" })).toBe(
      `${server}${path}`,
    );
  });

  it("encodes tool IDs as query values", () => {
    expect(galaxyArtifactUrl(server, "tool", "shed/repos/user/tool/1.0+galaxy1")).toBe(
      `${server}/?tool_id=shed%2Frepos%2Fuser%2Ftool%2F1.0%2Bgalaxy1`,
    );
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc",
    "//example.org",
    "https://user:secret@example.org",
    "https://example.org?key=secret",
    "https://example.org#fragment",
    "bad URL",
  ])("rejects unsafe/malformed server %s", (url) => {
    expect(normalizeGalaxyLinkServer(url)).toBeNull();
    expect(galaxyArtifactUrl(url, "dataset", id)).toBeNull();
  });

  it("rejects path/query injection and revisions without a parent page", () => {
    for (const value of ["../histories", "abc?x=1", '<img onerror="boom">', "", "123-uuid", "15"]) {
      expect(galaxyArtifactUrl(server, "dataset", value)).toBeNull();
    }
    expect(galaxyArtifactUrl(server, "revision", id)).toBeNull();
    expect(galaxyArtifactUrl("http://localhost:8080/galaxy", "server")).toBe(
      "http://localhost:8080/galaxy",
    );
  });

  it("uses a block's server instead of the connected server and preserves source ranges", () => {
    const text = `page_id: ${id}\npage_slug: \ngalaxy_server_url: "${server}"\nhistory_id: 0123456789abcdeffedcba9876543210\nlast_synced_revision: abcdef0123456789\nbound_at: 2026-09-23T18:18:00.000Z`;
    const refs = galaxyArtifactReferences(text, "https://wrong.example");
    expect(refs.map((r) => r.kind)).toEqual(["page", "server", "history", "revision"]);
    expect(refs.every((r) => r.href.startsWith(server))).toBe(true);
    expect(refs.map((r) => text.slice(r.start, r.end))).toEqual([
      id,
      server,
      "0123456789abcdeffedcba9876543210",
      "abcdef0123456789",
    ]);
  });

  it("does not guess among multiple servers or page IDs", () => {
    expect(
      galaxyArtifactReferences(
        `galaxy_server_url: https://a.example\ngalaxy_server_url: https://b.example\ndataset_id: ${id}`,
        server,
      ),
    ).toEqual([]);
    expect(
      galaxyArtifactReferences(`galaxy_server_url: javascript:bad\ndataset_id: ${id}`, server),
    ).toEqual([]);
    expect(
      galaxyArtifactReferences(
        `page_id: ${id}\npage_id: aabbccddeeff0011\nrevision_id: aabbccddeeff0022`,
        server,
      ).map((r) => r.kind),
    ).toEqual(["page", "page"]);
  });

  it("requires explicit artifact types, not bare hashes or numeric history item numbers", () => {
    expect(galaxyArtifactReferences(`hash ${id}; dataset 15; 2026-09-23`, server)).toEqual([]);
    expect(galaxyArtifactReferences(`Dataset ID: ${id}`, server)[0]?.href).toBe(
      `${server}/datasets/${id}`,
    );
    expect(galaxyArtifactReferences(`dataset ${id}`)).toEqual([]);
    expect(galaxyArtifactReferences(`dataset_id: ${id}.`, server)[0]?.href).toBe(
      `${server}/datasets/${id}`,
    );
  });

  it("does not confuse internal invocation workflow versions with stored workflows", () => {
    const refs = galaxyArtifactReferences(
      `invocation_id: ${id}\nworkflow_id: aabbccddeeff0011\nstored_workflow_id: aabbccddeeff0022`,
      server,
    );
    expect(refs.map((r) => r.href)).toEqual([
      `${server}/workflows/invocations/${id}`,
      `${server}/published/workflow?id=aabbccddeeff0022`,
    ]);
  });
});
