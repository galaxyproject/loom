/**
 * The Orbit brain's submission ledger, kept in the browser's private files (OPFS) beside the
 * conversation store, not in it: pi-durable refuses a run's commits once its abort mark is on,
 * and the ledger has to take a Galaxy call's answer exactly then, when a switch or a Stop is
 * cutting the run short. A reloaded worker reads it back, and its first watch tick captures
 * what was answered but never written into the record.
 */
import {
  createMemoryLedger,
  type LedgerState,
  type SubmissionLedger,
} from "../../../../../extensions/orbit/submission-ledger";

/** Where a ledger's state is kept: one text file. */
export interface LedgerFile {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

const EMPTY: LedgerState = { entries: [], events: {}, histories: {} };

function parsed(text: string | undefined): LedgerState {
  if (!text) return EMPTY;
  try {
    const state = JSON.parse(text) as Partial<LedgerState>;
    return {
      entries: Array.isArray(state.entries) ? state.entries : [],
      events: state.events && typeof state.events === "object" ? state.events : {},
      histories: state.histories && typeof state.histories === "object" ? state.histories : {},
    };
  } catch (error) {
    // A torn write leaves nothing to recover from; the next attach's reconcile still finds the
    // runs Galaxy has, so starting empty loses the attribution, not the work.
    console.warn("[orbit] the submission ledger could not be read; starting it empty", error);
    return EMPTY;
  }
}

/** The ledger kept in `file`: read once, and written down before each change returns. */
export async function openFileLedger(file: LedgerFile): Promise<SubmissionLedger> {
  return createMemoryLedger({
    state: parsed(await file.read()),
    persist: (state) => file.write(JSON.stringify(state)),
  });
}

/**
 * The file ledger, or an in-memory one with the reason when the file can't be opened (a private
 * window, site data blocked): the worker starts either way, as it does without its storage.
 */
export async function openLedger(
  file: LedgerFile,
): Promise<{ ledger: SubmissionLedger; unkept?: string }> {
  try {
    return { ledger: await openFileLedger(file) };
  } catch (error) {
    return {
      ledger: createMemoryLedger(),
      unkept: `its Galaxy submissions can't be kept across a reload (${String((error as Error)?.message ?? error)})`,
    };
  }
}

/** A file in the origin's private file system. */
export function opfsFile(name: string): LedgerFile {
  const handle = navigator.storage
    .getDirectory()
    .then((root) => root.getFileHandle(name, { create: true }));
  return {
    async read() {
      const text = await (await (await handle).getFile()).text();
      return text || undefined;
    },
    async write(text) {
      const file = await handle;
      const bytes = new TextEncoder().encode(text);
      // A worker's synchronous handle is what every browser with OPFS has; createWritable came
      // later to some.
      const sync = (
        file as FileSystemFileHandle & {
          createSyncAccessHandle?: () => Promise<{
            truncate(size: number): void;
            write(data: Uint8Array, options: { at: number }): number;
            flush(): void;
            close(): void;
          }>;
        }
      ).createSyncAccessHandle;
      if (sync) {
        const access = await sync.call(file);
        // Written over the old text first and cut to length after, so a worker killed partway
        // leaves something that doesn't parse (and starts empty with a warning), never a file
        // that reads as a valid, shorter ledger. Awaited: Safari's first handle was async.
        try {
          await access.write(bytes, { at: 0 });
          await access.flush();
          await access.truncate(bytes.length);
          await access.flush();
        } finally {
          await access.close();
        }
        return;
      }
      const writable = await file.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
  };
}
