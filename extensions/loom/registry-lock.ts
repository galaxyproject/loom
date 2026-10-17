/**
 * The registry's writer lock with a fencing token (registry design v3 §10).
 *
 * `<analysis>/.loom/state/lock` holds `{pid, session_id, writer_token,
 * heartbeat}`. One session writes; a second live session opens read-only. A
 * lock whose heartbeat is older than `STALE_LOCK_MS` belonged to a session
 * that died or hung, and is taken over with a fresh token. The token is what
 * fences: every registry write re-reads the lock first, so the old writer's
 * next write finds someone else's token and fails instead of clobbering the
 * new writer's state.
 *
 * A filesystem gives us no compare-and-swap, so the check and the rename
 * that follows it are two steps. The window is one synchronous rename wide;
 * the heartbeat interval is minutes. That is the residual, and it is small.
 */

import { randomHex } from "../../shared/random.js";

export const STALE_LOCK_MS = 120_000;

/** The slice of `fs` the registry uses. Node's `fs` module satisfies it. */
export interface RegistryFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf-8"): string;
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  unlinkSync(path: string): void;
}

export interface LockRecord {
  pid: number;
  session_id: string;
  writer_token: string;
  heartbeat: string;
}

/** The store is synchronous end to end, so its retry backoff is too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `tmp` over `file`, removing `tmp` if that fails for good. Windows
 * refuses to replace a file a scanner or another rename is touching at that
 * instant (EPERM/EACCES/EBUSY) where POSIX would just swap it in -- the
 * notebook writer hit this (#504) -- so there a brief retry gets the outcome
 * POSIX gets. Shared by the lock file and the registry's own writes.
 */
export function renameReplacing(
  fs: RegistryFs,
  tmp: string,
  file: string,
  platform: NodeJS.Platform,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (platform !== "win32" || !transient || attempt >= 10) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort
        }
        throw err;
      }
      sleepSync(10 * (attempt + 1));
    }
  }
}

export function newWriterToken(): string {
  return randomHex(16);
}

function parseLock(text: string): LockRecord | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (
      o &&
      typeof o === "object" &&
      typeof o.pid === "number" &&
      typeof o.session_id === "string" &&
      typeof o.writer_token === "string" &&
      o.writer_token.length > 0 &&
      typeof o.heartbeat === "string"
    ) {
      return {
        pid: o.pid,
        session_id: o.session_id,
        writer_token: o.writer_token,
        heartbeat: o.heartbeat,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

export type AcquireResult =
  | { mode: "writer"; token: string; tookOverFrom?: LockRecord }
  | { mode: "read-only"; holder: LockRecord };

export class RegistryLock {
  private token: string | null = null;

  constructor(
    private readonly lockPath: string,
    private readonly fs: RegistryFs,
    private readonly clock: () => number,
    private readonly pid: number,
    private readonly sessionId: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The token this process holds, or null if it isn't the writer. */
  get heldToken(): string | null {
    return this.token;
  }

  read(): LockRecord | null {
    if (!this.fs.existsSync(this.lockPath)) return null;
    try {
      return parseLock(this.fs.readFileSync(this.lockPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private record(token: string): LockRecord {
    return {
      pid: this.pid,
      session_id: this.sessionId,
      writer_token: token,
      heartbeat: new Date(this.clock()).toISOString(),
    };
  }

  private isStale(lock: LockRecord): boolean {
    const beat = Date.parse(lock.heartbeat);
    // An unparseable heartbeat is no evidence anyone is alive.
    if (!Number.isFinite(beat)) return true;
    return this.clock() - beat > STALE_LOCK_MS;
  }

  private writeAtomic(rec: LockRecord): void {
    const tmp = `${this.lockPath}.${this.pid}.${randomHex(6)}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify(rec), { flag: "wx" });
    renameReplacing(this.fs, tmp, this.lockPath, this.platform);
  }

  acquire(): AcquireResult {
    const token = newWriterToken();
    const mine = this.record(token);
    // Fast path: nobody holds it. `wx` makes creation exclusive, so two
    // sessions racing for a fresh directory can't both win.
    try {
      this.fs.writeFileSync(this.lockPath, JSON.stringify(mine), { flag: "wx" });
      this.token = token;
      return { mode: "writer", token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }

    const existing = this.read();
    if (existing && !this.isStale(existing)) {
      this.token = null;
      return { mode: "read-only", holder: existing };
    }
    // Stale or unreadable: take it over, then confirm we're the one who landed,
    // since another session may have been taking it over at the same moment.
    this.writeAtomic(mine);
    const after = this.read();
    if (after?.writer_token !== token) {
      this.token = null;
      return { mode: "read-only", holder: after ?? mine };
    }
    this.token = token;
    return existing ? { mode: "writer", token, tookOverFrom: existing } : { mode: "writer", token };
  }

  /** True if the lock on disk still carries this process's token. */
  stillHeld(): boolean {
    return this.token !== null && this.read()?.writer_token === this.token;
  }

  /**
   * Refresh the heartbeat. Returns false, and gives up the writer role, if
   * the lock was taken over in the meantime.
   */
  heartbeat(): boolean {
    if (!this.stillHeld()) {
      this.token = null;
      return false;
    }
    this.writeAtomic(this.record(this.token as string));
    return true;
  }

  /** Remove the lock if it is still ours. */
  release(): void {
    if (this.stillHeld()) {
      try {
        this.fs.unlinkSync(this.lockPath);
      } catch {
        // already gone
      }
    }
    this.token = null;
  }

  /** Forget the writer role without touching the file (after being fenced). */
  relinquish(): void {
    this.token = null;
  }
}
