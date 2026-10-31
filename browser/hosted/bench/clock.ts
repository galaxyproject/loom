/** Shared by the runner and the workers, so it imports nothing. */

/**
 * Epoch milliseconds with sub-millisecond resolution. performance.now() alone is relative to each
 * thread's own origin, so marks from different workers only line up through timeOrigin.
 */
export const now = () => performance.timeOrigin + performance.now();

export interface Mem {
  /** Process-wide: every worker's isolate shares this number. */
  rss: number;
  /** This isolate's own. */
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** v8.getHeapCodeStatistics(): bytecode, compiled code, and script source held outside the heap. */
  code?: { bytecode: number; code: number; source: number };
  /** v8.getHeapSpaceStatistics(): used bytes per space, to see where a build's heap goes. */
  spaces?: Record<string, number>;
}

/** Epoch ms, all optional until reached. */
export interface Marks {
  /** Main thread, just before new Worker(). */
  spawn?: number;
  /** The worker's first line. */
  workerStart?: number;
  /** import() of the Orbit entry resolved. */
  loaded?: number;
  seams?: number;
  /** createPiHost, extensions/orbit registered, sealed. */
  registered?: number;
  /** Harness.open, createConversation, host.attach. */
  opened?: number;
  /** host.start("startup") and harness.resume(). */
  started?: number;
  /** The worker's fetch for its first model request. */
  firstRequest?: number;
  /** The stub endpoint received it (main thread). */
  firstArrival?: number;
  greeted?: number;
  submit?: number;
  /** The worker's fetch for the request carrying the user's message. */
  userRequest?: number;
  userArrival?: number;
  answered?: number;
}
