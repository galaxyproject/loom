// The worker thread's entry in the image: turn on V8's compile cache, shared by every worker and
// kept across restarts, before the large bundle is compiled (bench/RESULTS-boot.md: about 40 MB less
// per worker together with the minified ASCII bundle).
import module from "node:module";
import { workerData } from "node:worker_threads";

if (workerData?.compileCache) module.enableCompileCache(workerData.compileCache);
await import("./orbit-worker.mjs");
