import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { getGalaxyConfig, galaxyGet, galaxyPost } from "./galaxy-api";
import { getCurrentHistoryId } from "./state";
import { isSensitivePath } from "./exec-guard/sensitive-read";
import {
  tusUpload,
  buildFetchPayload,
  waitForDataset,
  type DatasetState,
} from "./galaxy-upload-tus";

interface FetchResponse {
  outputs?: Array<{ id: string; hid?: number; name?: string; state?: string }>;
  jobs?: Array<{ id: string; state?: string }>;
}

/** Shared resume-state file; tus-js-client keys entries by file fingerprint. */
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

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: true } };
}

// Galaxy's Dataset.valid_input_states is "every state EXCEPT these three" -- a
// dataset that lands in one of them cannot be selected as input to a downstream
// tool (galaxy: lib/galaxy/model/__init__.py valid_input_states, enforced in
// tools/parameters/dataset_matcher.py). So an upload ending here transferred the
// bytes but did NOT produce a dataset the agent can actually use; report it as a
// failure rather than a success. (ok/empty/deferred are usable -> success.)
const UNUSABLE_DATASET_STATES = new Set(["error", "discarded", "failed_metadata"]);

export function isUnusableDatasetState(state: string): boolean {
  return UNUSABLE_DATASET_STATES.has(state);
}

// State-specific guidance: failed_metadata is recoverable (set the datatype),
// while error/discarded mean the data did not survive ingest.
export function ingestFailureMessage(state: string, fileName: string): string {
  if (state === "failed_metadata") {
    return `"${fileName}" transferred, but Galaxy could not detect its metadata (state "failed_metadata"), so it isn't usable as a tool input yet. Set the dataset's datatype in Galaxy and it becomes usable -- no need to re-upload.`;
  }
  if (state === "discarded") {
    return `"${fileName}" transferred, but Galaxy discarded the dataset (state "discarded") without retaining the data. Re-upload to try again.`;
  }
  return `"${fileName}" transferred, but Galaxy's ingest failed (state "error"). Inspect the dataset's job for details before retrying.`;
}

export function registerGalaxyUploadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "galaxy_upload_local_file",
    label: "Upload local file to Galaxy",
    description:
      "Upload a LOCAL file from the user's machine to a Galaxy history using a resumable " +
      "(TUS) upload, then waits for Galaxy to finish ingesting the dataset before returning. " +
      "For a file already at a public URL, use galaxy_upload_file_from_url instead.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local file to upload" }),
      history_id: Type.Optional(
        Type.String({ description: "Target Galaxy history id. Defaults to the current history." }),
      ),
      file_name: Type.Optional(
        Type.String({
          description: "Name for the dataset in Galaxy (defaults to the file's basename)",
        }),
      ),
      file_type: Type.Optional(
        Type.String({
          description: "Galaxy datatype (e.g. 'fastqsanger.gz'). Defaults to auto-detect.",
        }),
      ),
      dbkey: Type.Optional(
        Type.String({
          description: "Genome build / dbkey (e.g. 'hg38'). Defaults to unspecified.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const cfg = getGalaxyConfig();
      if (!cfg) {
        return err(
          "Galaxy is not configured (GALAXY_URL / GALAXY_API_KEY). Connect with /connect first.",
        );
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

      // Resolve symlinks before the sensitive-path check: tusUpload follows
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

      // fileName comes from absPath (the link's own name), not realPath (the target) --
      // the dataset should be named after what the user pointed at, not where the symlink leads.
      const fileName = (params.file_name as string | undefined) ?? path.basename(absPath);

      let sessionId: string;
      try {
        ({ sessionId } = await tusUpload({
          baseUrl: cfg.url,
          apiKey: cfg.apiKey,
          filePath: realPath, // realpath: already symlink-checked above
          storagePath,
          signal,
        }));
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return err("Upload cancelled.");
        return err(`Upload failed during transfer: ${e instanceof Error ? e.message : String(e)}`);
      }

      let fetchResp: FetchResponse;
      try {
        fetchResp = await galaxyPost<FetchResponse>(
          "/tools/fetch",
          buildFetchPayload({
            historyId,
            sessionId,
            fileName,
            fileType: params.file_type as string | undefined,
            dbkey: params.dbkey as string | undefined,
          }),
          signal,
        );
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return err("Upload cancelled.");
        return err(`Galaxy rejected the upload: ${e instanceof Error ? e.message : String(e)}`);
      }

      const output = fetchResp.outputs?.[0];
      let dataset: DatasetState | null = output
        ? { id: output.id, state: output.state ?? "queued", hid: output.hid, name: output.name }
        : null;

      // Wait the ingest to terminal so we don't hand back a "queued" non-answer.
      if (dataset) {
        try {
          dataset = await waitForDataset(dataset.id, {
            get: (id) => galaxyGet<DatasetState>(`/datasets/${encodeURIComponent(id)}`, signal),
          });
        } catch {
          // Abort or ingest-timeout while polling: the file is already uploaded and the
          // dataset exists, so return it with its last-known state rather than claiming
          // cancellation or failure -- the non-terminal state tells the model to follow up.
        }
      } else {
        // No outputs in the fetch response: fall back to the name-matched read-back.
        try {
          const contents = await galaxyGet<HistoryContentItem[]>(
            `/histories/${encodeURIComponent(historyId)}/contents?keys=id,hid,name,state,history_content_type`,
            signal,
          );
          const ds = pickUploadedDataset(contents, fileName);
          if (ds) dataset = { id: ds.id, state: ds.state, hid: ds.hid, name: ds.name };
        } catch {
          /* best-effort */
        }
      }

      if (dataset) {
        if (isUnusableDatasetState(dataset.state)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    uploaded: false,
                    history_id: historyId,
                    dataset: {
                      id: dataset.id,
                      hid: dataset.hid,
                      name: dataset.name,
                      state: dataset.state,
                    },
                    error: ingestFailureMessage(dataset.state, fileName),
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { error: true, historyId, datasetId: dataset.id, state: dataset.state },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uploaded: true,
                  history_id: historyId,
                  dataset: {
                    id: dataset.id,
                    hid: dataset.hid,
                    name: dataset.name,
                    state: dataset.state,
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { historyId, datasetId: dataset.id, state: dataset.state },
        };
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
      if (d?.datasetId)
        return new Text(`⬆️ Uploaded to Galaxy (dataset ${d.datasetId}, ${d.state ?? "queued"})`);
      return new Text("⬆️ Uploaded to Galaxy");
    },
  });
}
