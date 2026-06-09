import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  buildGalaxyUploadArgs,
  detectUploadFailure,
  resolveStoragePath,
  pickUploadedDataset,
  type HistoryContentItem,
} from "../extensions/loom/galaxy-upload";

describe("buildGalaxyUploadArgs", () => {
  it("builds the base command with --silent and no creds on argv", () => {
    const args = buildGalaxyUploadArgs({
      historyId: "h1",
      path: "/data/reads.fastq",
      storagePath: "/home/u/.loom/upload-resume.json",
    });
    expect(args).toEqual([
      "galaxy-upload",
      "--history-id",
      "h1",
      "--storage",
      "/home/u/.loom/upload-resume.json",
      "--silent",
      "/data/reads.fastq",
    ]);
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
