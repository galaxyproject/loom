import * as os from "os";
import * as path from "path";

export interface GalaxyUploadArgsOpts {
  historyId: string;
  path: string;
  storagePath: string;
  fileName?: string;
  fileType?: string;
  dbkey?: string;
}

/** Build the `uvx` argv. Creds are passed via env, never here. */
export function buildGalaxyUploadArgs(o: GalaxyUploadArgsOpts): string[] {
  const args = [
    "galaxy-upload",
    "--history-id",
    o.historyId,
    "--storage",
    o.storagePath,
    "--silent",
  ];
  if (o.fileType) args.push("--file-type", o.fileType);
  if (o.dbkey) args.push("--dbkey", o.dbkey);
  if (o.fileName) args.push("--file-name", o.fileName);
  args.push(o.path);
  return args;
}

/**
 * galaxy-upload exits 0 even when a ConnectionError is hit during upload --
 * it just prints "ERROR: ..." to stderr. So a failure is a non-zero exit OR
 * an ERROR: line on stderr.
 */
export function detectUploadFailure(
  exitCode: number | null,
  stderr: string,
): { failed: boolean; message?: string } {
  if (exitCode !== 0) {
    const first = stderr.split("\n").find((l) => l.trim()) ?? `exited with code ${exitCode}`;
    return { failed: true, message: first.trim() };
  }
  const errLine = stderr.split("\n").find((l) => /ERROR:/.test(l));
  if (errLine) return { failed: true, message: errLine.replace(/^.*?ERROR:\s*/, "").trim() };
  return { failed: false };
}

/** Shared resume-state file; galaxy-upload keys entries by file fingerprint. */
export function resolveStoragePath(): string {
  return path.join(os.homedir(), ".loom", "upload-resume.json");
}

export interface HistoryContentItem {
  id: string;
  hid: number;
  name: string;
  state: string;
  history_content_type?: string;
}

/** Newest dataset (highest hid) whose name matches; collections excluded. */
export function pickUploadedDataset(
  contents: HistoryContentItem[],
  fileName: string,
): HistoryContentItem | null {
  const matches = contents.filter(
    (c) => (c.history_content_type ?? "dataset") === "dataset" && c.name === fileName,
  );
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.hid > a.hid ? b : a));
}
