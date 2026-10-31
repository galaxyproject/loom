/** Serving the built browser shell: files from one directory, index.html for anything else. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve `root`; false when the request isn't a GET or HEAD. Hashed assets are cached for good. */
export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = decodeURIComponentSafe(new URL(req.url ?? "/", "http://x").pathname);
  // Resolved inside root or not at all: no ../ escapes.
  const candidate = pathname === undefined ? undefined : normalize(join(root, pathname));
  let file = candidate && (candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)) ? candidate : undefined;
  if (file && !(await isFile(file))) file = undefined;
  // A client-side route: the shell decides what it shows.
  const target = file ?? join(root, "index.html");
  if (!(await isFile(target))) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found.");
    return true;
  }
  const immutable = file !== undefined && /\/assets\//.test(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function decodeURIComponentSafe(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}
