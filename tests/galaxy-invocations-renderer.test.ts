// @vitest-environment happy-dom
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
import {
  describeToolVersions,
  parseInvocationBlocks,
  parseUnattributedJobBlocks,
  refreshGalaxyInvocations,
} from "../app/src/renderer/galaxy-invocations.js";
import { upsertJobBlock, type JobYaml } from "../extensions/loom/galaxy-job-block";
import { upsertInvocationBlock } from "../extensions/loom/notebook-writer";

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

describe("tool versions, enrichment and unattributed runs", () => {
  const strayJob: JobYaml = {
    jobId: "cc33000000000003",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "unattributed",
    label: "fastp (found on Galaxy)",
    toolId: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0",
    submittedAt: "2026-10-07T10:00:00.000Z",
    status: "completed",
    serverVerified: true,
  };

  it("reads an unattributed tool run as the brain's reconcile writes it, and skips bound ones", () => {
    const content =
      upsertJobBlock("", strayJob, {
        submittedBy: "unknown",
        enrichment: "pending",
        enrichmentAttempts: 2,
        enrichmentError: 'Galaxy API 502: "bad gateway"',
        jobs: [{ jobId: strayJob.jobId, toolId: strayJob.toolId, toolVersion: "0.24.0" }],
      }) +
      "\n" +
      upsertJobBlock("", {
        ...strayJob,
        jobId: "dd44000000000004",
        notebookAnchor: "plan-a-step-1",
      });
    const jobs = parseUnattributedJobBlocks(content);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "cc33000000000003",
      label: "fastp (found on Galaxy)",
      submittedBy: "unknown",
      enrichment: "pending",
      enrichmentAttempts: 2,
      enrichmentError: 'Galaxy API 502: "bad gateway"',
    });
  });

  it("describes versions per tool, and counts the unknown ones", () => {
    expect(
      describeToolVersions([
        {
          job_id: "a",
          tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0",
          tool_version: "0.24.0",
        },
        {
          job_id: "b",
          tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0",
          tool_version: "0.24.0",
        },
        { job_id: "c", tool_id: "cat1" },
      ]),
    ).toBe("fastp 0.24.0 · 1 version unknown");
    expect(describeToolVersions(undefined)).toBe("");
  });

  it("draws versions and enrichment on workflow rows, and lists unattributed tool runs", async () => {
    document.body.innerHTML = `
      <div id="activity-galaxy-section" class="hidden">
        <span id="galaxy-invocations-count"></span>
        <div id="galaxy-invocations-body"></div>
      </div>`;
    const notebook =
      upsertInvocationBlock(
        "",
        invocation({ status: "completed", notebookAnchor: "unattributed" }),
        {
          submittedBy: "unknown",
          enrichment: "complete",
          jobs: [{ jobId: "j1", toolId: "bwa_mem", toolVersion: "0.7.17" }],
          drift: [{ toolId: "bwa_mem", from: "0.7.16", to: "0.7.17" }],
        },
      ) +
      "\n" +
      upsertJobBlock(
        "",
        { ...strayJob, label: "<b>x</b>" },
        { submittedBy: "unknown", enrichment: "unavailable" },
      );
    await refreshGalaxyInvocations({
      readFile: async () => ({ ok: true, bytes: new TextEncoder().encode(notebook) }),
    });
    const body = document.getElementById("galaxy-invocations-body")!;
    const text = body.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("found on Galaxy · unattributed · details recorded · 1 version drift");
    expect(text).toContain("bwa_mem 0.7.17");
    expect(body.querySelectorAll(".galaxy-unattributed-job")).toHaveLength(1);
    expect(text).toContain("details unavailable");
    // Galaxy-supplied text is escaped, not rendered.
    expect(body.querySelector(".galaxy-unattributed-job b")).toBeNull();
    expect(document.getElementById("activity-galaxy-section")!.classList.contains("hidden")).toBe(
      false,
    );
  });
});

describe("the registry's verdict on a row", () => {
  it("reads handoff_eligible as the brain renders it, and says it", async () => {
    document.body.innerHTML = `
      <div id="activity-galaxy-section" class="hidden">
        <span id="galaxy-invocations-count"></span>
        <div id="galaxy-invocations-body"></div>
      </div>`;
    const evaluation = {
      execution: "success",
      conformity: "conformant",
      check: "conformant_by_reconcile",
      predicate: "pass",
      integrity: "ok",
      authority: "established",
    };
    const eligible = upsertInvocationBlock("", invocation({ status: "completed" }), {
      evaluation,
      handoffEligible: true,
      registryRevision: 4,
    });
    const held = upsertInvocationBlock(
      "",
      invocation({ invocationId: "inv-2", status: "completed" }),
      {
        evaluation: { ...evaluation, execution: "unknown" },
        handoffEligible: false,
        registryRevision: 4,
      },
    );
    const plain = upsertInvocationBlock("", invocation({ invocationId: "inv-3" }));
    expect(parseInvocationBlocks(eligible)[0].handoffEligible).toBe(true);
    expect(parseInvocationBlocks(held)[0].handoffEligible).toBe(false);
    expect(parseInvocationBlocks(plain)[0].handoffEligible).toBeUndefined();

    const notebook = [eligible, held, plain].join("\n");
    await refreshGalaxyInvocations({
      readFile: async () => ({ ok: true, bytes: new TextEncoder().encode(notebook) }),
    });
    const rows = [...document.querySelectorAll(".galaxy-invocation-row")].map((r) =>
      r.textContent!.replace(/\s+/g, " "),
    );
    expect(
      rows.some((t) => t.includes("eligible to hand off") && !t.includes("not eligible")),
    ).toBe(true);
    expect(rows.some((t) => t.includes("not eligible to hand off"))).toBe(true);
    // A run the registry doesn't know about says nothing either way.
    expect(rows.filter((t) => t.includes("hand off"))).toHaveLength(2);
  });
});

describe("Run elsewhere controls", () => {
  it("sends the exact connection for identical run IDs, including runs bound to a step", async () => {
    document.body.innerHTML =
      '<div id="activity-galaxy-section"><span id="galaxy-invocations-count"></span><div id="galaxy-invocations-body"></div></div>';
    let content = "";
    for (const [name, url] of [
      ["us", "https://usegalaxy.org"],
      ["eu", "https://usegalaxy.eu"],
    ])
      content = upsertJobBlock(
        content,
        {
          jobId: "same-id",
          galaxyServerUrl: url,
          notebookAnchor: "step-one",
          label: name,
          submittedAt: "2026-10-18T12:00:00Z",
          status: "in_progress",
        },
        { connectionId: name, accountId: "account-" + name },
      );
    const prompts: string[] = [];
    await refreshGalaxyInvocations({
      readFile: async () => ({ ok: true, bytes: new TextEncoder().encode(content) }),
      prompt: async (message) => {
        prompts.push(message);
      },
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".galaxy-run-elsewhere")];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) button.click();
    expect(prompts.map((p) => JSON.parse(p.slice("/reroute ".length)).source).sort()).toEqual([
      "eu",
      "us",
    ]);
    expect(document.body.textContent).toContain("account-eu");
  });
});
