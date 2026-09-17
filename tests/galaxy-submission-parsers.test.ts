import { describe, it, expect } from "vitest";
import {
  isSubmissionTool,
  parseSubmission,
  resolveResultPayload,
  SUBMISSION_TOOLS,
} from "../extensions/loom/galaxy-submission";

/**
 * Fixtures are the shapes galaxy-mcp 1.9.0 actually returns, per the spike in
 * `loom-harness-next-steps/notes/2026-09-16-galaxy-mcp-result-shapes.md` and
 * re-checked against the pinned sdist. Every tool wraps its payload in a
 * `GalaxyResult` and FastMCP serialises the whole envelope into one text
 * block, so that is what the fixtures are: a pi tool result whose single text
 * content block holds the envelope JSON.
 */
function mcpResult(envelope: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: { server: "galaxy", ...details },
  };
}

const INVOKE_WORKFLOW = {
  data: {
    id: "ff1e2d3c4b5a6978",
    model_class: "WorkflowInvocation",
    create_time: "2026-09-16T15:30:00.000000",
    update_time: "2026-09-16T15:30:00.000000",
    workflow_id: "c0ffee1234567890",
    history_id: "0a248a1f62a0cc04",
    uuid: "4f2a8c11-0a5e-4a43-9b2c-9f3d1e7a5b60",
    state: "new",
  },
  success: true,
  message: "Invoked workflow 'c0ffee1234567890'",
};

const RUN_TOOL = {
  data: {
    outputs: [{ id: "d5e6f7a8b9c0d1e2", hid: 4, name: "BWA output", state: "queued" }],
    output_collections: [],
    jobs: [
      {
        id: "1a2b3c4d5e6f7a8b",
        state: "new",
        exit_code: null,
        create_time: "2026-09-16T15:30:00.000000",
        tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem2/bwa_mem2/2.2.1+galaxy1",
        tool_version: "2.2.1+galaxy1",
        history_id: "0a248a1f62a0cc04",
        model_class: "Job",
      },
    ],
    implicit_collections: [],
    produces_entry_points: false,
  },
  success: true,
  message: "Started tool 'bwa_mem2' in history '0a248a1f62a0cc04'",
};

