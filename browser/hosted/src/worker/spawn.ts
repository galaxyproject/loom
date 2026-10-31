/** Starting a conversation's worker from the host. */
import { Worker } from "node:worker_threads";

import type { WorkerData } from "./protocol";

export interface SpawnOptions {
  /** V8 old-space ceiling. The step-0 bench measured 80-120 MB RSS per idle worker. */
  readonly maxOldGenerationSizeMb?: number;
}

/**
 * Start the bundled worker for one conversation. `env: {}` gives it an empty environment of its own,
 * so nothing the host was started with -- database password, client secret, token key -- is visible
 * to Orbit or to the model through it.
 */
export function spawnWorker(bundle: string, data: WorkerData, options: SpawnOptions = {}): Worker {
  return new Worker(bundle, {
    workerData: data,
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? 384 },
  });
}
