import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Task 2: buildFetchPayload
// ---------------------------------------------------------------------------

import { buildFetchPayload, type FetchPayloadOpts } from "../extensions/loom/galaxy-upload-tus";

describe("buildFetchPayload", () => {
  it("returns the correct shape with defaults (ext=auto, dbkey=?, auto_decompress=false)", () => {
    const payload = buildFetchPayload({
      historyId: "hist1",
      sessionId: "SID-42",
      fileName: "reads.fastq",
    });

    expect(payload.history_id).toBe("hist1");
    expect(payload.auto_decompress).toBe(false);

    const target = (payload.targets as any[])[0];
    expect(target.destination.type).toBe("hdas");

    const elem = target.elements[0];
    expect(elem.src).toBe("files");
    expect(elem.ext).toBe("auto");
    expect(elem.dbkey).toBe("?");
    expect(elem.name).toBe("reads.fastq");
    expect(elem.to_posix_lines).toBe(true);
    expect(elem.space_to_tab).toBe(false);

    const fileData = payload["files_0|file_data"] as Record<string, unknown>;
    expect(fileData.session_id).toBe("SID-42");
    expect(fileData.name).toBe("reads.fastq");
  });

  it("threads through explicit fileType and dbkey", () => {
    const payload = buildFetchPayload({
      historyId: "hist2",
      sessionId: "SID-99",
      fileName: "genome.bam",
      fileType: "bam",
      dbkey: "hg38",
    });

    const elem = (payload.targets as any[])[0].elements[0];
    expect(elem.ext).toBe("bam");
    expect(elem.dbkey).toBe("hg38");
    expect(elem.name).toBe("genome.bam");

    const fileData = payload["files_0|file_data"] as Record<string, unknown>;
    expect(fileData.session_id).toBe("SID-99");
  });
});

// ---------------------------------------------------------------------------
// Task 3: tusUpload
// ---------------------------------------------------------------------------

import { tusUpload, type TusUploadOpts } from "../extensions/loom/galaxy-upload-tus";

// vi.hoisted runs before imports are processed, so the class is available
// when the vi.mock factory executes (which also runs before imports).
const { FakeUpload, FakeFileUrlStorage } = vi.hoisted(() => {
  class FakeUpload {
    static lastInstance: FakeUpload | undefined;

    static resumeCalls = 0;
    // When set, findPreviousUploads() returns this pending promise instead of
    // resolving synchronously -- lets a test fire abort *during* the lookup.
    static findPreviousDeferred: Promise<unknown[]> | null = null;
    url: string | undefined;
    resumedFrom: unknown | undefined;
    opts: Record<string, unknown>;
    abortCalled = false;
    abortTerminated = false;
    startCalled = false;

    constructor(_stream: unknown, opts: Record<string, unknown>) {
      this.opts = opts;
      FakeUpload.lastInstance = this;
    }

    start() {
      this.startCalled = true;
    }

    // Mirrors real tus: the previous-upload lookup goes through urlStorage,
    // which is where the origin filtering lives.
    findPreviousUploads(): Promise<unknown[]> {
      if (FakeUpload.findPreviousDeferred) return FakeUpload.findPreviousDeferred;
      const storage = this.opts.urlStorage as {
        findUploadsByFingerprint: (fingerprint: string) => Promise<unknown[]>;
      };
      return storage.findUploadsByFingerprint("fp");
    }

    getUrlStorage(): {
      findUploadsByFingerprint: (fingerprint: string) => Promise<unknown[]>;
      addUpload: (fingerprint: string, upload: unknown) => Promise<string>;
    } {
      return this.opts.urlStorage as never;
    }

    resumeFromPreviousUpload(prev: unknown) {
      FakeUpload.resumeCalls++;
      this.resumedFrom = prev;
    }

    abort(shouldTerminate?: boolean): Promise<void> {
      this.abortCalled = true;
      this.abortTerminated = shouldTerminate === true;
      return Promise.resolve();
    }

    triggerSuccess() {
      (this.opts.onSuccess as () => void)();
    }

    triggerError(err: Error) {
      (this.opts.onError as (e: Error) => void)(err);
    }

    triggerUploadUrlAvailable(url: string | undefined) {
      this.url = url;
      (this.opts.onUploadUrlAvailable as (() => void) | undefined)?.();
    }

    getEndpoint(): string {
      return this.opts.endpoint as string;
    }

    getHeaders(): Record<string, string> {
      return this.opts.headers as Record<string, string>;
    }

    getChunkSize(): number {
      return this.opts.chunkSize as number;
    }
  }

  /** An in-memory stand-in for FileUrlStorage, with the same append semantics. */
  class FakeFileUrlStorage {
    static entries: Record<string, Record<string, unknown>> = {};
    static nextKey = 0;

    static list(): Record<string, unknown>[] {
      return Object.entries(FakeFileUrlStorage.entries).map(([urlStorageKey, v]) => ({
        ...v,
        urlStorageKey,
      }));
    }

    findAllUploads(): Promise<Record<string, unknown>[]> {
      return Promise.resolve(FakeFileUrlStorage.list());
    }

    findUploadsByFingerprint(_fingerprint: string): Promise<Record<string, unknown>[]> {
      return Promise.resolve(FakeFileUrlStorage.list());
    }

    removeUpload(urlStorageKey: string): Promise<void> {
      delete FakeFileUrlStorage.entries[urlStorageKey];
      return Promise.resolve();
    }

    addUpload(_fingerprint: string, upload: Record<string, unknown>): Promise<string> {
      // Real FileUrlStorage keys on a random id, so this appends; it never
      // replaces an existing entry for the same file.
      const key = `tus::fp::${FakeFileUrlStorage.nextKey++}`;
      FakeFileUrlStorage.entries[key] = upload;
      return Promise.resolve(key);
    }
  }

  return { FakeUpload, FakeFileUrlStorage };
});

