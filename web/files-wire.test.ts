import { describe, it, expect } from "vitest";
import {
  base64ToBytes,
  decodeListResponse,
  decodeReadResponse,
  transportRefusal,
} from "./files-wire.js";

describe("base64ToBytes", () => {
  it("round-trips every byte value", () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const b64 = Buffer.from(original).toString("base64");
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(original));
  });

  it("decodes an empty payload to an empty array", () => {
    expect(base64ToBytes("").length).toBe(0);
  });
});

describe("decodeReadResponse", () => {
  // A server older than this bundle answers an unknown channel with null, and
  // the renderer has to get something it can draw rather than a TypeError.
  it.each([[null], [undefined], ["oops"], [42]])("turns %o into a refusal", (raw) => {
    const res = decodeReadResponse(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("this shell has no file surface");
  });

  it("passes a refusal and its size through", () => {
    const res = decodeReadResponse({ ok: false, error: "File too large (9 bytes)", size: 9 });
    expect(res).toEqual({ ok: false, error: "File too large (9 bytes)", size: 9 });
  });

  it("supplies a message when the server gave none", () => {
    const res = decodeReadResponse({ ok: false });
    expect(res).toEqual({ ok: false, error: "the file could not be read" });
  });

  it("rebuilds the byte array the renderer is typed against", () => {
    const res = decodeReadResponse({
      ok: true,
      size: 5,
      bytesBase64: Buffer.from("hello", "utf-8").toString("base64"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(new TextDecoder().decode(res.bytes)).toBe("hello");
    expect(res.size).toBe(5);
    expect(res.preview).toBeUndefined();
  });

  it("falls back to the decoded length when the server omitted size", () => {
    const res = decodeReadResponse({
      ok: true,
      bytesBase64: Buffer.from("abc").toString("base64"),
    });
    expect(res.ok && res.size).toBe(3);
  });

  it("refuses an ok response with no bytes", () => {
    expect(decodeReadResponse({ ok: true, size: 1 })).toEqual({
      ok: false,
      error: "the file could not be read",
    });
  });

  it("refuses base64 it cannot decode instead of throwing", () => {
    const res = decodeReadResponse({ ok: true, bytesBase64: "not base64 ***" });
    expect(res).toEqual({ ok: false, error: "the file could not be read" });
  });

  it("normalizes a head preview and drops an unknown one", () => {
    const bytesBase64 = Buffer.from("x").toString("base64");
    const head = decodeReadResponse({ ok: true, bytesBase64, preview: { kind: "head" } });
    expect(head.ok && head.preview).toEqual({ kind: "head", lineCount: 0, byteBudgetHit: false });

    const other = decodeReadResponse({ ok: true, bytesBase64, preview: { kind: "tail" } });
    expect(other.ok && other.preview).toBeUndefined();
  });
});

describe("decodeListResponse", () => {
  it.each([[null], [undefined], ["oops"]])("turns %o into a refusal", (raw) => {
    const res = decodeListResponse(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("this shell has no file surface");
  });

  it("passes a refusal through", () => {
    expect(decodeListResponse({ ok: false, error: "nope" })).toEqual({ ok: false, error: "nope" });
  });

  it("passes a tree through", () => {
    const root = { name: "analysis", relPath: "", type: "directory", children: [] };
    expect(decodeListResponse({ ok: true, root, cwd: "/tmp/analysis" })).toEqual({
      ok: true,
      root,
      cwd: "/tmp/analysis",
    });
  });

  it.each([
    [{ ok: true, cwd: "/tmp" }],
    [{ ok: true, root: { name: "a", relPath: "", type: "file" } }],
    [{ ok: true, root: { name: "a", relPath: "", type: "directory", children: "nope" } }],
  ])("refuses a tree the renderer would choke on: %o", (raw) => {
    expect(decodeListResponse(raw)).toEqual({
      ok: false,
      error: "the files could not be listed",
    });
  });

  it("tolerates a missing cwd", () => {
    const root = { name: "a", relPath: "", type: "directory", children: [] };
    expect(decodeListResponse({ ok: true, root })).toEqual({ ok: true, root, cwd: "" });
  });
});

describe("transportRefusal", () => {
  it("carries the transport's own message", () => {
    expect(transportRefusal(new Error("WebSocket disconnected"), "fallback")).toEqual({
      ok: false,
      error: "WebSocket disconnected",
    });
  });

  it.each([[new Error("")], ["a string"], [null], [undefined]])("falls back for %o", (err) => {
    expect(transportRefusal(err, "fallback")).toEqual({ ok: false, error: "fallback" });
  });
});
