/**
 * The Orbit renderer reads notebook blocks with its own parsers, so they need
 * the same both-prefixes guarantee the brain's readers have.
 */

import { describe, expect, it } from "vitest";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import { renderJobYaml, type JobYaml } from "../extensions/loom/galaxy-job-block";
import {
  renderGalaxyPageBlock,
  type GalaxyPageBindingYaml,
} from "../extensions/loom/galaxy-page-binding";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";
import { parseGalaxyHistoryBindings } from "../app/src/renderer/galaxy-history.js";
import { parseJobBlocks } from "../app/src/renderer/dashboard/data-sources.js";

function as(prefix: string, block: string): string {
  return block.replace(/^```[a-z]+-/, "```" + prefix + "-");
}

const inv: InvocationYaml = {
  invocationId: "inv-1",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-1",
  label: "Align reads",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
};

const job: JobYaml = {
  jobId: "job-1",
  galaxyServerUrl: "https://usegalaxy.org",
  notebookAnchor: "plan-a-step-2",
  label: "FastQC",
  toolId: "fastqc",
  submittedAt: "2026-09-01T10:00:00Z",
  status: "in_progress",
  summary: "",
};

const binding: GalaxyPageBindingYaml = {
  pageId: "page-1",
  pageSlug: "my-page",
  galaxyServerUrl: "https://usegalaxy.org",
  historyId: "hist-1",
  lastSyncedRevision: "rev-1",
  boundAt: "2026-09-01T10:00:00Z",
};

describe("Orbit renderer parsers", () => {
  it("read invocation, job and binding blocks the same under either prefix", () => {
    const blocks = [renderInvocationYaml(inv), renderJobYaml(job), renderGalaxyPageBlock(binding)];
    const loom = blocks.map((b) => as("loom", b)).join("\n");
    const orbit = blocks.map((b) => as("orbit", b)).join("\n");
    expect(parseInvocationBlocks(orbit)).toHaveLength(1);
    expect(parseInvocationBlocks(orbit)).toEqual(parseInvocationBlocks(loom));
    expect(parseJobBlocks(orbit)).toHaveLength(1);
    expect(parseJobBlocks(orbit)).toEqual(parseJobBlocks(loom));
    expect(parseGalaxyHistoryBindings(orbit)).toEqual([{ historyId: "hist-1" }]);
    expect(parseGalaxyHistoryBindings(orbit)).toEqual(parseGalaxyHistoryBindings(loom));
  });
});
