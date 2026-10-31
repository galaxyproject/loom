/** The tripwire's positive control: a bundled worker that reaches the filesystem every way Orbit's code can. */
import { existsSync } from "node:fs";
import * as fsNamespace from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { parentPort } from "node:worker_threads";

import { installTripwire } from "./tripwire";

const seen: string[] = [];
installTripwire((api) => seen.push(api));
existsSync("/");
fsNamespace.statSync("/");
(createRequire(import.meta.url)("node:fs") as typeof fsNamespace).readdirSync("/");
os.homedir();
parentPort!.postMessage(seen);
