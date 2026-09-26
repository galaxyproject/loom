/*
 * Native TUS upload core for Galaxy.
 * This will migrate to galaxy-ops when that lands -- temporary home here.
 *
 * Intentionally free of any loom/pi imports so it can move cleanly into
 * @galaxyproject/galaxy-ops later. Plain Node + tus-js-client only.
 */

import { createReadStream } from "fs";
import { parse as parseLegacyUrl } from "url";
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

/**
 * Scheme + host + port, or null when the URL will not parse. Duplicated rather
 * than imported from `shared/` on purpose: this module's header keeps it free
 * of loom imports so it can move into @galaxyproject/galaxy-ops unchanged.
 */
function originOf(url: string | null | undefined): string | null {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * The origin tus-js-client will actually connect to. Its Node transport builds
 * request options with the legacy `url.parse`, which disagrees with WHATWG
 * `URL` on some hosts: `https://usegalaxy.org%2eau/x` is `usegalaxy.org.au`
 * to `URL` but `usegalaxy.org` to `url.parse`. Checking only the WHATWG origin
 * would pass that URL and then send the key to the other host.
 */
function transportOriginOf(url: string | null | undefined): string | null {
  try {
    const { protocol, hostname, port } = parseLegacyUrl(String(url));
    if (!protocol || !hostname) return null;
    const effectivePort = port && port !== DEFAULT_PORTS[protocol] ? `:${port}` : "";
    // url.parse drops the brackets from an IPv6 literal; the WHATWG origin keeps them.
    const host = hostname.includes(":") ? `[${hostname}]` : hostname.toLowerCase();
    return `${protocol}//${host}${effectivePort}`;
  } catch {
    return null;
  }
}

/** A stored resume entry. `uploadUrl` is real at runtime; the type defs omit it. */
type StoredUpload = tusClient.PreviousUpload & {
  uploadUrl?: string | null;
  urlStorageKey?: string;
};

/**
 * The resume store with anything off-origin filtered out, in both directions.
 *
 * tus writes the upload URL to the store right after it hands it to us, and
 * abort() does not cancel that write; FileUrlStorage.addUpload keys every entry
 * on a fresh random id, so it appends rather than overwrites and nothing ever
 * removes it. A refused foreign URL would therefore be persisted to
 * ~/.loom/upload-resume.json once per attempt, unbounded, and the first entry
 * back out would be the poisoned one -- killing resume for that file for good.
 *
 * Filtering on the way in keeps it out of the file; filtering on the way out
 * (and deleting what it finds) heals a file an earlier build already wrote.
 */
function originScopedUrlStorage(
  inner: tusClient.UrlStorage,
  belongsHere: (url: string | null | undefined) => boolean,
): tusClient.UrlStorage {
  const keep = async (found: tusClient.PreviousUpload[]): Promise<tusClient.PreviousUpload[]> => {
    const kept: tusClient.PreviousUpload[] = [];
    for (const entry of found as StoredUpload[]) {
      if (belongsHere(entry.uploadUrl)) {
        kept.push(entry);
      } else if (entry.urlStorageKey) {
        // Best effort: a store we cannot prune still yields the right result,
        // it just stays dirty.
        await inner.removeUpload(entry.urlStorageKey).catch(() => {});
      }
    }
    return kept;
  };
  return {
    findAllUploads: async () => keep(await inner.findAllUploads()),
    findUploadsByFingerprint: async (fingerprint: string) =>
      keep(await inner.findUploadsByFingerprint(fingerprint)),
    removeUpload: (urlStorageKey: string) => inner.removeUpload(urlStorageKey),
    // Returning "" instead of a key is what tells tus there is nothing to
    // remove later (_removeFromUrlStorage bails on a falsy key).
    addUpload: async (fingerprint: string, upload: tusClient.PreviousUpload) =>
      belongsHere((upload as StoredUpload).uploadUrl) ? inner.addUpload(fingerprint, upload) : "",
  };
}

export function tusUpload(opts: TusUploadOpts): Promise<TusUploadResult> {
  return new Promise<TusUploadResult>((resolve, reject) => {
    // TUS hands back the upload URL in a Location header, and every later PATCH
    // carries `x-api-key`. A Location pointing at another host would therefore
    // send the key there, which is the same exposure an HTTP redirect would
    // give us -- so the upload URL has to stay on the configured origin.
    const expectedOrigin = originOf(opts.baseUrl);
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
      urlStorage: originScopedUrlStorage(new FileUrlStorage(opts.storagePath), (url) =>
        sameOriginAsGalaxy(url),
      ),
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: opts.onProgress,
      onUploadUrlAvailable: () => {
        if (sameOriginAsGalaxy(upload.url)) return;
        // abort() without terminate: a DELETE would send the key to the very
        // origin we are refusing to talk to. tus checks the aborted flag before
        // the next PATCH, so nothing further goes out.
        void upload.abort();
        finish(() => reject(new Error(foreignUploadUrlMessage(upload.url))));
      },
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

    function sameOriginAsGalaxy(url: string | null | undefined): boolean {
      const actual = originOf(url);
      return (
        actual !== null && actual === expectedOrigin && transportOriginOf(url) === expectedOrigin
      );
    }

    function foreignUploadUrlMessage(url: string | null | undefined): string {
      // The origin only: an upload URL's path is a session token.
      const target = originOf(url) ?? "an address that could not be read";
      return (
        `Galaxy directed the upload to ${target}, which is a different origin than the ` +
        `configured ${expectedOrigin ?? opts.baseUrl}. The upload was refused and the API key ` +
        `was not sent to it. Check that GALAXY_URL points at the Galaxy server itself rather ` +
        `than a proxy or a sign-in page.`
      );
    }

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
        // Everything here is already on the configured origin: the store
        // wrapper drops (and deletes) anything else before we see it.
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

// Galaxy's terminal dataset states -- those from which no further transitions
// occur, so polling stops (successfully or otherwise) once one is seen. Mirrors
// Dataset.terminal_states in galaxy's lib/galaxy/model/__init__.py. "empty"
// (a successfully-uploaded but zero-byte dataset) belongs here too -- omitting
// it left an empty-file upload polling all the way to the ingest timeout.
export const TERMINAL_DATASET_STATES = new Set([
  "ok",
  "empty",
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
