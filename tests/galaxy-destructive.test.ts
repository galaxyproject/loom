import { describe, it, expect } from "vitest";
import {
  classifyGalaxyDestructive,
  describeGalaxyDestructive,
  isGalaxyDestructiveCurl,
} from "../shared/galaxy-destructive.js";

describe("classifyGalaxyDestructive -- discrete update_history", () => {
  it("flags deleted=true as a soft (recoverable) history delete", () => {
    expect(
      classifyGalaxyDestructive("galaxy_update_history", { deleted: true, history_id: "abc" }),
    ).toEqual({ kind: "history-delete", historyId: "abc", irreversible: false });
  });

  it("does NOT flag a rename-only update_history", () => {
    expect(classifyGalaxyDestructive("galaxy_update_history", { name: "renamed" })).toBeNull();
  });

  it("does NOT flag deleted=false", () => {
    expect(
      classifyGalaxyDestructive("galaxy_update_history", { deleted: false, history_id: "abc" }),
    ).toBeNull();
  });

  it("works on the bare op name (no galaxy_ prefix)", () => {
    expect(classifyGalaxyDestructive("update_history", { deleted: true })).toMatchObject({
      kind: "history-delete",
    });
  });

  it("normalizes tool-name casing (web-mode passes raw event.toolName)", () => {
    expect(classifyGalaxyDestructive("GALAXY_UPDATE_HISTORY", { deleted: true })).toMatchObject({
      kind: "history-delete",
    });
  });

  it("ignores unrelated galaxy tools", () => {
    expect(classifyGalaxyDestructive("galaxy_get_histories", {})).toBeNull();
    expect(classifyGalaxyDestructive("galaxy_upload_file", { history_id: "abc" })).toBeNull();
  });
});

describe("classifyGalaxyDestructive -- generic mcp proxy envelope (#338 F1)", () => {
  // The pi-mcp-adapter registers a generic `mcp` tool: mcp({ server, tool, args })
  // where args is a JSON *string*. This must not be a bypass.
  it("unwraps mcp({tool, args}) and flags the inner delete", () => {
    expect(
      classifyGalaxyDestructive("mcp", {
        server: "galaxy",
        tool: "galaxy_update_history",
        args: JSON.stringify({ deleted: true, history_id: "h" }),
      }),
    ).toMatchObject({ kind: "history-delete", historyId: "h" });
  });

  it("does NOT flag a non-destructive proxied call", () => {
    expect(
      classifyGalaxyDestructive("mcp", {
        tool: "galaxy_get_histories",
        args: "{}",
      }),
    ).toBeNull();
  });

  it("tolerates malformed (non-JSON) proxy args without throwing", () => {
    expect(
      classifyGalaxyDestructive("mcp", { tool: "galaxy_update_history", args: "not json" }),
    ).toBeNull();
  });
});

describe("classifyGalaxyDestructive -- code mode run_galaxy_tool({code}) (#338 F2)", () => {
  // Real code-mode shape: run_galaxy_tool(code=<python>), where the only callable is
  // call_tool(name, params). Best-effort regex guardrail over the script.
  it("flags a delete issued via call_tool in the code script", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "r = call_tool('update_history', {'history_id': 'h', 'deleted': True})",
      }),
    ).toMatchObject({ kind: "history-delete", historyId: "h" });
  });

  it("flags it through the prefixed name and the mcp proxy wrapping it", () => {
    expect(
      classifyGalaxyDestructive("mcp", {
        tool: "galaxy_run_galaxy_tool",
        args: JSON.stringify({ code: "call_tool('update_history', {'deleted': True})" }),
      }),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("does NOT flag a non-destructive code script", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "hs = call_tool('get_histories', {})",
      }),
    ).toBeNull();
  });

  it("does NOT flag a rename in the code script", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "call_tool('update_history', {'name': 'renamed'})",
      }),
    ).toBeNull();
  });
});