vi.mock("tus-js-client", () => ({
  Upload: FakeUpload,
  FileUrlStorage: FakeFileUrlStorage,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    createReadStream: vi.fn(() => ({ destroy: vi.fn() })),
  };
});

beforeEach(() => {
  FakeUpload.lastInstance = undefined;
  FakeUpload.resumeCalls = 0;
  FakeUpload.findPreviousDeferred = null;
  FakeFileUrlStorage.entries = {};
  FakeFileUrlStorage.nextKey = 0;
});

describe("tusUpload", () => {
  const baseOpts: TusUploadOpts = {
    baseUrl: "https://galaxy.test",
    apiKey: "my-key",
    filePath: "/data/reads.fastq",
    storagePath: "/tmp/upload-resume.json",
  };

  it("resolves sessionId parsed from upload.url and calls start()", async () => {
    const uploadPromise = tusUpload(baseOpts);

    // Give the event loop a tick so start() is called and the instance is registered
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    expect(inst).toBeDefined();
    expect(inst.startCalled).toBe(true);
    expect(inst.getEndpoint()).toBe("https://galaxy.test/api/upload/resumable_upload");
    expect(inst.getHeaders()["x-api-key"]).toBe("my-key");
    expect(typeof inst.getChunkSize()).toBe("number");
    expect(inst.getChunkSize()).toBeGreaterThan(0);

    // Set url before triggering success -- this is what session-id parsing reads
    inst.url = "https://galaxy.test/api/upload/resumable_upload/SID-42";
    inst.triggerSuccess();

    const result = await uploadPromise;
    expect(result.sessionId).toBe("SID-42");
  });

  it("rejects when onError fires", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    inst.triggerError(new Error("connection refused"));

    await expect(uploadPromise).rejects.toThrow("connection refused");
  });

  it("rejects with AbortError and calls upload.abort() when signal fires", async () => {
    const ac = new AbortController();
    const uploadPromise = tusUpload({ ...baseOpts, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    ac.abort();

    const err = await uploadPromise.catch((e: Error) => e);
    expect(err.name).toBe("AbortError");
    expect(inst.abortCalled).toBe(true);
  });

  it("rejects immediately if signal is already aborted before start", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(tusUpload({ ...baseOpts, signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects with 'no session id' when onSuccess fires with no url set", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    // url is undefined -- no path segment can be extracted
    inst.url = undefined;
    inst.triggerSuccess();

    await expect(uploadPromise).rejects.toThrow(/no session id/i);
  });

  it("settles exactly once: late onError after abort does not produce a second rejection", async () => {
    const ac = new AbortController();

    // Track every call to the underlying resolve/reject so we can assert only
    // one settlement occurs even when a second callback fires afterward.
    let settlementCount = 0;
    let firstOutcome: { kind: "resolve" | "reject"; value: unknown } | undefined;

    const uploadPromise = tusUpload({ ...baseOpts, signal: ac.signal });

    // Attach a .then handler that counts settlements -- do NOT re-throw so
    // there is no secondary unhandled rejection from this tracking layer.
    const trackedPromise = uploadPromise.then(
      (v) => {
        settlementCount++;
        firstOutcome ??= { kind: "resolve", value: v };
      },
      (e: unknown) => {
        settlementCount++;
        firstOutcome ??= { kind: "reject", value: e };
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    const inst = FakeUpload.lastInstance!;

    // Abort first -- this settles the underlying promise
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));

    // Fire onError after the promise has already settled -- the `settled`
    // guard must swallow this silently (no second resolution, no throw)
    inst.triggerError(new Error("late network error"));
    await new Promise((r) => setTimeout(r, 0));

    await trackedPromise;

    expect(settlementCount).toBe(1);
    expect(firstOutcome?.kind).toBe("reject");
    expect((firstOutcome?.value as Error).name).toBe("AbortError");
  });

  it("resumes from a stored previous upload when one exists for the file", async () => {
    FakeFileUrlStorage.entries["tus::fp::1"] = {
      uploadUrl: "https://galaxy.test/api/upload/resumable_upload/OLD",
    };

    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    // The stored partial must be handed to resumeFromPreviousUpload before start().
    expect(FakeUpload.resumeCalls).toBe(1);
    expect(inst.resumedFrom).toMatchObject({
      uploadUrl: "https://galaxy.test/api/upload/resumable_upload/OLD",
    });
    expect(inst.startCalled).toBe(true);

    inst.url = "https://galaxy.test/api/upload/resumable_upload/OLD";
    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "OLD" });
  });

  it("starts fresh (no resumeFromPreviousUpload) when there is no stored partial", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    // resumeFromPreviousUpload must NOT be called at all (not even with undefined).
    expect(FakeUpload.resumeCalls).toBe(0);
    expect(inst.startCalled).toBe(true);

    inst.url = "https://galaxy.test/api/upload/resumable_upload/NEW";
    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "NEW" });
  });

  it("refuses an upload URL on another origin and never sends the key there", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    inst.triggerUploadUrlAvailable("https://evil.test/api/upload/resumable_upload/SID-42");

    const err = await uploadPromise.catch((e: Error) => e);
    expect(err.message).toContain("https://evil.test");
    expect(err.message).toContain("GALAXY_URL");
    // Origin only -- the upload URL's last segment is a session token.
    expect(err.message).not.toContain("SID-42");
    expect(inst.abortCalled).toBe(true);
    // Terminating would send a DELETE (with the key) to the origin we refused.
    expect(inst.abortTerminated).toBe(false);
  });

  it("refuses an upload URL whose host tus would parse differently", async () => {
    // WHATWG URL decodes %2e and sees galaxy.test; tus's url.parse stops the host at
    // the '%' and would connect to evil.galaxy -- with the key.
    const uploadPromise = tusUpload({ ...baseOpts, baseUrl: "https://evil.galaxy.test" });
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    inst.triggerUploadUrlAvailable("https://evil.galaxy%2etest/api/upload/resumable_upload/SID");

    await expect(uploadPromise).rejects.toThrow(/different origin/);
    expect(inst.abortCalled).toBe(true);
    expect(inst.abortTerminated).toBe(false);
  });

  it("prunes a stored partial whose host tus would parse differently", async () => {
    FakeFileUrlStorage.entries["k"] = {
      uploadUrl: "https://evil.galaxy%2etest/api/upload/resumable_upload/OLD",
    };

    const uploadPromise = tusUpload({ ...baseOpts, baseUrl: "https://evil.galaxy.test" });
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    expect(FakeUpload.resumeCalls).toBe(0);
    expect(FakeFileUrlStorage.entries).toEqual({});

    inst.url = "https://evil.galaxy.test/api/upload/resumable_upload/NEW";
    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "NEW" });
  });

  it("accepts a same-origin upload URL spelled with the default port or upper case", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    inst.triggerUploadUrlAvailable("https://GALAXY.test:443/api/upload/resumable_upload/SID-8");
    expect(inst.abortCalled).toBe(false);

    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "SID-8" });
  });

  it("accepts an upload URL that stays on the configured origin", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    inst.triggerUploadUrlAvailable("https://galaxy.test/api/upload/resumable_upload/SID-7");
    expect(inst.abortCalled).toBe(false);

    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "SID-7" });
  });

  it("ignores a stored partial that points at another origin, and prunes it", async () => {
    FakeFileUrlStorage.entries["k"] = {
      uploadUrl: "https://evil.test/api/upload/resumable_upload/OLD",
    };

    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    expect(FakeUpload.resumeCalls).toBe(0);
    expect(inst.startCalled).toBe(true);
    // Left behind it would be read again on every later attempt, and it is the
    // first entry out, so resume for this file would be dead for good.
    expect(FakeFileUrlStorage.entries).toEqual({});

    inst.url = "https://galaxy.test/api/upload/resumable_upload/NEW";
    inst.triggerSuccess();
    await expect(uploadPromise).resolves.toEqual({ sessionId: "NEW" });
  });

  it("refuses to write an off-origin upload URL to the resume store", async () => {
    const uploadPromise = tusUpload(baseOpts);
    await new Promise((r) => setTimeout(r, 0));
    const storage = FakeUpload.lastInstance!.getUrlStorage();

    const key = await storage.addUpload("fp", {
      uploadUrl: "https://evil.test/api/upload/resumable_upload/SID",
    });
    // tus treats a falsy key as "nothing to remove later".
    expect(key).toBe("");
    expect(FakeFileUrlStorage.entries).toEqual({});

    await storage.addUpload("fp", {
      uploadUrl: "https://galaxy.test/api/upload/resumable_upload/SID",
    });
    expect(Object.values(FakeFileUrlStorage.entries)).toHaveLength(1);

    FakeUpload.lastInstance!.url = "https://galaxy.test/api/upload/resumable_upload/SID";
    FakeUpload.lastInstance!.triggerSuccess();
    await uploadPromise;
  });

  it("does not start() if the signal aborts during the resume lookup", async () => {
    let resolveLookup!: (v: unknown[]) => void;
    FakeUpload.findPreviousDeferred = new Promise<unknown[]>((res) => {
      resolveLookup = res;
    });

    const ac = new AbortController();
    const uploadPromise = tusUpload({ ...baseOpts, signal: ac.signal });
    // Attach the rejection handler up front so the abort below never has a
    // window where it looks like an unhandled rejection.
    const rejection = expect(uploadPromise).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 0));

    const inst = FakeUpload.lastInstance!;
    // Lookup is still pending -- start() must not have run yet.
    expect(inst.startCalled).toBe(false);

    // Abort while the lookup is in flight, THEN let the lookup resolve.
    ac.abort();
    resolveLookup([]);
    await new Promise((r) => setTimeout(r, 0));

    // The settled guard must keep start() from firing after the abort.
    expect(inst.startCalled).toBe(false);
    await rejection;
  });
});