/** A map-over submission: one entry per job, outputs empty, collections instead. */
const RUN_TOOL_MAPPED = {
  data: {
    outputs: [],
    output_collections: [],
    jobs: [
      { id: "job000000000001", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
      { id: "job000000000002", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
      { id: "job000000000003", state: "new", tool_id: "fastp", tool_version: "0.23.4" },
    ],
    implicit_collections: [{ id: "hdca00000000001", output_name: "out1" }],
  },
  success: true,
  message: "Started tool 'fastp' in history '0a248a1f62a0cc04'",
};

const RUN_USER_TOOL = {
  data: {
    outputs: [{ id: "ds00000000000001", hid: 7, name: "cleaned", state: "queued" }],
    jobs: [
      {
        id: "udtjob0000000001",
        state: "new",
        tool_id: "clean_table",
        tool_version: "0.1.0",
        history_id: "0a248a1f62a0cc04",
      },
    ],
  },
  success: true,
  message: "Started user tool 'clean_table' (UUID: 8d5f1c2e-...) in history '0a248a1f62a0cc04'",
};

const UPLOAD_FROM_URL = {
  data: {
    outputs: [{ id: "upds000000000001", hid: 1, name: "chrM.fa", state: "queued" }],
    jobs: [{ id: "upjob00000000001", state: "new", tool_id: "upload1" }],
  },
  success: true,
  message: "Uploaded file from URL 'https://example.org/chrM.fa'",
};

const CREATE_USER_TOOL = {
  data: {
    id: "f2ce1234abcd5678",
    uuid: "8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f",
    active: true,
    hidden: false,
    tool_id: "clean_table",
    tool_format: "GalaxyUserTool",
    create_time: "2026-09-16T15:30:00.000000",
    representation: {
      class: "GalaxyUserTool",
      id: "clean_table",
      version: "0.1.0",
      name: "Clean Table",
      container: "quay.io/biocontainers/pandas:1.5.2",
      shell_command: "python3 clean.py",
      inputs: [{ name: "input1", type: "data" }],
      outputs: [{ name: "output1", type: "data", format: "tabular", from_work_dir: "out.tsv" }],
    },
  },
  success: true,
  message: "Created user-defined tool 'Clean Table'",
};

function parse(tool: string, args: Record<string, unknown>, result: unknown) {
  return parseSubmission(tool, args, resolveResultPayload(result));
}

describe("submission tool registry", () => {
  it("covers every submission surface the harness knows about", () => {
    expect(Object.keys(SUBMISSION_TOOLS).sort()).toEqual([
      "galaxy_create_user_tool",
      "galaxy_invoke_workflow",
      "galaxy_run_tool",
      "galaxy_run_user_tool",
      "galaxy_upload_file",
      "galaxy_upload_file_from_url",
      "galaxy_upload_local_file",
    ]);
  });

  it("ignores everything else", () => {
    expect(isSubmissionTool("galaxy_get_history_contents")).toBe(false);
    expect(isSubmissionTool("bash")).toBe(false);
    expect(isSubmissionTool(undefined)).toBe(false);
  });
});

describe("parse: invoke_workflow", () => {
  it("takes the invocation id from data.id", () => {
    const out = parse(
      "galaxy_invoke_workflow",
      { workflow_id: "c0ffee1234567890" },
      mcpResult(INVOKE_WORKFLOW),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.kind).toBe("invocation");
    expect(out.submission.invocationId).toBe("ff1e2d3c4b5a6978");
    expect(out.submission.historyId).toBe("0a248a1f62a0cc04");
    expect(out.submission.label).toContain("c0ffee1234567890");
  });

  it("reads no job ids -- the POST answers with the collection view", () => {
    const out = parse("galaxy_invoke_workflow", {}, mcpResult(INVOKE_WORKFLOW));
    expect(out.ok && out.submission.jobs).toBeUndefined();
  });

  it("refuses a data object that is not an invocation", () => {
    // The exact confusion this guards: a job id where an invocation id belongs
    // sends the polling tools to /api/invocations/<job id>.
    const out = parse(
      "galaxy_invoke_workflow",
      {},
      mcpResult({ data: { id: "1a2b3c4d5e6f7a8b", model_class: "Job" }, success: true }),
    );
    expect(out.ok).toBe(false);
  });

  it("refuses a batch invocation list rather than picking one", () => {
    const out = parse("galaxy_invoke_workflow", {}, mcpResult({ data: [INVOKE_WORKFLOW.data] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("list");
  });

  it("refuses a missing id", () => {
    const out = parse(
      "galaxy_invoke_workflow",
      {},
      mcpResult({ data: { model_class: "WorkflowInvocation" }, success: true }),
    );
    expect(out.ok).toBe(false);
  });
});

describe("parse: run_tool", () => {
  it("takes job ids, tool id and tool version off data.jobs", () => {
    const out = parse("galaxy_run_tool", { history_id: "0a248a1f62a0cc04" }, mcpResult(RUN_TOOL));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs).toEqual([
      {
        jobId: "1a2b3c4d5e6f7a8b",
        toolId: "toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem2/bwa_mem2/2.2.1+galaxy1",
        toolVersion: "2.2.1+galaxy1",
        historyId: "0a248a1f62a0cc04",
      },
    ]);
  });

  it("produces one record per job for a mapped-over run", () => {
    const out = parse("galaxy_run_tool", { tool_id: "fastp" }, mcpResult(RUN_TOOL_MAPPED));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs?.map((j) => j.jobId)).toEqual([
      "job000000000001",
      "job000000000002",
      "job000000000003",
    ]);
  });

  it("flags a partial failure without dropping the jobs that started", () => {
    const out = parse(
      "galaxy_run_tool",
      {},
      mcpResult({
        data: { ...RUN_TOOL_MAPPED.data, errors: [{ message: "one job could not be created" }] },
        success: true,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.partial).toBe(true);
    expect(out.submission.jobs).toHaveLength(3);
  });

  it("refuses the whole submission when one job entry has no id", () => {
    // Half a record is worse than none: we would not know how many jobs ran.
    const out = parse(
      "galaxy_run_tool",
      {},
      mcpResult({ data: { jobs: [{ id: "job1" }, { state: "new" }] }, success: true }),
    );
    expect(out.ok).toBe(false);
  });

  it("refuses an empty jobs list", () => {
    const out = parse("galaxy_run_tool", {}, mcpResult({ data: { jobs: [] }, success: true }));
    expect(out.ok).toBe(false);
  });

  it("refuses a non-string job id", () => {
    const out = parse(
      "galaxy_run_tool",
      {},
      mcpResult({ data: { jobs: [{ id: 12345 }] }, success: true }),
    );
    expect(out.ok).toBe(false);
  });
});

describe("parse: run_user_tool", () => {
  it("has the run_tool shape and names the resolved tool id", () => {
    const out = parse(
      "galaxy_run_user_tool",
      { tool_uuid: "8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f" },
      mcpResult(RUN_USER_TOOL),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs?.[0].jobId).toBe("udtjob0000000001");
    expect(out.submission.jobs?.[0].toolVersion).toBe("0.1.0");
    expect(out.submission.label).toContain("clean_table");
  });
});

describe("parse: uploads", () => {
  it("registers a URL upload's job", () => {
    const out = parse(
      "galaxy_upload_file_from_url",
      { url: "https://example.org/chrM.fa", history_id: "0a248a1f62a0cc04" },
      mcpResult(UPLOAD_FROM_URL),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs?.[0].jobId).toBe("upjob00000000001");
    expect(out.submission.label).toContain("example.org");
  });

  it("registers galaxy-mcp's local upload the same way", () => {
    const out = parse(
      "galaxy_upload_file",
      { path: "/data/reads/sample.fastq.gz" },
      mcpResult(UPLOAD_FROM_URL),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.label).toBe("Upload sample.fastq.gz");
  });

  it("registers Loom's own uploader from its details, not from JSON text", () => {
    const out = parse(
      "galaxy_upload_local_file",
      { path: "/data/reads/sample.fastq.gz" },
      {
        content: [{ type: "text", text: JSON.stringify({ uploaded: true }) }],
        details: { historyId: "0a248a1f62a0cc04", datasetId: "ds1", jobs: ["upjob00000000002"] },
      },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.jobs).toEqual([{ jobId: "upjob00000000002", toolId: "__DATA_FETCH__" }]);
    expect(out.submission.historyId).toBe("0a248a1f62a0cc04");
    expect(out.submission.label).toBe("Upload sample.fastq.gz");
  });

  it("does not register a Loom upload that failed ingest", () => {
    const out = parse(
      "galaxy_upload_local_file",
      { path: "/data/x.txt" },
      { content: [], details: { error: true, historyId: "h1", jobs: ["j1"] } },
    );
    expect(out.ok).toBe(false);
  });

  it("does not invent a job id when the fetch response carried none", () => {
    const out = parse(
      "galaxy_upload_local_file",
      { path: "/data/x.txt" },
      { content: [], details: { historyId: "h1", jobs: [] } },
    );
    expect(out.ok).toBe(false);
  });
});

describe("parse: create_user_tool", () => {
  it("takes the uuid, the tool id and the definition Galaxy stored", () => {
    const out = parse(
      "galaxy_create_user_tool",
      { representation: { id: "clean_table" } },
      mcpResult(CREATE_USER_TOOL),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.submission.kind).toBe("udt");
    expect(out.submission.udt?.uuid).toBe("8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f");
    expect(out.submission.udt?.toolId).toBe("clean_table");
    // Galaxy's stored representation wins over the agent's input -- it is what
    // will actually run.
    expect((out.submission.udt?.representation as Record<string, unknown>).container).toBe(
      "quay.io/biocontainers/pandas:1.5.2",
    );
  });

  it("falls back to the definition's own id when tool_id came back null", () => {
    const out = parse(
      "galaxy_create_user_tool",
      {},
      mcpResult({
        data: { ...CREATE_USER_TOOL.data, tool_id: null },
        success: true,
      }),
    );
    expect(out.ok && out.submission.udt?.toolId).toBe("clean_table");
  });

  it("refuses when there is no uuid", () => {
    const out = parse(
      "galaxy_create_user_tool",
      {},
      mcpResult({ data: { tool_id: "clean_table" }, success: true }),
    );
    expect(out.ok).toBe(false);
  });
});

describe("parse: results that are not results", () => {
  const cases: [string, unknown][] = [
    ["prose instead of JSON", { content: [{ type: "text", text: "Started your tool!" }] }],
    ["truncated JSON", { content: [{ type: "text", text: '{"data": {"jobs": [{"id": "1a2b' }] }],
    ["no content at all", { content: [], details: {} }],
    ["an envelope with no data", { content: [{ type: "text", text: '{"success": true}' }] }],
    [
      "an explicit failure envelope",
      { content: [{ type: "text", text: '{"success": false, "data": {"jobs":[{"id":"j1"}]}}' }] },
    ],
    ["a bare string result", "Started tool 'bwa' in history 'abc'"],
    ["null", null],
  ];

  for (const [name, result] of cases) {
    it(`refuses ${name}`, () => {
      expect(parse("galaxy_run_tool", {}, result).ok).toBe(false);
    });
  }

  it("never falls back to a 16-hex regex over the text", () => {
    // The text is full of plausible-looking ids. A parser that regexed would
    // happily register one of them; this one must not.
    const result = {
      content: [
        {
          type: "text",
          text:
            "Error calling tool 'run_tool': Run tool failed. " +
            "Context: history_id=0a248a1f62a0cc04, tool_id=bwa_mem, dataset=d5e6f7a8b9c0d1e2",
        },
      ],
    };
    expect(parse("galaxy_run_tool", {}, result).ok).toBe(false);
  });
});

describe("resolveResultPayload", () => {
  it("reads the direct-tools text block", () => {
    expect(resolveResultPayload(mcpResult(RUN_TOOL)).text).toContain('"jobs"');
  });

  it("prefers the proxy path's structuredContent when it is there", () => {
    const resolved = resolveResultPayload({
      content: [{ type: "text", text: "truncated preview…" }],
      details: { mcpResult: { structuredContent: RUN_TOOL, content: [] } },
    });
    expect(resolved.value).toEqual(RUN_TOOL);
  });

  it("ignores an omitted-summary mcpResult and falls back to the content block", () => {
    const resolved = resolveResultPayload({
      content: [{ type: "text", text: JSON.stringify(RUN_TOOL) }],
      details: { mcpResult: { omitted: true, reason: "too big", contentBlocks: 1 } },
    });
    expect(resolved.value).toBeUndefined();
    expect(resolved.text).toContain('"jobs"');
  });

  it("surfaces the adapter's spill path when the output guard truncated", () => {
    const resolved = resolveResultPayload({
      content: [{ type: "text", text: "preview…\n\n[truncated]" }],
      details: {
        outputGuard: { truncated: true, fullOutputPath: "/tmp/mcp-output-abc/output.txt" },
      },
    });
    expect(resolved.truncatedPath).toBe("/tmp/mcp-output-abc/output.txt");
  });

  it("says so in the reason when even the spill file did not parse", () => {
    const out = parse(
      "galaxy_run_tool",
      {},
      {
        content: [{ type: "text", text: "preview…" }],
        details: { outputGuard: { truncated: true, fullOutputPath: "/tmp/nope/output.txt" } },
      },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("spill file");
  });
});

/**
 * Every case here is one an adversarial review turned up against the first
 * version of these parsers, and each one made the harness record something
 * Galaxy had not said. They are the regression fence for "never guess an id".
 */
describe("parse: refusing ids the notebook cannot hold", () => {
  it("rejects an id carrying a newline", () => {
    // The blocks are `key: value` lines and ids are written unescaped, so this
    // rendered a SECOND `job_id:` line and the parser -- last key wins -- read
    // back "other", an id Galaxy never returned.
    const out = parse(
      "galaxy_run_tool",
      {},
      mcpResult({
        data: { jobs: [{ id: "expected00000001\njob_id: other00000000002" }] },
        success: true,
      }),
    );
    expect(out.ok).toBe(false);
  });

  it("rejects an invocation id carrying a newline", () => {
    const out = parse(
      "galaxy_invoke_workflow",
      {},
      mcpResult({
        data: {
          id: "ff1e2d3c4b5a6978\ninvocation_id: 0000000000000000",
          model_class: "WorkflowInvocation",
        },
        success: true,
      }),
    );
    expect(out.ok).toBe(false);
  });

  it("rejects ids with tabs, control characters, or absurd length", () => {
    for (const id of ["a\tb", "a\u0000b", "a b", "x".repeat(600)]) {
      expect(parse("galaxy_run_tool", {}, mcpResult({ data: { jobs: [{ id }] } })).ok).toBe(false);
    }
  });

  it("rejects a job entry whose model_class says it is not a job", () => {
    // An invocation id in a job block sends the pollers to
    // /api/jobs/<invocation id>, which fails quietly forever.
    const out = parse(
      "galaxy_run_tool",
      {},
      mcpResult({
        data: { jobs: [{ id: "ff1e2d3c4b5a6978", model_class: "WorkflowInvocation" }] },
        success: true,
      }),
    );
    expect(out.ok).toBe(false);
  });

  it("still records a job entry that omits model_class", () => {
    const out = parse("galaxy_run_tool", {}, mcpResult({ data: { jobs: [{ id: "j1" }] } }));
    expect(out.ok).toBe(true);
  });

  it("accepts success only when it is absent or literally true", () => {
    for (const success of ['"false"', "0", "null", '"true"', "1"]) {
      const out = parse(
        "galaxy_run_tool",
        {},
        mcpResult(JSON.parse(`{"success": ${success}, "data": {"jobs": [{"id": "j1"}]}}`)),
      );
      expect(out.ok, `success: ${success}`).toBe(false);
    }
    expect(parse("galaxy_run_tool", {}, mcpResult({ data: { jobs: [{ id: "j1" }] } })).ok).toBe(
      true,
    );
    expect(
      parse("galaxy_run_tool", {}, mcpResult({ success: true, data: { jobs: [{ id: "j1" }] } })).ok,
    ).toBe(true);
  });

  it("records where Galaxy put the jobs, not where they were asked to go", () => {
    const out = parse(
      "galaxy_run_tool",
      { history_id: "requested0000001" },
      mcpResult({ data: { jobs: [{ id: "j1", history_id: "actual0000000001" }] } }),
    );
    expect(out.ok && out.submission.historyId).toBe("actual0000000001");
  });

  it("falls back to the requested history only when the jobs name none", () => {
    const out = parse(
      "galaxy_run_tool",
      { history_id: "requested0000001" },
      mcpResult({ data: { jobs: [{ id: "j1" }] } }),
    );
    expect(out.ok && out.submission.historyId).toBe("requested0000001");
  });

  it("will not preserve the agent's own definition as a created user tool", () => {
    // With no stored representation there is nothing server-side to keep, and
    // filing the agent's draft under a harness record would misattribute it.
    const out = parse(
      "galaxy_create_user_tool",
      { representation: { id: "guessed", shell_command: "whatever" } },
      mcpResult({ data: { uuid: "8d5f1c2e-9a0b-4c3d-8e7f-1a2b3c4d5e6f" }, success: true }),
    );
    expect(out.ok).toBe(false);
  });
});
