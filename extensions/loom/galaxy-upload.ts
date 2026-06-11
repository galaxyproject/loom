import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { getGalaxyConfig, galaxyGet } from "./galaxy-api";
import { getCurrentHistoryId } from "./state";
import { isSensitivePath } from "./exec-guard/sensitive-read";
import { runGalaxyUpload } from "./galaxy-upload-runner";

export interface GalaxyUploadArgsOpts {
  historyId: string;
  path: string;
  storagePath: string;
  fileName?: string;
  fileType?: string;
  dbkey?: string;
}

/**
 * uvx package spec for the upload CLI. Pinned to a floor (like galaxy-mcp in
 * bin/loom.js) because detectUploadFailure couples to this CLI's stderr format
 * and exit-code semantics -- an unpinned `uvx galaxy-upload` could drift under us.
 */
export const GALAXY_UPLOAD_PACKAGE = "galaxy-upload>=1.0.1";

/** Build the `uvx` argv. Creds are passed via env, never here. */
export function buildGalaxyUploadArgs(o: GalaxyUploadArgsOpts): string[] {
  const args = [
    GALAXY_UPLOAD_PACKAGE,
    "--history-id",
    o.historyId,
    "--storage",
    o.storagePath,
    // Galaxy auto-decompresses .gz/.zip on ingest by default; keep the bytes
    // as-is so an uploaded fastqsanger.gz stays compressed.
    "--no-auto-decompress",
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

const UVX_MISSING =
  "`uvx` was not found on your PATH. Galaxy uploads run through `uvx galaxy-upload`. " +
  "Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`). " +
  "See https://docs.astral.sh/uv/";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: true } };
}

export function registerGalaxyUploadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "galaxy_upload_local_file",
    label: "Upload local file to Galaxy",
    description:
      "Upload a LOCAL file from the user's machine to a Galaxy history using a resumable " +
      "(TUS) transfer. Use this for local files of ANY size -- it runs as a background " +
      "transfer and will not time out. For a file already at a public URL, use " +
      "galaxy_upload_file_from_url instead. After upload the dataset is ingested " +
      "asynchronously (queued -> running -> ok); check it with get_history_contents.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local file to upload" }),
      history_id: Type.Optional(
        Type.String({ description: "Target Galaxy history id. Defaults to the current history." }),
      ),
      file_name: Type.Optional(
        Type.String({ description: "Name for the dataset in Galaxy (defaults to the file's basename)" }),
      ),
      file_type: Type.Optional(
        Type.String({ description: "Galaxy datatype (e.g. 'fastqsanger.gz'). Defaults to auto-detect." }),
      ),
      dbkey: Type.Optional(
        Type.String({ description: "Genome build / dbkey (e.g. 'hg38'). Defaults to unspecified." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const cfg = getGalaxyConfig();
      if (!cfg) {
        return err("Galaxy is not configured (GALAXY_URL / GALAXY_API_KEY). Connect with /connect first.");
      }

      const historyId = (params.history_id as string | undefined) ?? getCurrentHistoryId();
      if (!historyId) {
        return err(
          "No history_id given and no current Galaxy history is set. Create or select a history, then pass history_id.",
        );
      }

      const absPath = path.resolve(params.path as string);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        return err(`File not found: ${params.path}`);
      }
      if (!stat.isFile()) return err(`Not a regular file: ${params.path}`);

      // Resolve symlinks before the sensitive-path check: galaxy-upload follows
      // the link, so a benign-named symlink to ~/.ssh/id_rsa would otherwise
      // exfiltrate the target. Check both the literal path and its real target.
      let realPath: string;
      try {
        realPath = fs.realpathSync(absPath);
      } catch {
        return err(`Cannot resolve path: ${params.path}`);
      }
      const home = os.homedir();
      if (isSensitivePath(absPath, home) || isSensitivePath(realPath, home)) {
        return err(
          `Refusing to upload "${params.path}": it (or its target) matches loom's sensitive/credential path policy.`,
        );
      }

      const storagePath = resolveStoragePath();
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });

      const args = buildGalaxyUploadArgs({
        historyId,
        path: absPath,
        storagePath,
        fileName: params.file_name as string | undefined,
        fileType: params.file_type as string | undefined,
        dbkey: params.dbkey as string | undefined,
      });
      const env = { ...process.env, GALAXY_URL: cfg.url, GALAXY_API_KEY: cfg.apiKey };

      let result;
      try {
        result = await runGalaxyUpload({ args, env, signal });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return err(UVX_MISSING);
        return err(`Upload failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (result.aborted) return err("Upload cancelled.");

      const failure = detectUploadFailure(result.exitCode, result.stderr);
      if (failure.failed) return err(`Upload failed: ${failure.message}`);

      const fileName = (params.file_name as string | undefined) ?? path.basename(absPath);
      try {
        const contents = await galaxyGet<HistoryContentItem[]>(
          `/histories/${encodeURIComponent(historyId)}/contents?keys=id,hid,name,state,history_content_type`,
          signal,
        );
        const ds = pickUploadedDataset(contents, fileName);
        if (ds) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    uploaded: true,
                    history_id: historyId,
                    dataset: { id: ds.id, hid: ds.hid, name: ds.name, state: ds.state },
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { historyId, datasetId: ds.id, state: ds.state },
          };
        }
      } catch {
        // read-back is best-effort; fall through to the graceful message
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Uploaded "${fileName}" to history ${historyId} (resumable transfer complete). ` +
              `The dataset is being ingested; call get_history_contents("${historyId}") for its id and state.`,
          },
        ],
        details: { historyId, uploaded: true },
      };
    },
    renderResult: (result) => {
      const d = result.details as
        | { error?: boolean; datasetId?: string; state?: string }
        | undefined;
      if (d?.error) return new Text("❌ Galaxy upload failed");
      if (d?.datasetId) return new Text(`⬆️ Uploaded to Galaxy (dataset ${d.datasetId}, ${d.state ?? "queued"})`);
      return new Text("⬆️ Uploaded to Galaxy");
    },
  });
}
