import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  stageForTool,
  splitToolId,
  extractToolIds,
  extractDatatypes,
  resolveObservationServer,
  currentGalaxyUrl,
  recordGalaxyVersionFromConnect,
  getGalaxyVersion,
  resetGalaxyVersion,
  buildObservation,
  isAdmissibleMcpTool,
} from "../extensions/loom/observations.js";
import { factsForToolResult } from "../extensions/loom/observation-triggers.js";
import { validateObservation, scanObservationForLeaks } from "../shared/observation-contract.js";
import type { ObservationEnvelope } from "../extensions/loom/observations.js";

const envelope: ObservationEnvelope = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  clientTs: "2026-09-30T12:00:00.000Z",
  app: "loom-cli",
  version: "0.8.0",
  platform: "darwin",
  installToken: "a".repeat(32),
  server: "usegalaxy.org",
};

describe("stageForTool", () => {
  const table: Array<[string | undefined, string]> = [
    ["galaxy_upload_local_file", "data-acquisition"],
    ["galaxy_upload_file_from_url", "data-acquisition"],
    ["galaxy_download_dataset", "data-acquisition"],
    ["galaxy_import_history", "data-acquisition"],
    ["galaxy_set_dataset_metadata", "metadata-reconciliation"],
    ["galaxy_update_datatype", "metadata-reconciliation"],
    ["galaxy_run_tool", "tool-parameterization"],
    ["galaxy_run_user_tool", "tool-parameterization"],
    ["galaxy_invoke_workflow", "tool-parameterization"],
    ["galaxy_create_user_tool", "tool-parameterization"],
    ["galaxy_get_tool_input_template", "tool-parameterization"],
    ["galaxy_search_tools_by_name", "tool-parameterization"],
    ["galaxy_invocation_check_all", "job-execution"],
    ["galaxy_get_job_details", "job-execution"],
    ["galaxy_cancel_job", "job-execution"],
    ["galaxy_get_dataset_content", "result-interpretation"],
    ["galaxy_get_history", "result-interpretation"],
    ["galaxy_list_histories", "result-interpretation"],
    ["galaxy_connect", "unknown"],
    ["bash", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [tool, stage] of table) {
    it(`${tool ?? "(none)"} -> ${stage}`, () => expect(stageForTool(tool)).toBe(stage));
  }
});

describe("splitToolId", () => {
  it("splits the version off a toolshed id", () => {
    expect(splitToolId("toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1+galaxy1")).toEqual({
      id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2",
      version: "2.2.1+galaxy1",
    });
  });

  it("leaves a bare tool id alone", () => {
    expect(splitToolId("Filter1")).toEqual({ id: "Filter1" });
    expect(splitToolId("upload1")).toEqual({ id: "upload1" });
  });

  it("leaves a toolshed id with no version segment alone", () => {
    expect(splitToolId("toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2")).toEqual({
      id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2",
    });
  });

  it("is total over junk", () => {
    expect(splitToolId("   ")).toEqual({ id: "" });
  });
});

describe("extractToolIds", () => {
  it("reads tool_id and tool_ids", () => {
    expect(extractToolIds({ tool_id: "Filter1" })).toEqual(["Filter1"]);
    expect(extractToolIds({ tool_ids: ["Filter1", "Grep1"] })).toEqual(["Filter1", "Grep1"]);
  });

  it("accepts the real id shapes", () => {
    for (const id of [
      "Filter1",
      "upload1",
      "__FILTER_FROM_FILE__",
      "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1+galaxy1",
    ]) {
      expect(extractToolIds({ tool_id: id }), id).toEqual([id]);
    }
  });

  it("drops anything that is neither a Galaxy built-in nor a public toolshed id", () => {
    expect(extractToolIds({ tool_id: "../../etc/passwd" })).toEqual([]);
    expect(extractToolIds({ tool_id: "/etc/passwd" })).toEqual([]);
    expect(extractToolIds({ tool_id: "C:/Users/bob/tool.xml" })).toEqual([]);
    expect(extractToolIds({ tool_id: "tool id with spaces" })).toEqual([]);
    expect(extractToolIds({ tool_id: "x".repeat(201) })).toEqual([]);
  });

  it("caps the count and dedupes", () => {
    const ids = ["Filter1", "Filter1", "Grep1", "cat1", "Cut1", "sort1", "upload1", "comp1"];
    expect(extractToolIds({ tool_ids: ids })).toEqual([
      "Filter1",
      "Grep1",
      "cat1",
      "Cut1",
      "sort1",
    ]);
  });

  it("is total over junk input", () => {
    expect(extractToolIds(undefined)).toEqual([]);
    expect(extractToolIds({})).toEqual([]);
    expect(extractToolIds({ tool_id: 7 } as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe("structured fields are admitted from allowlists, not shapes", () => {
  const base = {
    kind: "tool-error" as const,
    trigger: "tool_error" as const,
    toolIds: [],
    datatypes: [],
    rawSignature: "x",
  };

  it("sends none of the reviewer's identifying words as structure", () => {
    const facts = factsForToolResult(
      "mcp",
      {
        server: "galaxy",
        tool: "alice_smith",
        args: { tool_id: "Alice_Smith", file_type: "patient_17.fastq" },
      },
      "Unknown tool",
    )!;
    const obs = buildObservation(facts, envelope, "structured");
    expect("mcpTool" in obs).toBe(false);
    expect(obs.tools).toEqual([]);
    expect(obs.datatypes).toEqual([]);
    expect(JSON.stringify(obs)).not.toMatch(/alice|smith|patient/i);
  });

  it("keeps a private hostname out of the toolshed version slot", () => {
    const id = "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/biobank.internal";
    expect(extractToolIds({ tool_id: id })).toEqual([
      "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2",
    ]);
    const obs = buildObservation({ ...base, toolIds: [id] }, envelope, "structured");
    expect(obs.tools).toEqual([{ id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2" }]);
  });

  it("refuses a datatype- or version-shaped name", () => {
    expect(extractDatatypes({ file_type: "patient07_smith" })).toEqual([]);
    expect(
      extractToolIds({ tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/x/y/patient07_smith" }),
    ).toEqual(["toolshed.g2.bx.psu.edu/repos/iuc/x/y"]);
  });

  it("drops a four-part version that reads as an IPv4 address, keeping the id", () => {
    expect(
      extractToolIds({ tool_id: "toolshed.g2.bx.psu.edu/repos/devteam/bwa/bwa/0.7.17.4" }),
    ).toEqual(["toolshed.g2.bx.psu.edu/repos/devteam/bwa/bwa"]);
  });

  it("admits real galaxy-mcp names, Galaxy datatypes and Galaxy's own bare tool ids", () => {
    expect(isAdmissibleMcpTool("galaxy_run_tool")).toBe(true);
    expect(isAdmissibleMcpTool("galaxy_get_job_details")).toBe(true);
    expect(isAdmissibleMcpTool("galaxy_alice_smith")).toBe(false);
    expect(extractDatatypes({ file_type: "BAM" })).toEqual(["bam"]);
    expect(extractDatatypes({ file_type: "fastqsanger.bz2" })).toEqual(["fastqsanger.bz2"]);
    expect(extractToolIds({ tool_id: "__MERGE_COLLECTION__" })).toEqual(["__MERGE_COLLECTION__"]);
  });

  it("scans every string, so a toolshed segment that names a host is still refused", () => {
    const obs = buildObservation(
      { ...base, toolIds: ["toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1+galaxy1"] },
      envelope,
      "structured",
    );
    expect(scanObservationForLeaks(obs)).toEqual([]);
    const forged = {
      ...obs,
      tools: [{ id: "toolshed.g2.bx.psu.edu/repos/biobank.internal/x/y" }],
    };
    expect(scanObservationForLeaks(forged)).toContain("tools[0].id:hostname");
  });
});

describe("extractDatatypes", () => {
  it("reads the datatype-shaped argument keys", () => {
    expect(extractDatatypes({ file_type: "fastqsanger.gz" })).toEqual(["fastqsanger.gz"]);
    expect(extractDatatypes({ ext: "bed" })).toEqual(["bed"]);
    expect(extractDatatypes({ extension: "vcf_bgzip" })).toEqual(["vcf_bgzip"]);
    expect(extractDatatypes({ datatype: "tabular" })).toEqual(["tabular"]);
  });

  it("drops auto and anything not on Galaxy's datatype list", () => {
    expect(extractDatatypes({ file_type: "auto" })).toEqual([]);
    expect(extractDatatypes({ file_type: "C:/Users/bob" })).toEqual([]);
    expect(extractDatatypes({ ext: "x".repeat(41) })).toEqual([]);
  });

  it("dedupes and caps", () => {
    expect(extractDatatypes({ file_type: "bed", ext: "bed", extension: "vcf" })).toEqual([
      "bed",
      "vcf",
    ]);
  });
});

describe("resolveObservationServer", () => {
  it("maps an allowlisted host to its name", () => {
    expect(resolveObservationServer("https://usegalaxy.org/")).toBe("usegalaxy.org");
    expect(resolveObservationServer("https://USEGALAXY.EU")).toBe("usegalaxy.eu");
    expect(resolveObservationServer("test.galaxyproject.org")).toBe("test.galaxyproject.org");
  });

  it("maps everything else to private, including subdomains and loopback", () => {
    expect(resolveObservationServer("https://galaxy.institute.edu")).toBe("private");
    expect(resolveObservationServer("https://test.usegalaxy.org")).toBe("private");
    expect(resolveObservationServer("http://localhost:8080")).toBe("private");
    expect(resolveObservationServer("https://usegalaxy.org.evil.example")).toBe("private");
    expect(resolveObservationServer("not a url at all")).toBe("private");
    expect(resolveObservationServer(undefined)).toBe("private");
  });
});

describe("currentGalaxyUrl", () => {
  // The profile fallback reads ~/.loom/config.json, so every case here runs
  // against an empty temp HOME rather than whatever the developer has.
  let emptyHome: string;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  beforeEach(() => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-nohome-"));
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  });

  it("prefers the live env URL", () => {
    expect(currentGalaxyUrl({ GALAXY_URL: "https://usegalaxy.eu" } as NodeJS.ProcessEnv)).toBe(
      "https://usegalaxy.eu",
    );
  });

  it("falls back to the active profile, so an encrypted-key session is not mislabelled", async () => {
    // loadProfiles reads ~/.loom/config.json via getConfigDir, so point HOME at
    // a fixture for this one case.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-profile-"));
    fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "config.json"),
      JSON.stringify({
        galaxy: {
          active: "usegalaxy-org",
          profiles: { "usegalaxy-org": { url: "https://usegalaxy.org", apiKeyEncrypted: "xx" } },
        },
      }),
      "utf-8",
    );
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    try {
      vi.resetModules();
      const m = await import("../extensions/loom/observations.js");
      expect(m.currentGalaxyUrl({} as NodeJS.ProcessEnv)).toBe("https://usegalaxy.org");
      expect(m.resolveObservationServer(m.currentGalaxyUrl({} as NodeJS.ProcessEnv))).toBe(
        "usegalaxy.org",
      );
    } finally {
      process.env.HOME = emptyHome;
      process.env.USERPROFILE = emptyHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("is undefined with neither", () => {
    expect(currentGalaxyUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("recordGalaxyVersionFromConnect", () => {
  beforeEach(() => resetGalaxyVersion());

  it("captures a version-shaped value", () => {
    recordGalaxyVersionFromConnect('{"success": true, "version": "24.2.1"}');
    expect(getGalaxyVersion()).toBe("24.2.1");
  });

  it("ignores anything that is not version-shaped", () => {
    recordGalaxyVersionFromConnect('{"version": "/Users/alice"}');
    expect(getGalaxyVersion()).toBeUndefined();
    recordGalaxyVersionFromConnect('{"version": "dev"}');
    expect(getGalaxyVersion()).toBeUndefined();
    recordGalaxyVersionFromConnect(undefined);
    expect(getGalaxyVersion()).toBeUndefined();
  });

  it("caps a hostile long value", () => {
    recordGalaxyVersionFromConnect(`{"version": "24.2.1${"9".repeat(200)}"}`);
    expect((getGalaxyVersion() ?? "").length).toBeLessThanOrEqual(40);
  });
});

describe("buildObservation", () => {
  it("builds a valid, leak-free observation from hostile facts", () => {
    const obs = buildObservation(
      {
        kind: "tool-error",
        trigger: "tool_error",
        mcpTool: "galaxy_run_tool",
        toolIds: ["toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1+galaxy1"],
        datatypes: ["fastqsanger.gz"],
        rawSignature:
          "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 in history 1203847 " +
          "failed; wrote /Users/alice/analyses/patient-07/run.log; " +
          "see https://usegalaxy.org/datasets/2a56fb8e4c1d9f70b3ac55e1d2f80911; " +
          "mail alice.researcher@institute.edu",
      },
      envelope,
      "full",
    );
    expect(obs.signature).toBe(
      "ToolExecutionError: dataset <id> in history <n> failed; wrote <path> see <url> mail <email>",
    );
    expect(obs.stage).toBe("tool-parameterization");
    expect(obs.tools).toEqual([
      { id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2", version: "2.2.1+galaxy1" },
    ]);
    expect(obs.description).toBe("");
    expect(validateObservation(obs)).toEqual({ ok: true });
    expect(scanObservationForLeaks(obs)).toEqual([]);
    const serialized = JSON.stringify(obs);
    for (const secret of [
      "alice",
      "patient-07",
      "institute.edu",
      "2a56fb8e4c1d9f70b3ac55e1d2f80911",
      "1203847",
      "usegalaxy.org/datasets",
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it("honours an explicit stage over the tool table", () => {
    const obs = buildObservation(
      {
        kind: "assertion-failed",
        trigger: "assertion",
        stage: "result-interpretation",
        mcpTool: "galaxy_run_tool",
        toolIds: [],
        datatypes: [],
        rawSignature: "evidence gate blocked a plan-step completion",
      },
      envelope,
      "full",
    );
    expect(obs.stage).toBe("result-interpretation");
  });

  it("carries the galaxy version and the wsl flag when present", () => {
    const obs = buildObservation(
      { kind: "other", trigger: "explicit", toolIds: [], datatypes: [], rawSignature: "x" },
      { ...envelope, galaxyVersion: "24.2.1", wsl: true, app: "orbit", platform: "linux" },
      "full",
    );
    expect(obs.galaxy).toEqual({ server: "usegalaxy.org", version: "24.2.1" });
    expect(obs.client).toEqual({ app: "orbit", version: "0.8.0", platform: "linux", wsl: true });
    expect(validateObservation(obs)).toEqual({ ok: true });
  });

  it("drops a description that cannot pass the validator rather than sending it", () => {
    const obs = buildObservation(
      {
        kind: "other",
        trigger: "explicit",
        toolIds: [],
        datatypes: [],
        rawSignature: "x",
        description: "the run for alice@institute.edu failed",
      },
      envelope,
      "full",
    );
    expect(obs.description).toBe("");
    expect(validateObservation(obs)).toEqual({ ok: true });
  });
});

import { UNKNOWN_SIGNATURE, normalizeSignature } from "../shared/observation-contract.js";
import {
  buildCheckedObservation,
  observationProblems,
  withheldReason,
} from "../extensions/loom/observations.js";
import { acceptDescription } from "../extensions/loom/observation-ui.js";

describe("buildObservation in the structured (auto) shape", () => {
  const hostile = {
    kind: "tool-error" as const,
    trigger: "tool_error" as const,
    mcpTool: "galaxy_run_tool",
    toolIds: ["toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2/2.2.1+galaxy1"],
    datatypes: ["fastqsanger.gz"],
    rawSignature: "ValueError: could not convert string to float: 'Alice Smith'",
    description: "Alice Smith had BRCA1 expression 3.14",
  };

  it("carries no free text at all, and keeps every structured field", () => {
    const obs = buildObservation(hostile, envelope, "structured");
    expect(obs.signature).toBe(UNKNOWN_SIGNATURE);
    expect(obs.description).toBe("");
    expect(obs.mcpTool).toBe("galaxy_run_tool");
    expect(obs.stage).toBe("tool-parameterization");
    expect(obs.tools).toEqual([
      { id: "toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2", version: "2.2.1+galaxy1" },
    ]);
    expect(obs.datatypes).toEqual(["fastqsanger.gz"]);
    expect(validateObservation(obs)).toEqual({ ok: true });
    expect(JSON.stringify(obs)).not.toMatch(/Alice|Smith|BRCA1|3\.14/);
  });

  it("sends the reviewer's name-and-value messages as nothing but structure", () => {
    for (const raw of [
      "ValueError: could not convert string to float: 'Alice Smith'",
      "KeyError: 'patient_07_jane'",
      "History 'Smith cohort RNA-seq' is not accessible",
      "Error in sample Alice_Smith: column padj not found",
    ]) {
      const obs = buildObservation({ ...hostile, rawSignature: raw }, envelope, "structured");
      expect(obs.signature, raw).toBe(UNKNOWN_SIGNATURE);
      expect(JSON.stringify(obs), raw).not.toMatch(/Alice|Smith|jane/);
    }
  });
});

describe("buildObservation signature fallback", () => {
  const facts = {
    kind: "other" as const,
    trigger: "explicit" as const,
    toolIds: [],
    datatypes: [],
  };

  it("carries the normalizer's unknown literal through", () => {
    for (const raw of ["", "   ", "\n\n"]) {
      const obs = buildObservation({ ...facts, rawSignature: raw }, envelope, "full");
      expect(obs.signature, JSON.stringify(raw)).toBe(UNKNOWN_SIGNATURE);
      expect(validateObservation(obs)).toEqual({ ok: true });
    }
  });

  it("keeps a placeholder-only signature as the placeholder", () => {
    const obs = buildObservation(
      { ...facts, rawSignature: "/Users/alice/run.log" },
      envelope,
      "full",
    );
    expect(obs.signature).toBe("<path>");
    expect(validateObservation(obs)).toEqual({ ok: true });
  });
});

describe("shape checks on model-authored fields", () => {
  const base = {
    kind: "tool-error" as const,
    trigger: "tool_error" as const,
    toolIds: [],
    datatypes: [],
    rawSignature: "x",
  };

  it("drops a tool id that is a relative path, a private toolshed or an IP", () => {
    for (const id of [
      "home/alice/secret_project/run.sh",
      "toolshed.corp-internal.example/repos/alice/x/y/1.0",
      "10.0.0.5/repos/iuc/x/y",
      "galaxy.corp-internal.example",
      "10.0.0.5",
      "3f2b8c1a-1234-4abc-8def-a123b56c89ab",
    ]) {
      expect(extractToolIds({ tool_id: id }), id).toEqual([]);
      expect(buildObservation({ ...base, toolIds: [id] }, envelope, "full").tools, id).toEqual([]);
    }
    expect(
      extractToolIds({ tool_id: "testtoolshed.g2.bx.psu.edu/repos/iuc/x/y/1.0" }),
    ).toHaveLength(1);
  });

  it("drops an mcp tool name that isn't galaxy-mcp's shape", () => {
    for (const name of [
      "galaxy_Users/alice/secret_project",
      "galaxy.corp-internal.example",
      "galaxy_alice smith thesis",
    ]) {
      const obs = buildObservation({ ...base, mcpTool: name }, envelope, "full");
      expect("mcpTool" in obs, name).toBe(false);
      expect(obs.stage).toBe("unknown");
    }
  });

  it("drops a hyphenated or upper-case file stem posing as a datatype", () => {
    expect(extractDatatypes({ file_type: "jsmith-cohort.brca" })).toEqual([]);
    expect(extractDatatypes({ file_type: "corp.example.org" })).toEqual([]);
    expect(extractDatatypes({ file_type: "example.com" })).toEqual([]);
    expect(extractDatatypes({ file_type: "fastqsanger.gz" })).toEqual(["fastqsanger.gz"]);
    expect(
      buildObservation({ ...base, datatypes: ["Patient07.csv"] }, envelope, "full").datatypes,
    ).toEqual([]);
  });

  it("keeps a free-form site suffix out of the galaxy version", () => {
    resetGalaxyVersion();
    recordGalaxyVersionFromConnect('{"version": "24.1.2+cancer.ctr"}');
    expect(getGalaxyVersion()).toBeUndefined();
    recordGalaxyVersionFromConnect('{"version": "26.1.rc1"}');
    expect(getGalaxyVersion()).toBe("26.1.rc1");
    resetGalaxyVersion();
  });

  it("drops a description that only the client-side table catches", () => {
    const obs = buildObservation(
      { ...base, description: "failed against postgres-prod.lab.example.edu" },
      envelope,
      "full",
    );
    expect(obs.description).toBe("");
  });
});

describe("the leak scan runs before normalization and truncation", () => {
  const base = {
    kind: "tool-error" as const,
    trigger: "tool_error" as const,
    mcpTool: "galaxy_run_tool",
    toolIds: [],
    datatypes: [],
  };

  function problemsFor(rawSignature: string): string[] {
    const obs = buildObservation({ ...base, rawSignature }, envelope, "full");
    return observationProblems(obs, { rawSignature }).leaks;
  }

  it("refuses a host whose port the normalizer would have turned into <n>", () => {
    const raw = "Connection to galaxyprod:12345 refused";
    expect(normalizeSignature(raw)).toBe("Connection to galaxyprod:<n> refused");
    expect(problemsFor(raw)).toContain("signature.staged:host-port");
  });

  it("refuses a hostname the signature cap would have cut mid-label", () => {
    const a = "x".repeat(179) + " galaxy.hospital.internal";
    expect(normalizeSignature(a).endsWith("galaxy.hospital.inte")).toBe(true);
    expect(problemsFor(a)).toContain("signature.staged:hostname");

    const b = "x".repeat(176) + " galaxy.cancer-center.org failed";
    expect(normalizeSignature(b).endsWith("galaxy.cancer-center.or")).toBe(true);
    expect(problemsFor(b)).toContain("signature.staged:hostname");
  });

  it("refuses a UUID the long-number rule would have half-rewritten", () => {
    const raw = "lost 12345678-abcd-4abc-8abc-abcdefabcdef";
    expect(normalizeSignature(raw)).toBe("lost <n>-abcd-4abc-8abc-abcdefabcdef");
    expect(problemsFor(raw)).toContain("signature.staged:uuid");
  });

  it("drops a description whose hostname the description cap would have cut", () => {
    const description = "x".repeat(479) + " galaxy.hospital.internal";
    const obs = buildObservation(
      { ...base, rawSignature: "ToolExecutionError: header-only table", description },
      envelope,
      "full",
    );
    expect(obs.description).toBe("");
    expect(acceptDescription(description)).toBe("");
  });

  it("withholds each of those signatures in ask and keeps the rest of the report", () => {
    for (const rawSignature of [
      "Connection to galaxyprod:12345 refused",
      "x".repeat(179) + " galaxy.hospital.internal",
      "x".repeat(176) + " galaxy.cancer-center.org failed",
      "lost 12345678-abcd-4abc-8abc-abcdefabcdef",
    ]) {
      const checked = buildCheckedObservation(
        { ...base, rawSignature, description: "A connection was refused." },
        envelope,
        "full",
      );
      expect(checked.obs.signature, rawSignature).toBe(UNKNOWN_SIGNATURE);
      expect(checked.obs.description).toBe("A connection was refused.");
      expect(checked.obs.mcpTool).toBe("galaxy_run_tool");
      expect(checked.withheld.length, rawSignature).toBeGreaterThan(0);
      expect(checked.errors).toEqual([]);
      expect(checked.leaks).toEqual([]);
    }
  });

  it("normalizes common real Galaxy errors and keeps them", () => {
    for (const [rawSignature, expected] of [
      ["Dataset 1a2b3c4d5e6f7a8b9c0d not found", "Dataset <id> not found"],
      ["History 0123456789abcdef0123 is deleted", "History <id> is deleted"],
      [
        "Failed to fetch https://usegalaxy.org/api/datasets/1a2b3c4d5e6f7a8b",
        "Failed to fetch <url>",
      ],
      [
        "No such file: /galaxy/server/database/objects/0/0/1/dataset_001.dat",
        "No such file: <path>",
      ],
      ["Job 12345 failed", "Job <n> failed"],
    ]) {
      const checked = buildCheckedObservation({ ...base, rawSignature }, envelope, "full");
      expect(checked.obs.signature, rawSignature).toBe(expected);
      expect(checked.withheld, rawSignature).toEqual([]);
      expect(checked.errors).toEqual([]);
      expect(checked.leaks).toEqual([]);
    }
  });

  it("says why in one line, by kind of shape and never by value", () => {
    expect(withheldReason(["host-port"])).toBe("error text withheld: it contained a host name");
    expect(withheldReason(["uuid", "path-separator", "long-hex"])).toBe(
      "error text withheld: it contained an id and a path",
    );
  });

  it("does not scan raw text the structured shape never carries", () => {
    const rawSignature = "Connection to galaxyprod:12345 refused";
    const obs = buildObservation({ ...base, rawSignature }, envelope, "structured");
    expect(observationProblems(obs).leaks).toEqual([]);
    expect(JSON.stringify(obs)).not.toContain("galaxyprod");
  });
});

describe("the generated allowlists", () => {
  it("hold nothing the leak scan would refuse, so an admitted field can always be sent", async () => {
    const { GALAXY_MCP_TOOLS, GALAXY_DATATYPES, GALAXY_BUILTIN_TOOL_IDS } =
      await import("../extensions/loom/observation-allowlists.js");
    const { textLeaks } = await import("../shared/observation-contract.js");
    for (const set of [GALAXY_MCP_TOOLS, GALAXY_DATATYPES, GALAXY_BUILTIN_TOOL_IDS]) {
      expect(set.size).toBeGreaterThan(40);
      for (const v of set) expect(textLeaks(v), v).toEqual([]);
    }
  });
});
