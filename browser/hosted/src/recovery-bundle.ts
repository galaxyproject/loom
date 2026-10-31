/** Bundles recovery-worker.ts the way worker/bundle.ts bundles the service's own worker. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleWorker } from "./worker/bundle";

export { REPO } from "./worker/bundle";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function bundleRecoveryWorker(outfile: string): Promise<string> {
  return bundleWorker(join(HERE, "recovery-worker.ts"), outfile);
}
