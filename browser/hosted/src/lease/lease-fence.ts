/**
 * The worker side of the lease fence (plan key decision 9): a lease-generation rejection is fatal.
 * The first sign of a lost lease -- a commit PostgresStorage refuses, or a Galaxy write whose
 * generation check finds another host has bumped it -- trips the fence once, and the worker exits
 * without retrying. The host then marks the conversation for recovery and a fresh worker takes it.
 *
 * The storage half is exact: the generation is checked under the store's row lock inside the
 * commit. The Galaxy half is not. It is check-then-send with nothing held across the request, so a
 * bump that lands after the check, or while a slow Galaxy is still answering, lets the write
 * through; the storage fence then trips at the next commit, after the side effect. It narrows the
 * stale-write window to one round trip. Closing it would need Galaxy to honor a fencing token.
 * Only the transport handed to fetch() is fenced: model calls and other outbound requests are not.
 *
 * pi-durable alone does not stop the worker. LeaseLostError is not a StorageRejected, so the
 * Session poisons itself and refuses later commits, but nothing is closed: invocations already
 * running (a tool mid-request, Orbit's own timers) keep going, and the error only reaches the
 * harness's onReport. Catching it at the storage boundary is the one place it is seen first and
 * every time.
 */
import { isMainThread } from "node:worker_threads";
import type { Storage } from "@earendil-works/pi-durable";
import type { PoolClient } from "pg";

import { currentLeaseGen, LeaseLostError } from "../storage/postgres-storage";

/** EX_TEMPFAIL: the host reads it as "lease lost, recover elsewhere", never as a crash to retry here. */
export const LEASE_LOST_EXIT_CODE = 75;

/** The LeaseLostError behind `error`, through the Session's "poisoned" wrapper and any other cause chain. */
export function leaseLostIn(error: unknown): LeaseLostError | undefined {
  for (let e = error, depth = 0; e !== undefined && e !== null && depth < 16; depth++) {
    if (e instanceof LeaseLostError) return e;
    // A bundled worker and its host can hold two copies of the class; the name is the contract.
    if (e instanceof Error && e.name === "LeaseLostError") return e as LeaseLostError;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface LeaseFenceOptions {
  readonly storeId: string;
  readonly leaseGen: number;
  /** Where the fence reads the store's current generation before a Galaxy write. */
  readonly db: Pick<PoolClient, "query">;
  /**
   * Runs once, synchronously, on the first sign of a lost lease. Defaults to exiting the worker
   * thread; required on the main thread, where that default would take every conversation with it.
   */
  readonly onLost?: (error: LeaseLostError) => void;
}

export class LeaseFence {
  readonly storeId: string;
  readonly leaseGen: number;
  #db: Pick<PoolClient, "query">;
  #onLost: (error: LeaseLostError) => void;
  #lost: LeaseLostError | undefined;

  constructor(options: LeaseFenceOptions) {
    this.storeId = options.storeId;
    this.leaseGen = options.leaseGen;
    this.#db = options.db;
    if (options.onLost === undefined && isMainThread) {
      throw new Error("LeaseFence on the main thread needs an onLost: exiting would kill the host");
    }
    this.#onLost = options.onLost ?? (() => process.exit(LEASE_LOST_EXIT_CODE));
  }

  get lost(): LeaseLostError | undefined {
    return this.#lost;
  }

  /**
   * Trip on the first lost lease and ignore later ones. Any other error is left alone: only the
   * fence's own verdict is fatal, so a flaky query still goes through pi-durable's usual paths.
   */
  check(error: unknown): void {
    const lost = leaseLostIn(error);
    if (lost === undefined || this.#lost !== undefined) return;
    this.#lost = lost;
    this.#onLost(lost);
  }

  /** The storage with every commit rejection checked before pi-durable sees it. */
  storage<S extends Storage>(storage: S): S {
    return new Proxy(storage, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop !== "commit") return value.bind(target);
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (error) {
            this.check(error);
            throw error;
          }
        };
      },
    });
  }

  /**
   * Galaxy access for this worker. After the fence trips nothing goes out; before that, a write
   * re-reads the generation first, because a tool can be mid-call when another host takes the
   * lease and the next commit -- the storage fence -- comes only after the write has landed.
   * Best-effort: a bump between the check and Galaxy acting on the request is not seen here.
   */
  fetch(
    inner: (url: string, init: RequestInit) => Promise<Response>,
  ): (url: string, init: RequestInit) => Promise<Response> {
    return async (url, init) => {
      if (this.#lost !== undefined) throw this.#lost;
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        const current = await currentLeaseGen(this.#db, this.storeId);
        if (current !== this.leaseGen) {
          const lost = new LeaseLostError(this.storeId, this.leaseGen, current ?? -1);
          this.check(lost);
          throw lost;
        }
      }
      if (this.#lost !== undefined) throw this.#lost;
      return inner(url, init);
    };
  }
}
