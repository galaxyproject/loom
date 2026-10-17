import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { truncateMiddle, utf8ByteLength } from "../shared/truncate-middle.js";

const ROOT = join(__dirname, "..");

// The port has to cut exactly where pi does, so pi's own function is the reference. Imported here
// only: product code never reaches into pi's dist.
type PiTruncate = { truncateMiddle: typeof truncateMiddle };
const pi = (await import(
  pathToFileURL(
    join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js"),
  ).href
)) as PiTruncate;

const SAMPLES = {
  ascii: "plain ascii text\nwith two lines\n",
  cjk: "銀河の道具は多い。".repeat(5),
  emoji: "🧬🔬🧪".repeat(7),
  loneHigh: "before \ud83e after",
  loneLow: "before \udd2c after",
  trailingHigh: "ends with \ud83e",
  mixed: "aé中🧬\ud83e\n".repeat(9),
  bom: "﻿starts with a byte order mark " + "x".repeat(40),
};

describe("utf8ByteLength", () => {
  it.each(Object.entries(SAMPLES))("matches Node's byte length for %s", (_name, text) => {
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text));
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
  });

  it("counts the empty string as zero", () => {
    expect(utf8ByteLength("")).toBe(0);
  });
});

describe("truncateMiddle", () => {
  it("returns content under the cap unchanged", () => {
    const text = SAMPLES.ascii;
    const result = truncateMiddle(text, 1000);
    expect(result).toEqual(pi.truncateMiddle(text, 1000));
    expect(result).toMatchObject({ content: text, truncated: false, removedChars: 0 });
    expect(result.totalLines).toBe(2);
  });

  it("returns content exactly at the cap unchanged", () => {
    const text = "x".repeat(64);
    expect(truncateMiddle(text, 64)).toEqual(pi.truncateMiddle(text, 64));
    expect(truncateMiddle(text, 64).truncated).toBe(false);
  });

  it("cuts where pi cuts for every cap, including multibyte characters straddling both cuts", () => {
    for (const text of Object.values(SAMPLES)) {
      for (let max = 0; max <= utf8ByteLength(text) + 1; max++) {
        expect(truncateMiddle(text, max), `${JSON.stringify(text)} at ${max}`).toEqual(
          pi.truncateMiddle(text, max),
        );
      }
    }
  });

  it("writes pi's marker and keeps both ends", () => {
    const result = truncateMiddle("head-" + "m".repeat(100) + "-tail", 10);
    expect(result.content).toBe("head-…100 chars truncated…-tail");
    expect(result).toMatchObject({ truncated: true, removedChars: 100, totalBytes: 110 });
  });

  it("matches pi at the 20 KiB spill cap over a large multibyte payload", () => {
    const text = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: `🧬 ${i} 銀河`,
        note: "é".repeat(7),
      })),
    );
    const cap = 20 * 1024;
    const result = truncateMiddle(text, cap);
    expect(result).toEqual(pi.truncateMiddle(text, cap));
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.content)).toBeLessThanOrEqual(cap + 64);
  });
});
