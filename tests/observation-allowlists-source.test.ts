import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";

import { GALAXY_MCP_TOOLS } from "../extensions/loom/observation-allowlists";
import { GALAXY_ALLOWLIST_EXTRA_NAMES } from "../scripts/galaxy-allowlist-extra-names.mjs";

// observation-allowlists.ts is generated, so nothing else notices when the
// installed galaxy-ops gains or loses an operation and the file was not
// regenerated: the new name would just be dropped from every observation.

const ROOT = join(__dirname, "..");

// The list as generated from galaxy-mcp v1.10.0's server.py, before the
// generator moved to galaxy-ops.
const BEFORE_GALAXY_OPS = [
  "cancel_workflow_invocation",
  "connect",
  "create_history",
  "create_page",
  "create_user_tool",
  "delete_user_tool",
  "download_dataset",
  "get_collection_details",
  "get_dataset_details",
  "get_histories",
  "get_history_contents",
  "get_history_details",
  "get_invocations",
  "get_iwc_workflow_details",
  "get_iwc_workflows",
  "get_job_details",
  "get_page",
  "get_page_revision",
  "get_schemas",
  "get_server_info",
  "get_tool_citations",
  "get_tool_details",
  "get_tool_input_template",
  "get_tool_panel",
  "get_tool_run_examples",
  "get_user",
  "get_workflow_details",
  "get_workflow_input_template",
  "import_workflow_from_iwc",
  "invoke_workflow",
  "list_history_ids",
  "list_page_revisions",
  "list_pages",
  "list_user_tools",
  "list_workflows",
  "recommend_iwc_workflows",
  "revert_page_revision",
  "run_galaxy_tool",
  "run_tool",
  "run_user_tool",
  "search",
  "search_iwc_workflows",
  "search_tools_by_keywords",
  "search_tools_by_name",
  "update_history",
  "update_page",
  "upload_file",
  "upload_file_from_url",
].map((name) => `galaxy_${name}`);

describe("the generated Galaxy tool allowlist", () => {
  const generated = [...GALAXY_MCP_TOOLS];
  // allOperations is shared with the browser entry, so read it once, here.
  const operations = [...allOperations].map((op) => op.name);

  it("is galaxy-ops' operations plus the extra names, in the wire spelling", () => {
    expect(generated.every((name) => name.startsWith("galaxy_"))).toBe(true);
    const names = generated.map((name) => name.replace(/^galaxy_/, "")).sort();
    expect(names).toEqual([...new Set([...operations, ...GALAXY_ALLOWLIST_EXTRA_NAMES])].sort());
  });

  it("holds only names galaxy-ops lacks in the extra list", () => {
    expect(GALAXY_ALLOWLIST_EXTRA_NAMES.filter((name) => operations.includes(name))).toEqual([]);
  });

  it("names the installed galaxy-ops in its header", () => {
    const { version } = JSON.parse(
      readFileSync(join(ROOT, "node_modules/@galaxyproject/galaxy-ops/package.json"), "utf-8"),
    ) as { version: string };
    const source = readFileSync(join(ROOT, "extensions/loom/observation-allowlists.ts"), "utf-8");
    expect(source).toContain(`@galaxyproject/galaxy-ops ${version}, allOperations (Node entry)`);
  });

  it("only gained recommend_biocontainer when it moved to galaxy-ops", () => {
    expect(generated.filter((name) => !BEFORE_GALAXY_OPS.includes(name))).toEqual([
      "galaxy_recommend_biocontainer",
    ]);
    expect(BEFORE_GALAXY_OPS.filter((name) => !GALAXY_MCP_TOOLS.has(name))).toEqual([]);
  });
});
