import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  buildGalaxyUploadArgs,
  detectUploadFailure,
  resolveStoragePath,
  pickUploadedDataset,
  GALAXY_UPLOAD_PACKAGE,
  type HistoryContentItem,
} from "../extensions/loom/galaxy-upload";

describe("buildGalaxyUploadArgs", () => {
  it("builds the base command with a pinned package, --no-auto-decompress, --silent, and no creds on argv", () => {
    const args = buildGalaxyUploadArgs({
      historyId: "h1",
      path: "/data/reads.fastq",
      storagePath: "/home/u/.loom/upload-resume.json",
    });
    expect(args).toEqual([
      GALAXY_UPLOAD_PACKAGE,
      "--history-id",
      "h1",
      "--storage",
      "/home/u/.loom/upload-resume.json",
      "--no-auto-decompress",
      "--silent",
      "/data/reads.fastq",
    ]);
    expect(GALAXY_UPLOAD_PACKAGE).toMatch(/^galaxy-upload>=/);
    expect(args).not.toContain("--url");
    expect(args).not.toContain("--api-key");
  });

  it("includes optional flags only when provided, with path last", () => {
    const args = buildGalaxyUploadArgs({
      historyId: "h1",
      path: "/data/reads.fastq",
      storagePath: "/s.json",
      fileType: "fastqsanger.gz",
      dbkey: "hg38",
      fileName: "sample1.fastq",
    });
    expect(args).toContain("--file-type");
    expect(args[args.indexOf("--file-type") + 1]).toBe("fastqsanger.gz");
    expect(args[args.indexOf("--dbkey") + 1]).toBe("hg38");
    expect(args[args.indexOf("--file-name") + 1]).toBe("sample1.fastq");
    expect(args[args.length - 1]).toBe("/data/reads.fastq");
  });
});

describe("detectUploadFailure", () => {
  it("passes on clean exit 0", () => {
    expect(detectUploadFailure(0, "")).toEqual({ failed: false });
  });

  it("fails on non-zero exit, reporting the first stderr line", () => {
    const r = detectUploadFailure(1, "Traceback...\nboom\n");
    expect(r.failed).toBe(true);
    expect(r.message).toBe("Traceback...");
  });

  it("fails on exit 0 when stderr carries an ERROR: line (galaxy-upload swallows the exit code)", () => {
    const r = detectUploadFailure(0, "ERROR: Unable to connect to Galaxy: 503\n");
    expect(r.failed).toBe(true);
    expect(r.message).toBe("Unable to connect to Galaxy: 503");
  });
});

describe("resolveStoragePath", () => {
  it("is under ~/.loom and stable", () => {
    const p = resolveStoragePath();
    expect(p).toBe(path.join(os.homedir(), ".loom", "upload-resume.json"));
  });
});

describe("pickUploadedDataset", () => {
  const items: HistoryContentItem[] = [
    { id: "a", hid: 1, name: "reads.fastq", state: "ok", history_content_type: "dataset" },
    { id: "b", hid: 5, name: "reads.fastq", state: "queued", history_content_type: "dataset" },
    { id: "c", hid: 9, name: "reads.fastq", state: "ok", history_content_type: "dataset_collection" },
  ];

  it("returns the newest dataset matching the file name", () => {
    expect(pickUploadedDataset(items, "reads.fastq")?.id).toBe("b");
  });

  it("ignores collections and returns null when nothing matches", () => {
    expect(pickUploadedDataset(items, "other.fastq")).toBeNull();
  });
});

import { describe as describeH, it as itH, expect as expectH, vi, beforeEach, afterEach } from "vitest";
import * as fsMod from "fs";
import * as osMod from "os";
import * as pathMod from "path";

vi.mock("../extensions/loom/galaxy-upload-runner");
vi.mock("../extensions/loom/galaxy-api");
vi.mock("../extensions/loom/state");

import { runGalaxyUpload } from "../extensions/loom/galaxy-upload-runner";
import { galaxyGet, getGalaxyConfig } from "../extensions/loom/galaxy-api";
import { getCurrentHistoryId } from "../extensions/loom/state";
import { registerGalaxyUploadTool } from "../extensions/loom/galaxy-upload";

interface ToolDef {
  name: string;
  label?: string;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details?: any }>;
}

function makeFakeApi() {
  const tools: ToolDef[] = [];
  return { api: { registerTool: (d: ToolDef) => tools.push(d) } as any, tools };
}

function getTool() {
  const { api, tools } = makeFakeApi();
  registerGalaxyUploadTool(api);
  const tool = tools.find((t) => t.name === "galaxy_upload_local_file")!;
  expectH(tool).toBeDefined();
  return tool;
}

async function run(tool: ToolDef, params: Record<string, unknown>) {
  return tool.execute("c1", params, new AbortController().signal, vi.fn(), {});
}

