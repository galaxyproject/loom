/*
 * Native TUS upload core for Galaxy.
 * This will migrate to galaxy-ops when that lands -- temporary home here.
 *
 * Intentionally free of any loom/pi imports so it can move cleanly into
 * @galaxyproject/galaxy-ops later. Plain Node + tus-js-client only.
 */

import { createReadStream } from "fs";
// FileUrlStorage is exported by the Node build but missing from the type defs --
// import via namespace and cast to avoid the spurious TS2724 error.
import * as tusClient from "tus-js-client";
const { Upload, FileUrlStorage } = tusClient as typeof tusClient & {
  FileUrlStorage: new (path: string) => tusClient.UrlStorage;
};

// ---------------------------------------------------------------------------
// buildFetchPayload
// ---------------------------------------------------------------------------

export interface FetchPayloadOpts {
  historyId: string;
  sessionId: string;
  fileName: string;
  fileType?: string; // Galaxy ext; default "auto"
  dbkey?: string; // genome build; default "?"
}

/**
 * Body for POST /api/tools/fetch after a TUS upload completes. Mirrors bioblend's
 * _fetch_payload. auto_decompress is OFF so an uploaded .gz stays compressed.
 */
export function buildFetchPayload(o: FetchPayloadOpts): Record<string, unknown> {
  return {
    history_id: o.historyId,
    targets: [
      {
        destination: { type: "hdas" },
        elements: [
          {
            src: "files",
            ext: o.fileType ?? "auto",
            dbkey: o.dbkey ?? "?",
            to_posix_lines: true,
            space_to_tab: false,
            name: o.fileName,
          },
        ],
      },
    ],
    "files_0|file_data": { session_id: o.sessionId, name: o.fileName },
    auto_decompress: false,
  };
}

// ---------------------------------------------------------------------------
// tusUpload
// ---------------------------------------------------------------------------

export interface TusUploadOpts {
  baseUrl: string; // origin, no trailing slash, no /api (e.g. https://galaxy.test)
  apiKey: string;
  filePath: string; // already validated + realpath-resolved by the caller
  storagePath: string; // file-backed resume store, e.g. ~/.loom/upload-resume.json
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (bytesSent: number, bytesTotal: number) => void;
}

export interface TusUploadResult {
  sessionId: string;
}

// Streams require a finite chunk size -- 10 MiB is a safe default that keeps
// memory bounded while still being large enough to avoid excessive round-trips.
const DEFAULT_CHUNK = 10 * 1024 * 1024;

export function tusUpload(opts: TusUploadOpts): Promise<TusUploadResult> {
  return new Promise<TusUploadResult>((resolve, reject) => {
    // Stream and finish() are created unconditionally so cleanup is always
    // the same code path regardless of when abort is detected.
    const stream = createReadStream(opts.filePath);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      fn();
    };

    // Pre-flight abort: signal was already aborted before we even started.
    // Route through finish() so stream cleanup is invariant.
    if (opts.signal?.aborted) {
      finish(() => reject(abortError()));
      return;
    }

    const upload = new Upload(stream as unknown as File, {
      endpoint: `${opts.baseUrl}/api/upload/resumable_upload`,
      headers: { "x-api-key": opts.apiKey },
      chunkSize: opts.chunkSize ?? DEFAULT_CHUNK,
      retryDelays: [0, 1000, 3000, 5000],
      urlStorage: new FileUrlStorage(opts.storagePath),
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: opts.onProgress,
      onError: (err: Error | tusClient.DetailedError) => finish(() => reject(err)),
      onSuccess: () => {
        // Use the URL constructor to parse the upload URL so trailing slashes
        // and query strings don't yield the wrong segment.
        let sessionId: string | undefined;
        try {
          const parsed = new URL(upload.url ?? "");
          sessionId = parsed.pathname.split("/").filter(Boolean).pop();
        } catch {
          // malformed or empty url -- sessionId stays undefined
        }
        finish(() =>
          sessionId
            ? resolve({ sessionId })
            : reject(new Error("TUS upload completed but Galaxy returned no session id")),
        );
      },
    });

    function onAbort() {
      // No shouldTerminate: true -- leaving the partial TUS session on the server
      // so it can be resumed if the user retries the same file (tus-js-client
      // matches by fingerprint). Terminating here would force a full re-upload.
      // If abort fires during the findPreviousUploads() window (before start()),
      // abort() is a safe no-op; the settled guard below is what skips start().
      void upload.abort();
      finish(() => reject(abortError()));
    }

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // tus-js-client only STORES resume state on its own -- it does not resume on
    // start(). Look up a stored partial for this same file and continue it;
    // otherwise start fresh. If the stored session is gone server-side (404),
    // tus-js-client drops the stale entry and creates a new upload itself (we
    // always set `endpoint`), so a stale resume transparently restarts.
    upload
      .findPreviousUploads()
      .then((previous) => {
        if (settled) return; // aborted while the resume lookup was in flight
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(() => {
        // A failed resume lookup (e.g. an unreadable store) must not strand the
        // upload -- fall back to a fresh start.
        if (!settled) upload.start();
      });
  });
}

function abortError(): Error {
  return new DOMException("Upload aborted", "AbortError");
}

// ---------------------------------------------------------------------------
// waitForDataset
// ---------------------------------------------------------------------------

export interface DatasetState {
  id: string;
  state: string;
  hid?: number;
  name?: string;
}

// These are the Galaxy dataset states from which no further transitions occur.
// Polling stops (successfully or otherwise) once one of these is seen.
export const TERMINAL_DATASET_STATES = new Set([
  "ok",
  "error",
  "discarded",
  "failed_metadata",
  "deferred",
]);

export interface WaitOpts {
  get: (datasetId: string) => Promise<DatasetState>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number; // injectable for tests
}

export async function waitForDataset(datasetId: string, opts: WaitOpts): Promise<DatasetState> {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 600_000;
  const now = opts.now ?? (() => Date.now());
  const start = now();

  // Timeout bounds time-between-terminal-states, not absolute wall time including
  // individual get() calls. A hung get() is the caller's responsibility -- the
  // caller passes an abort-aware getter, so an aborted get() rejects and breaks
  // the loop.
  while (true) {
    const ds = await opts.get(datasetId);
    if (TERMINAL_DATASET_STATES.has(ds.state)) return ds;
    if (now() - start > timeout)
      throw new Error(
        `Upload ingest timed out after ${Math.round(timeout / 1000)}s (last state: ${ds.state})`,
      );
    await new Promise((r) => setTimeout(r, interval));
  }
}