// ---------------------------------------------------------------------------
// Task 4: waitForDataset + TERMINAL_DATASET_STATES
// ---------------------------------------------------------------------------

import {
  waitForDataset,
  TERMINAL_DATASET_STATES,
  type DatasetState,
} from "../extensions/loom/galaxy-upload-tus";

describe("TERMINAL_DATASET_STATES", () => {
  it("includes ok, error, discarded, failed_metadata, deferred", () => {
    expect(TERMINAL_DATASET_STATES.has("ok")).toBe(true);
    expect(TERMINAL_DATASET_STATES.has("error")).toBe(true);
    expect(TERMINAL_DATASET_STATES.has("discarded")).toBe(true);
    expect(TERMINAL_DATASET_STATES.has("failed_metadata")).toBe(true);
    expect(TERMINAL_DATASET_STATES.has("deferred")).toBe(true);
    expect(TERMINAL_DATASET_STATES.has("queued")).toBe(false);
    expect(TERMINAL_DATASET_STATES.has("running")).toBe(false);
  });
});

describe("waitForDataset", () => {
  it("polls until terminal state and returns the dataset (queued->running->ok)", async () => {
    const states = ["queued", "running", "ok"];
    let callCount = 0;
    const get = async (_id: string): Promise<DatasetState> => ({
      id: "ds1",
      state: states[callCount++]!,
      hid: 1,
      name: "reads.fastq",
    });

    const result = await waitForDataset("ds1", { get, intervalMs: 0, timeoutMs: 10_000 });
    expect(result.state).toBe("ok");
    expect(callCount).toBe(3);
  });

  it("returns without throwing on a terminal 'error' state", async () => {
    const get = async (_id: string): Promise<DatasetState> => ({
      id: "ds2",
      state: "error",
    });
    // Should resolve, not reject
    const result = await waitForDataset("ds2", { get, intervalMs: 0 });
    expect(result.state).toBe("error");
  });

  it("throws a timeout error when the dataset never reaches a terminal state", async () => {
    const get = async (_id: string): Promise<DatasetState> => ({
      id: "ds3",
      state: "queued",
    });

    // Inject now() to control time without real waiting
    let fakeNow = 0;
    const now = () => fakeNow;

    const promise = waitForDataset("ds3", {
      get,
      intervalMs: 0,
      timeoutMs: 1000,
      now,
    });

    // Let the first poll run, then jump time past the timeout
    await new Promise((r) => setTimeout(r, 5));
    fakeNow = 1001;

    await expect(promise).rejects.toThrow(/timed out/i);
  });
});
