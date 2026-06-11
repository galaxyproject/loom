import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fsMod from "fs";
import * as osMod from "os";
import * as pathMod from "path";
import {
  resolveStoragePath,
  pickUploadedDataset,
  type HistoryContentItem,
} from "../extensions/loom/galaxy-upload";

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
    {
      id: "c",
      hid: 9,
      name: "reads.fastq",
      state: "ok",
      history_content_type: "dataset_collection",
    },
  ];

  it("returns the newest dataset matching the file name", () => {
    expect(pickUploadedDataset(items, "reads.fastq")?.id).toBe("b");
  });

  it("ignores collections and returns null when nothing matches", () => {
    expect(pickUploadedDataset(items, "other.fastq")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

vi.mock("../extensions/loom/galaxy-upload-tus", async (orig) => {
  const real = (await orig()) as object;
  return { ...real, tusUpload: vi.fn(), waitForDataset: vi.fn() };
});
vi.mock("../extensions/loom/galaxy-api");
vi.mock("../extensions/loom/state");

import { tusUpload, waitForDataset } from "../extensions/loom/galaxy-upload-tus";
import { galaxyGet, galaxyPost, getGalaxyConfig } from "../extensions/loom/galaxy-api";
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
  expect(tool).toBeDefined();
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
  vi.mocked(tusUpload).mockResolvedValue({ sessionId: "S1" });
  vi.mocked(galaxyPost).mockResolvedValue({
    outputs: [{ id: "ds1", hid: 3, name: "reads.fastq", state: "queued" }],
    jobs: [{ id: "job1", state: "new" }],
  } as any);
  vi.mocked(waitForDataset).mockResolvedValue({
    id: "ds1",
    state: "ok",
    hid: 3,
    name: "reads.fastq",
  });
});

afterEach(() => {
  process.env.HOME = prevHome;
  vi.clearAllMocks();
});

describe("galaxy_upload_local_file handler", () => {
  it("happy path: tusUpload called once; galaxyPost to /tools/fetch with correct session_id; result has datasetId and state ok", async () => {
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(tusUpload).toHaveBeenCalledOnce();
    expect(galaxyPost).toHaveBeenCalledWith(
      "/tools/fetch",
      expect.objectContaining({
        "files_0|file_data": expect.objectContaining({ session_id: "S1" }),
      }),
      expect.anything(),
    );
    expect(res.details.error).toBeFalsy();
    expect(res.details.datasetId).toBe("ds1");
    expect(res.details.state).toBe("ok");
  });

  it("passes creds to tusUpload via opts (not argv)", async () => {
    await run(getTool(), { path: goodFile, history_id: "hist1" });
    const call = vi.mocked(tusUpload).mock.calls[0][0];
    expect(call.baseUrl).toBe("https://galaxy.test");
    expect(call.apiKey).toBe("k");
  });

  it("returns cancelled text when tusUpload rejects with AbortError", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    vi.mocked(tusUpload).mockRejectedValue(abortErr);
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(res.content[0].text).toMatch(/cancel/i);
  });

  it("returns error with reject reason when galaxyPost rejects", async () => {
    vi.mocked(galaxyPost).mockRejectedValue(new Error("Galaxy API 400: bad ext"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/400|reject/i);
  });

  it("read-back fallback: when outputs absent, falls back to galaxyGet history-contents", async () => {
    vi.mocked(galaxyPost).mockResolvedValue({ jobs: [{ id: "job1", state: "new" }] } as any);
    vi.mocked(galaxyGet).mockResolvedValue([
      { id: "ds2", hid: 7, name: "reads.fastq", state: "ok", history_content_type: "dataset" },
    ] as any);
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(galaxyGet).toHaveBeenCalled();
    expect(res.details.error).toBeFalsy();
    expect(res.details.datasetId).toBe("ds2");
  });

  it("waitForDataset path used when outputs present (not galaxyGet for history-contents)", async () => {
    // galaxyPost already returns outputs in the default mock
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(waitForDataset).toHaveBeenCalled();
    // galaxyGet should NOT be called for the history-contents fallback
    expect(galaxyGet).not.toHaveBeenCalledWith(
      expect.stringContaining("/histories/"),
      expect.anything(),
    );
    expect(res.details.datasetId).toBe("ds1");
  });

  it("errors when no history is available", async () => {
    vi.mocked(getCurrentHistoryId).mockReturnValue(null);
    const res = await run(getTool(), { path: goodFile });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/history/i);
    expect(tusUpload).not.toHaveBeenCalled();
  });

  it("errors when Galaxy is not configured", async () => {
    vi.mocked(getGalaxyConfig).mockReturnValue(null);
    const res = await run(getTool(), { path: goodFile, history_id: "h" });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/not configured/i);
    expect(tusUpload).not.toHaveBeenCalled();
  });

  it("errors when the file does not exist", async () => {
    const res = await run(getTool(), {
      path: pathMod.join(sandbox, "nope.fastq"),
      history_id: "h",
    });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(tusUpload).not.toHaveBeenCalled();
  });

  it("refuses to upload a sensitive/credential file", async () => {
    const secret = pathMod.join(sandbox, "id_rsa");
    fsMod.writeFileSync(secret, "PRIVATE");
    const res = await run(getTool(), { path: secret, history_id: "h" });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/sensitive|credential|refus/i);
    expect(tusUpload).not.toHaveBeenCalled();
  });

  it("refuses a benign-named symlink whose target is a sensitive file", async () => {
    const realSecret = pathMod.join(sandbox, "server.key");
    fsMod.writeFileSync(realSecret, "PRIVATE");
    const link = pathMod.join(sandbox, "innocent.fastq");
    fsMod.symlinkSync(realSecret, link);
    const res = await run(getTool(), { path: link, history_id: "h" });
    expect(res.details.error).toBe(true);
    expect(res.content[0].text).toMatch(/sensitive|credential|refus/i);
    expect(tusUpload).not.toHaveBeenCalled();
  });

  it("falls back gracefully when waitForDataset times out (returns last-known state)", async () => {
    vi.mocked(waitForDataset).mockRejectedValue(new Error("Upload ingest timed out after 600s"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    // should still return the initial dataset info from the fetch response
    expect(res.details.error).toBeFalsy();
    expect(res.details.datasetId).toBe("ds1");
  });

  it("falls back gracefully when both fetch outputs missing and history-contents get fails", async () => {
    vi.mocked(galaxyPost).mockResolvedValue({ jobs: [{ id: "job1", state: "new" }] } as any);
    vi.mocked(galaxyGet).mockRejectedValue(new Error("500"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(res.details.error).toBeFalsy();
    expect(res.details.uploaded).toBe(true);
    expect(res.content[0].text).toMatch(/get_history_contents/);
  });

  it("cancel during galaxyPost: returns cancel message", async () => {
    vi.mocked(galaxyPost).mockRejectedValue(new DOMException("aborted", "AbortError"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(res.content[0].text).toMatch(/cancel/i);
    expect(res.details.error).toBe(true);
  });

  it("cancel/timeout during waitForDataset: returns last-known dataset state, not an error", async () => {
    vi.mocked(waitForDataset).mockRejectedValue(new DOMException("aborted", "AbortError"));
    const res = await run(getTool(), { path: goodFile, history_id: "hist1" });
    expect(res.details.error).toBeFalsy();
    expect(res.details.datasetId).toBe("ds1");
    expect(res.details.state).toBe("queued");
  });
});
