/** A running worker for tests: every message it posted, and a way to wait for the next of a kind. */
import type { Worker } from "node:worker_threads";

import type { FromWorker, TokenAnswer, WorkerData } from "./protocol";
import { spawnWorker } from "./spawn";

export interface Running {
  readonly worker: Worker;
  readonly messages: FromWorker[];
  readonly exited: Promise<number>;
  /** The `count`th message of `type` (1-based), waiting for it if it hasn't come yet. */
  waitFor<T extends FromWorker["type"]>(type: T, count?: number): Promise<Extract<FromWorker, { type: T }>>;
  count(type: FromWorker["type"]): number;
}

/** How a test answers the worker's token requests; by default, always with one token. */
export type Tokens = () => TokenAnswer | Promise<TokenAnswer>;
export const TEST_TOKEN = "test-access-token";

export function watch(worker: Worker, tokens: Tokens = () => ({ token: TEST_TOKEN })): Running {
  const messages: FromWorker[] = [];
  const waiters = new Set<() => void>();
  worker.on("message", (message: FromWorker) => {
    if (message.type === "token") {
      void Promise.resolve(tokens()).then((answer) => worker.postMessage({ cmd: "token", id: message.id, ...answer }));
    }
    messages.push(message);
    for (const wake of waiters) wake();
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  const failed = new Promise<never>((_, reject) => worker.once("error", reject));
  failed.catch(() => undefined);
  return {
    worker,
    messages,
    exited,
    count: (type) => messages.filter((m) => m.type === type).length,
    waitFor: (type, count = 1) =>
      Promise.race([
        failed,
        exited.then((code) => {
          throw new Error(`Worker exited with ${code} before its ${type} #${count}`);
        }),
        new Promise((resolve) => {
          const check = () => {
            const hit = messages.filter((m) => m.type === type)[count - 1];
            if (hit === undefined) return;
            waiters.delete(check);
            resolve(hit);
          };
          waiters.add(check);
          check();
        }),
      ]) as never,
  };
}

export const runWorker = (bundle: string, data: WorkerData, tokens?: Tokens): Running =>
  watch(spawnWorker(bundle, data), tokens);
