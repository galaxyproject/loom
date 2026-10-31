// @vitest-environment node
import * as node from "node:crypto";
import { describe, expect, it } from "vitest";

import { Buffer } from "./buffer";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "./crypto";
import { readFileSync } from "./fs";
import { fileURLToPath } from "./url";

const TEXTS = ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "π ✓ 🧬".repeat(40)];

describe("the vendored crypto", () => {
  it.each(TEXTS)("hashes like node:crypto (%#)", (text) => {
    expect(createHash("sha256").update(text, "utf-8").digest("hex")).toBe(
      node.createHash("sha256").update(text, "utf-8").digest("hex"),
    );
  });

  it.each([new Uint8Array(32).fill(7), new Uint8Array(100).fill(3)])(
    "signs like node:crypto's HMAC (key of %#)",
    (key) => {
      const text = "registry document";
      expect(createHmac("sha256", key).update(text).digest("hex")).toBe(
        node.createHmac("sha256", key).update(text).digest("hex"),
      );
    },
  );

  it("refuses any other algorithm rather than answering wrong", () => {
    expect(() => createHash("sha1")).toThrow(/sha1 is not available/);
  });

  it("compares in constant shape and refuses unequal lengths, like Node", () => {
    expect(timingSafeEqual(Buffer.from("ab"), Buffer.from("ab"))).toBe(true);
    expect(timingSafeEqual(Buffer.from("ab"), Buffer.from("ac"))).toBe(false);
    expect(() => timingSafeEqual(Buffer.from("a"), Buffer.from("ab"))).toThrow(RangeError);
  });

  it("prints random bytes as hex", () => {
    expect(randomBytes(8).toString("hex")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the vendored Buffer", () => {
  it.each(["utf8", "base64", "hex"] as const)("round-trips %s like Node", (encoding) => {
    const text = "loom-job ✓ 🧬";
    const ours = Buffer.from(text, "utf8").toString(encoding);
    expect(ours).toBe(globalThis.Buffer.from(text, "utf8").toString(encoding));
    expect(Buffer.from(ours, encoding).toString("utf8")).toBe(text);
  });

  it("counts utf-8 bytes", () => {
    expect(Buffer.byteLength("π🧬", "utf-8")).toBe(globalThis.Buffer.byteLength("π🧬", "utf-8"));
  });
});

describe("the worker stand-ins", () => {
  it("throw and name themselves", () => {
    expect(() => readFileSync("/x")).toThrow("fs unavailable in worker: readFileSync");
  });

  // lessons/validate.mjs runs this at module scope on the worker's own http(s): or blob: URL.
  it.each(["file:///a/b.mjs", "http://localhost/assets/worker.js", "blob:http://localhost/1234"])(
    "fileURLToPath accepts %s",
    (url) => {
      expect(() => fileURLToPath(url)).not.toThrow();
    },
  );
});
