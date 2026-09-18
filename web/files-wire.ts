/**
 * The wire shape for the web shell's file surface, and its inverse.
 *
 * `OrbitAPI.readFile` promises a `Uint8Array`, which JSON cannot carry, so the
 * server sends base64 in `bytesBase64` and the shim rebuilds the array here.
 * Everything else on the wire is already the shape the renderer is typed
 * against.
 *
 * Kept out of `files-surface.ts` so it stays importable from the browser: that
 * module reaches for `node:fs`. Kept out of `orbit-shim.ts` so it can be tested
 * at all -- the shim opens a WebSocket the moment it is imported.
 *
 * Both decoders treat the response as a shape that may not be there at all: a
 * server older than this bundle answers an unknown channel with `null`, and the
 * renderer must get a refusal it can render rather than a TypeError. Neither
 * walks the tree or the bytes looking for lies -- the producer is our own
 * server, one file over -- so this is shape tolerance, not validation.
 */

import type { FileNode } from "../app/src/preload/preload.js";

export type OrbitReadResult =
  | {
      ok: true;
      size: number;
      bytes: Uint8Array;
      preview?: { kind: "head"; lineCount: number; byteBudgetHit: boolean };
    }
  | { ok: false; error: string; size?: number };

export type OrbitListResult =
  { ok: true; root: FileNode; cwd: string } | { ok: false; error: string };

const NO_SURFACE = "this shell has no file surface";

/**
 * The shim's `invoke` rejects while the socket is down, and the file tree and
 * the file viewer both call these without a catch. A rejection there is an
 * unhandled promise and, for the viewer, nothing on screen at all -- so a
 * transport failure becomes the same refusal shape everything else returns.
 */
export function transportRefusal(err: unknown, fallback: string): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : "";
  return { ok: false, error: message || fallback };
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

function errorFrom(record: Record<string, unknown>, fallback: string): string {
  return typeof record.error === "string" && record.error ? record.error : fallback;
}

export function decodeReadResponse(raw: unknown): OrbitReadResult {
  const record = asRecord(raw);
  if (!record) return { ok: false, error: NO_SURFACE };
  if (record.ok !== true) {
    const failure: OrbitReadResult = {
      ok: false,
      error: errorFrom(record, "the file could not be read"),
    };
    if (typeof record.size === "number") failure.size = record.size;
    return failure;
  }
  if (typeof record.bytesBase64 !== "string") {
    return { ok: false, error: "the file could not be read" };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(record.bytesBase64);
  } catch {
    return { ok: false, error: "the file could not be read" };
  }
  const decoded: OrbitReadResult = {
    ok: true,
    size: typeof record.size === "number" ? record.size : bytes.length,
    bytes,
  };
  const preview = asRecord(record.preview);
  if (preview && preview.kind === "head") {
    decoded.preview = {
      kind: "head",
      lineCount: typeof preview.lineCount === "number" ? preview.lineCount : 0,
      byteBudgetHit: preview.byteBudgetHit === true,
    };
  }
  return decoded;
}

export function decodeListResponse(raw: unknown): OrbitListResult {
  const record = asRecord(raw);
  if (!record) return { ok: false, error: NO_SURFACE };
  if (record.ok !== true)
    return { ok: false, error: errorFrom(record, "the files could not be listed") };
  const root = asRecord(record.root);
  // The renderer walks `children` and reads `name`/`relPath` off every node, so
  // check the one level that would throw rather than draw wrong.
  if (!root || root.type !== "directory" || (root.children && !Array.isArray(root.children))) {
    return { ok: false, error: "the files could not be listed" };
  }
  return {
    ok: true,
    root: root as unknown as FileNode,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
  };
}
