import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DictationService,
  validateDictationWav,
  decodeDictation,
} from "../app/src/main/dictation-service";
import { pcmToWav } from "../app/src/renderer/dictation-recorder";
import { MAX_DICTATION_BYTES } from "../app/src/shared/dictation";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const recording = () => pcmToWav([new Float32Array(1600).fill(0.2)]);

function paths() {
  const model = path.join(dir, "model.bin");
  const fd = fs.openSync(model, "w");
  fs.ftruncateSync(fd, 59_721_011);
  fs.closeSync(fd);
  const binary = path.join(dir, "recognizer");
  fs.writeFileSync(binary, "test fixture");
  return { model, binary };
}

describe("dictation input boundary", () => {
  it("accepts PCM from the recorder and rejects paths, oversized or malformed audio", () => {
    const valid = recording();
    expect(validateDictationWav(valid).length).toBe(3244);
    for (const value of ["/tmp/recording.wav", null, new ArrayBuffer(MAX_DICTATION_BYTES + 1)])
      expect(() => validateDictationWav(value)).toThrow();
    for (const [offset, value] of [
      [22, 2],
      [24, 48000],
      [34, 32],
      [40, 999999],
    ] as const) {
      const invalid = valid.slice(0);
      new DataView(invalid).setUint32(offset, value, true);
      expect(() => validateDictationWav(invalid)).toThrow();
    }
  });

  it("does not infer text from silence or start a decoder for invalid input", async () => {
    const decode = vi.fn();
    const service = new DictationService(paths(), decode);
    expect(await service.transcribe("silent", pcmToWav([new Float32Array(1600)]))).toEqual({
      ok: true,
      text: "",
    });
    expect((await service.transcribe("bad", "--output-file /tmp/other")).ok).toBe(false);
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("dictation lifetime", () => {
  it("cancels only the matching request, then permits a fresh recording", async () => {
    let signal!: AbortSignal;
    const decode = vi.fn((_paths, _wav, incoming: AbortSignal) => {
      signal = incoming;
      return new Promise<string>((_resolve, reject) =>
        incoming.addEventListener("abort", () => reject(incoming.reason), { once: true }),
      );
    });
    const service = new DictationService(paths(), decode);
    const pending = service.transcribe("one", recording());
    expect(await service.transcribe("two", recording())).toMatchObject({ ok: false });
    service.cancel("other");
    expect(signal.aborted).toBe(false);
    service.cancel("one");
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    decode.mockResolvedValueOnce("next recording");
    expect(await service.transcribe("next", recording())).toEqual({
      ok: true,
      text: "next recording",
    });
  });

  it("aborts transcription when its window closes", async () => {
    const decode = vi.fn(
      (_paths, _wav, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const service = new DictationService(paths(), decode);
    const pending = service.transcribe("close", recording());
    service.dispose();
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
  });

  it("reports a missing model without attempting execution", async () => {
    const decode = vi.fn();
    const service = new DictationService(
      { binary: "/missing/binary", model: "/missing/model" },
      decode,
    );
    expect(service.status().available).toBe(false);
    expect(await service.transcribe("missing", recording())).toMatchObject({ ok: false });
    expect(decode).not.toHaveBeenCalled();
  });

  it("removes temporary output even when the native executable fails", async () => {
    // Node rejects the recognizer's CLI flags and exits: exercise real process
    // failure and cleanup without requiring a model or compiler for unit tests.
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("orbit-dictation-")),
    );
    await expect(
      decodeDictation(
        { binary: process.execPath, model: path.join(dir, "absent.bin") },
        Buffer.from(recording()),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/recognition failed/);
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("orbit-dictation-") && !before.has(name));
    expect(after).toEqual([]);
  });
});