let sandbox: string, prevHome: string | undefined;
let goodFile: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  sandbox = fsMod.realpathSync(fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "loom-upload-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  goodFile = pathMod.join(sandbox, "reads.fastq");
  fsMod.writeFileSync(goodFile, "@read\nACGT\n+\nIIII\n");

  vi.mocked(getGalaxyConfig).mockReturnValue({ url: "https://galaxy.test", apiKey: "k" });
  vi.mocked(getCurrentHistoryId).mockReturnValue("hist1");
  vi.mocked(runGalaxyUpload).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    aborted: false,
  });
  vi.mocked(galaxyGet).mockResolvedValue([
    { id: "ds1", hid: 3, name: "reads.fastq", state: "queued", history_content_type: "dataset" },
  ] as any);
});

afterEach(() => {
  process.env.HOME = prevHome;
  vi.clearAllMocks();
});

describeH("galaxy_upload_local_file handler", () => {
  itH("uploads and returns the read-back dataset id", async () => {
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expectH(res.details.error).toBeFalsy();
    expectH(res.details.datasetId).toBe("ds1");
    expectH(res.content[0].text).toContain("ds1");
  });

  itH("passes creds via env, never on argv", async () => {
    await run(getTool(), { path: goodFile, history_id: "hist1" });
    const call = vi.mocked(runGalaxyUpload).mock.calls[0][0];
    expectH(call.env.GALAXY_URL).toBe("https://galaxy.test");
    expectH(call.env.GALAXY_API_KEY).toBe("k");
    expectH(call.args).not.toContain("--api-key");
    expectH(call.args).not.toContain("--url");
    expectH(call.args).toContain("--silent");
  });

  itH("defaults history_id to the current history", async () => {
    await run(getTool(), { path: goodFile });
    const call = vi.mocked(runGalaxyUpload).mock.calls[0][0];
    expectH(call.args[call.args.indexOf("--history-id") + 1]).toBe("hist1");
  });

  itH("errors when no history is available", async () => {
    vi.mocked(getCurrentHistoryId).mockReturnValue(null);
    const res = await run(getTool(), { path: goodFile });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/history/i);
    expectH(runGalaxyUpload).not.toHaveBeenCalled();
  });

  itH("errors when Galaxy is not configured", async () => {
    vi.mocked(getGalaxyConfig).mockReturnValue(null);
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/not configured/i);
  });

  itH("errors when the file does not exist", async () => {
    const res = await run(getTool(), { path: pathMod.join(sandbox, "nope.fastq"), history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/not found/i);
  });

  itH("refuses to upload a sensitive/credential file", async () => {
    const secret = pathMod.join(sandbox, "id_rsa");
    fsMod.writeFileSync(secret, "PRIVATE");
    const res = await run(getTool(), { path: secret, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/sensitive|credential|refus/i);
    expectH(runGalaxyUpload).not.toHaveBeenCalled();
  });

  itH("reports failure on a non-zero exit", async () => {
    vi.mocked(runGalaxyUpload).mockResolvedValue({
      exitCode: 1, stdout: "", stderr: "boom\n", aborted: false,
    });
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/boom/);
  });

  itH("reports failure on exit 0 with an ERROR: line", async () => {
    vi.mocked(runGalaxyUpload).mockResolvedValue({
      exitCode: 0, stdout: "", stderr: "ERROR: Unable to connect\n", aborted: false,
    });
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/Unable to connect/);
  });

  itH("returns cancelled when aborted", async () => {
    vi.mocked(runGalaxyUpload).mockResolvedValue({
      exitCode: null, stdout: "", stderr: "", aborted: true,
    });
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expectH(res.content[0].text).toMatch(/cancel/i);
  });

  itH("gives an actionable message when uvx is missing (ENOENT)", async () => {
    vi.mocked(runGalaxyUpload).mockRejectedValue(
      Object.assign(new Error("spawn uvx ENOENT"), { code: "ENOENT" }),
    );
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/uvx|uv\b/i);
  });

  itH("falls back gracefully when the dataset read-back fails", async () => {
    vi.mocked(galaxyGet).mockRejectedValue(new Error("500"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expectH(res.details.error).toBeFalsy();
    expectH(res.details.uploaded).toBe(true);
    expectH(res.content[0].text).toMatch(/get_history_contents/);
  });

  itH("refuses a benign-named symlink whose target is a sensitive file", async () => {
    const realSecret = pathMod.join(sandbox, "server.key");
    fsMod.writeFileSync(realSecret, "PRIVATE");
    const link = pathMod.join(sandbox, "innocent.fastq");
    fsMod.symlinkSync(realSecret, link);
    const res = await run(getTool(), { path: link, history_id: "h" });
    expectH(res.details.error).toBe(true);
    expectH(res.content[0].text).toMatch(/sensitive|credential|refus/i);
    expectH(runGalaxyUpload).not.toHaveBeenCalled();
  });
});
