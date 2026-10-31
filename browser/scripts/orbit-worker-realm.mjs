/**
 * Runs a built worker module in a realm that has only what a browser worker has: no process, no
 * Buffer, no require, no Node builtins. Prints the first message the worker posts, as JSON, and
 * exits non-zero if the module fails to load or posts { ok: false }.
 *
 * Needs --experimental-vm-modules. Used by preflight-orbit.mjs; it catches what the Node
 * conformance test can't (a global the bundle assumes) without a browser, though a real browser
 * still differs, which is what e2e/orbit-preflight-drive.cjs is for.
 */
import fs from "node:fs";
import vm from "node:vm";

const file = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 30_000);

const WEB_GLOBALS = [
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "CompressionStream",
  "DecompressionStream",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "atob",
  "btoa",
  "console",
  "performance",
  "navigator",
  "WebAssembly",
  "DOMException",
];

const done = (code, payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
};

const sandbox = {};
for (const name of WEB_GLOBALS) if (name in globalThis) sandbox[name] = globalThis[name];
sandbox.postMessage = (data) => done(data && data.ok ? 0 : 1, data);
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.location = new URL("http://localhost/assets/worker.js");
const context = vm.createContext(sandbox);
vm.runInContext("globalThis.self = globalThis;", context);

const module = new vm.SourceTextModule(fs.readFileSync(file, "utf8"), {
  context,
  identifier: "http://localhost/assets/worker.js",
  initializeImportMeta: (meta) => {
    meta.url = "http://localhost/assets/worker.js";
  },
});
setTimeout(
  () => done(1, { ok: false, error: `no message within ${timeoutMs} ms` }),
  timeoutMs,
).unref();
try {
  await module.link(async (specifier) => {
    throw new Error(`the worker bundle imports ${specifier}; it must be one file`);
  });
  await module.evaluate();
} catch (error) {
  done(1, { ok: false, error: `module failed to load: ${error?.stack ?? error}` });
}
