/**
 * The Orbit worker's environment in a browser worker: the page through postMessage, OPFS storage
 * behind a tab lock, Pyodide, and the shipped skill bodies as files beside the bundle, fetched when
 * skills_fetch reads one (inlining them would put 2.3 MB of text in the worker that most sessions
 * never read). Only the browser entry (worker.ts) imports this, so Node's bundle never meets it.
 */
import { MemoryStorage } from "@earendil-works/pi-durable";

import { createMemoryLedger } from "../../../../../extensions/orbit/submission-ledger";
import { browserPython } from "../python";
import { holdStorage, openStorage } from "../storage";
import { openLedger, opfsFile } from "./ledger";
import type { SkillReader } from "./skills";
import type { OrbitWorkerEnv } from "./worker";

const ROOT = "../../../../../extensions/orbit/vendor/skills/";

const BODIES = import.meta.glob("../../../../../extensions/orbit/vendor/skills/**/*", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** A shipped body fetched from beside the worker bundle, where the build put it. */
const fetchBody: SkillReader = async (target) => {
  const url = BODIES[`${ROOT}${target}`];
  if (!url) return null;
  const response = await fetch(url);
  // A failed fetch is a failure, not a file the tree doesn't have.
  if (!response.ok) throw new Error(`${target} could not be loaded (HTTP ${response.status})`);
  return response.text();
};

export const browserEnv: OrbitWorkerEnv = {
  post: (message) => self.postMessage(message),
  base: () => self.location.href,
  python: (request) => browserPython(request.pyodideURL),
  keep: async (brand, user, request) => {
    if (user === undefined) return { storage: new MemoryStorage(), ledger: createMemoryLedger() };
    await holdStorage(`${brand.id}:storage`, {
      steal: request.steal,
      waiting: () => browserEnv.post({ type: "waiting" }),
      lost: () => {
        browserEnv.post({ type: "lost" });
        self.close();
      },
    });
    const { storage, unkept } = await openStorage(`${brand.id}-${user}-orbit`, brand.id);
    // Its own files, like the storage, and the same fallback to memory when they can't be opened.
    const opened = await openLedger(opfsFile(`${brand.id}-${user}-orbit-ledger.json`));
    return { storage, ledger: opened.ledger, unkept: unkept ?? opened.unkept };
  },
  root: "/orbit",
  readSkill: fetchBody,
};
