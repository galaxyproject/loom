/**
 * The core mounted with nothing but what it requires: no tools, skills or artifact kinds of its
 * own, no session store, and the default launch on the current history. If this stops booting or
 * starts saying things it can't back up, the core has started assuming a particular flavor.
 */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";

const root = new URL("/", window.location.href).href;

void mountOrbitBrowser(document.getElementById("app")!, {
  galaxyRoot: root,
  // Not a visualization plugin, so Galaxy serves no AI proxy for it and the picker offers
  // every provider but that one.
  pyodideURL: new URL("static/pyodide", document.baseURI).href,
  createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
