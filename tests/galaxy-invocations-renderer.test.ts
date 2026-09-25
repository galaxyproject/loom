/**
 * The Orbit Activity panel parses `loom-invocation` blocks itself rather than
 * importing the brain's parser (renderer/main boundary), so the two parsers
 * drift silently unless something pins them together. This covers the half the
 * brain just started writing: `server_verified`.
 */

import { describe, expect, it } from "vitest";
import {
  findInvocationBlocks,
  renderInvocationYaml,
  type InvocationYaml,
} from "../extensions/loom/notebook-writer";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "BWA alignment",
    submittedAt: "2026-09-16T15:30:00Z",
    status: "in_progress",
    ...overrides,
  };
}

describe("renderer parseInvocationBlocks", () => {
  it("reads server_verified as the brain writes it", () => {
    for (const verified of [true, false]) {
      const parsed = parseInvocationBlocks(
        renderInvocationYaml(invocation({ serverVerified: verified })),
      );
      expect(parsed[0].serverVerified).toBe(verified);
    }
  });

  it("leaves a block without the field unclaimed rather than unverified", () => {
    const parsed = parseInvocationBlocks(renderInvocationYaml(invocation()));
    expect(parsed[0].serverVerified).toBeUndefined();
  });

  it("still parses every other field the panel draws", () => {
    const parsed = parseInvocationBlocks(
      renderInvocationYaml(
        invocation({
          serverVerified: false,
          totalSteps: 3,
          completedSteps: 1,
          totalJobs: 6,
          completedJobs: 2,
          failedJobs: 0,
        }),
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      invocationId: "inv-1",
      label: "BWA alignment",
      status: "in_progress",
      totalSteps: 3,
      completedJobs: 2,
    });
  });
});

describe("the two parsers agree on what a block needs", () => {
  // The harness records a submission whether or not GALAXY_URL happened to be
  // set, and the brain's parser was relaxed to read those blocks back. The
  // renderer kept requiring the url, so a verified, pollable run was simply
  // absent from Activity -- the worst shape for a panel whose whole job is
  // showing what is running.
  it("reads a block with no galaxy_server_url, same as the brain", () => {
    const content = renderInvocationYaml(invocation({ galaxyServerUrl: "", serverVerified: true }));
    expect(findInvocationBlocks(content)).toHaveLength(1);

    const rows = parseInvocationBlocks(content);
    expect(rows).toHaveLength(1);
    expect(rows[0].galaxyServerUrl).toBe("");
    expect(rows[0].serverVerified).toBe(true);
  });

  it("still drops a block with no id, same as the brain", () => {
    const content = [
      "```loom-invocation",
      "galaxy_server_url: https://usegalaxy.org",
      "notebook_anchor: plan-a-step-1",
      "label: BWA alignment",
      "submitted_at: 2026-09-16T15:30:00Z",
      "status: in_progress",
      "```",
    ].join("\n");
    expect(findInvocationBlocks(content)).toHaveLength(0);
    expect(parseInvocationBlocks(content)).toHaveLength(0);
  });
});
