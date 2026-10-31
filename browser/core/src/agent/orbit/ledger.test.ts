// @vitest-environment node
/**
 * The Orbit worker's submission ledger over its file: what a worker wrote, a reloaded one reads
 * back, and a file it can't read starts it empty rather than stopping the boot. The OPFS file
 * itself needs a browser; the e2e tiers reach it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { openFileLedger, openLedger, opfsFile, type LedgerFile } from "./ledger";

const KEY = "/orbit/c1/notebook.md";
const dispatched = (callId: string) => ({
  callId,
  attemptId: `att-${callId}`,
  toolName: "run_tool",
  recordKey: KEY,
  stepAnchor: "step-1",
  server: "https://galaxy.test",
  dispatchedAt: "2026-10-21T00:00:00.000Z",
});

function memoryFile(initial?: string): LedgerFile & { text?: string } {
  const file: LedgerFile & { text?: string } = {
    text: initial,
    read: async () => file.text,
    write: async (text) => void (file.text = text),
  };
  return file;
}

describe("the Orbit worker's file ledger", () => {
  it("reads back what the last worker wrote", async () => {
    const file = memoryFile();
    const first = await openFileLedger(file);
    await first.dispatched(dispatched("c1"));
    await first.responded("c1", {
      kind: "jobs",
      label: "fastqc",
      historyId: "h1",
      jobs: [{ jobId: "j1" }],
    });
    const reloaded = await openFileLedger(file);
    expect(await reloaded.open(KEY)).toMatchObject([
      { callId: "c1", state: "responded", submission: { jobs: [{ jobId: "j1" }] } },
    ]);
  });

  it("starts empty on a file it can't read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ledger = await openFileLedger(memoryFile('{"entries": [tor'));
    expect(await ledger.open(KEY)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("falls back to memory, with the reason, when the file can't be opened", async () => {
    const opened = await openLedger({
      read: async () => {
        throw new Error("SecurityError: storage is blocked");
      },
      write: async () => {},
    });
    expect(opened.unkept).toMatch(/storage is blocked/);
    await opened.ledger.dispatched(dispatched("c1"));
    expect(await opened.ledger.open(KEY)).toHaveLength(1);
  });
});

describe("the OPFS file", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes over the old text first and cuts it to length after, so a torn write never parses", async () => {
    const calls: string[] = [];
    const access = {
      write: (data: Uint8Array, { at }: { at: number }) => {
        calls.push(`write ${data.length} at ${at}`);
        return data.length;
      },
      flush: () => void calls.push("flush"),
      truncate: (size: number) => void calls.push(`truncate ${size}`),
      close: () => void calls.push("close"),
    };
    const handle = {
      getFile: async () => new Blob([""]),
      createSyncAccessHandle: async () => access,
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({ getFileHandle: async () => handle }) },
    });
    await opfsFile("ledger.json").write("abc");
    expect(calls).toEqual(["write 3 at 0", "flush", "truncate 3", "flush", "close"]);
  });
});