describe("classifyGalaxyDestructive -- post-review hardening", () => {
  it("flags a direct purged=true (defensive, irreversible)", () => {
    expect(
      classifyGalaxyDestructive("galaxy_update_history", { purged: true, history_id: "h" }),
    ).toMatchObject({ kind: "history-purge", irreversible: true });
  });

  it("flags a purge issued in code mode", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "call_tool('update_history', {'purged': True})",
      }),
    ).toMatchObject({ kind: "history-purge", irreversible: true });
  });

  it("catches the code-mode kwargs form call_tool(name=...)", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "call_tool(name='update_history', params={'deleted': True})",
      }),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("catches a galaxy_-prefixed tool name inside the code script", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "call_tool('galaxy_update_history', {'deleted': True})",
      }),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("catches a string-quoted boolean in code (deleted='True')", () => {
    expect(
      classifyGalaxyDestructive("galaxy_run_galaxy_tool", {
        code: "call_tool('update_history', {'deleted': 'True'})",
      }),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("unwraps a whitespace-padded proxied tool name", () => {
    expect(
      classifyGalaxyDestructive("mcp", {
        tool: " galaxy_update_history ",
        args: JSON.stringify({ deleted: true, history_id: "h" }),
      }),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("reads a string-quoted purge in a curl JSON body (#338 hardening)", () => {
    expect(
      isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/histories/h --json '{"purge":"true"}'`),
    ).toMatchObject({ kind: "history-purge", irreversible: true });
  });
});

describe("describeGalaxyDestructive", () => {
  it("purge wording is honest about irreversibility and names the history", () => {
    const { headline } = describeGalaxyDestructive({
      kind: "history-purge",
      historyId: "abc",
      irreversible: true,
    });
    expect(headline).toMatch(/purge/i);
    expect(headline).toMatch(/cannot be undone|permanent/i);
    expect(headline).toContain("abc");
  });

  it("delete wording flags the whole-history scope and recoverability", () => {
    const { headline } = describeGalaxyDestructive({
      kind: "history-delete",
      historyId: "abc",
      irreversible: false,
    });
    expect(headline).toMatch(/entire history/i);
    expect(headline).toMatch(/undelete|recoverable/i);
  });

  it("tolerates a missing history id", () => {
    const { headline } = describeGalaxyDestructive({ kind: "history-purge", irreversible: true });
    expect(typeof headline).toBe("string");
    expect(headline.length).toBeGreaterThan(0);
  });

  it("dataset purge wording names the dataset and says it cannot be undone", () => {
    const { headline } = describeGalaxyDestructive({
      kind: "dataset-purge",
      datasetId: "d1",
      irreversible: true,
    });
    expect(headline).toMatch(/dataset/i);
    expect(headline).toMatch(/cannot be undone|permanent/i);
    expect(headline).toContain("d1");
    expect(headline).not.toMatch(/entire history/i);
  });

  it("dataset delete wording is dataset-scoped and recoverable (not 'entire history')", () => {
    const { headline } = describeGalaxyDestructive({
      kind: "dataset-delete",
      datasetId: "d1",
      irreversible: false,
    });
    expect(headline).toMatch(/dataset/i);
    expect(headline).toMatch(/undelete|recoverable/i);
    expect(headline).not.toMatch(/entire history/i);
  });
});

describe("isGalaxyDestructiveCurl", () => {
  it("flags curl -X DELETE against /api/histories/ (soft)", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE https://galaxy.example.org/api/histories/abc123"),
    ).toMatchObject({ kind: "history-delete", historyId: "abc123", irreversible: false });
  });

  it("reads purge=true off the URL query as an irreversible purge", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE 'https://g/api/histories/abc?purge=true'"),
    ).toMatchObject({ kind: "history-purge", irreversible: true });
  });

  it("reads purge from the DELETE request BODY, not just the query (#338 F3)", () => {
    expect(
      isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/histories/abc -d '{"purge":true}'`),
    ).toMatchObject({ kind: "history-purge", irreversible: true });
  });

  it("still flags a command with a shell-variable history id (#338 F4)", () => {
    const op = isGalaxyDestructiveCurl(`curl -X DELETE "$GALAXY_URL/api/histories/$HID?purge=true"`);
    expect(op).toMatchObject({ kind: "history-purge", irreversible: true });
    expect(op?.historyId).toBeUndefined(); // don't surface a fake literal id
  });

  it("matches the bunched -XDELETE form", () => {
    expect(isGalaxyDestructiveCurl("curl -XDELETE https://g/api/histories/abc")).toMatchObject({
      kind: "history-delete",
    });
  });

  it("matches the --request DELETE form", () => {
    expect(
      isGalaxyDestructiveCurl("curl --request DELETE https://g/api/histories/abc"),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("matches wget --method=DELETE (#338 F5)", () => {
    expect(
      isGalaxyDestructiveCurl("wget --method=DELETE https://g/api/histories/abc"),
    ).toMatchObject({ kind: "history-delete" });
  });

  it("requires an actual curl/wget verb -- a bare DELETE URL elsewhere does not match (#338 F5)", () => {
    expect(isGalaxyDestructiveCurl("http DELETE https://g/api/histories/abc")).toBeNull();
  });

  it("flags a dataset-level /contents/ DELETE as a dataset delete (soft)", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE https://g/api/histories/abc/contents/d1"),
    ).toMatchObject({ kind: "dataset-delete", datasetId: "d1", irreversible: false });
  });

  it("flags a dataset purge (?purge=true on /contents/) as irreversible", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE 'https://g/api/histories/abc/contents/d1?purge=true'"),
    ).toMatchObject({ kind: "dataset-purge", datasetId: "d1", irreversible: true });
  });

  it("flags a dataset purge carried in the request body", () => {
    expect(
      isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/histories/abc/contents/d1 -d '{"purge":true}'`),
    ).toMatchObject({ kind: "dataset-purge", irreversible: true });
  });

  it("still flags a dataset delete with a shell-variable id (no fake literal)", () => {
    const op = isGalaxyDestructiveCurl(`curl -X DELETE "$URL/api/histories/$H/contents/$DS?purge=true"`);
    expect(op).toMatchObject({ kind: "dataset-purge", irreversible: true });
    expect(op?.datasetId).toBeUndefined();
  });

  it("does NOT flag a GET", () => {
    expect(isGalaxyDestructiveCurl("curl -X GET https://g/api/histories")).toBeNull();
  });

  it("does NOT flag a DELETE to a non-histories endpoint", () => {
    expect(isGalaxyDestructiveCurl("curl -X DELETE https://example.com/api/other/abc")).toBeNull();
  });

  it("does NOT flag a plain (default GET) curl", () => {
    expect(isGalaxyDestructiveCurl("curl https://g/api/histories/abc")).toBeNull();
  });
});

describe("isGalaxyDestructiveCurl -- post-codex hardening (#345)", () => {
  it("flags the singleton DELETE /api/datasets/{id} route", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE 'https://g/api/datasets/d1?purge=true'"),
    ).toMatchObject({ kind: "dataset-purge", datasetId: "d1", irreversible: true });
  });

  it("flags the batch DELETE /api/datasets route (ids in body, no literal id)", () => {
    const op = isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/datasets -d '{"purge":true}'`);
    expect(op?.kind).toBe("dataset-purge");
  });

  it("treats purge=1 / yes / on as an irreversible purge", () => {
    for (const v of ["1", "yes", "on"]) {
      expect(
        isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/datasets/d1?purge=${v}`),
        v,
      ).toMatchObject({ kind: "dataset-purge", irreversible: true });
    }
  });

  it("treats an unverifiable purge value (shell variable) as irreversible, not recoverable", () => {
    expect(
      isGalaxyDestructiveCurl(`curl -X DELETE "https://g/api/datasets/d1?purge=$DOPURGE"`),
    ).toMatchObject({ kind: "dataset-purge", irreversible: true });
  });

  it("treats a file-ref request body on a delete as purge-ambiguous (irreversible)", () => {
    expect(
      isGalaxyDestructiveCurl(`curl -X DELETE https://g/api/datasets/d1 --data @payload.json`),
    ).toMatchObject({ kind: "dataset-purge", irreversible: true });
  });

  it("respects an explicit purge=false as a recoverable soft delete", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE 'https://g/api/datasets/d1?purge=false'"),
    ).toMatchObject({ kind: "dataset-delete", irreversible: false });
  });

  it("prefers the whole-history op when a command also contains a dataset URL", () => {
    expect(
      isGalaxyDestructiveCurl(
        "curl -X DELETE https://g/api/histories/H https://g/api/histories/H/contents/D",
      ),
    ).toMatchObject({ kind: "history-delete", historyId: "H" });
  });

  it("extracts the real id from a typed /contents/datasets/{id} route", () => {
    expect(
      isGalaxyDestructiveCurl("curl -X DELETE https://g/api/histories/H/contents/datasets/D"),
    ).toMatchObject({ kind: "dataset-delete", datasetId: "D" });
  });

  it("classifies a dataset_collection delete as a collection, not a single dataset", () => {
    const op = isGalaxyDestructiveCurl(
      "curl -X DELETE 'https://g/api/histories/H/contents/dataset_collections/C?purge=true'",
    );
    expect(op).toMatchObject({ kind: "collection-purge", collectionId: "C", irreversible: true });
  });
});

describe("describeGalaxyDestructive -- collection wording", () => {
  it("collection purge names the collection and flags all its datasets, irreversibly", () => {
    const { headline } = describeGalaxyDestructive({
      kind: "collection-purge",
      collectionId: "C",
      irreversible: true,
    });
    expect(headline).toMatch(/collection/i);
    expect(headline).toMatch(/all|every|its datasets/i);
    expect(headline).toMatch(/cannot be undone|permanent/i);
    expect(headline).toContain("C");
  });
});
