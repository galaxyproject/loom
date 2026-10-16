// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { DictationController } from "../app/src/renderer/dictation";
import { pcmToWav } from "../app/src/renderer/dictation-recorder";
import type { DictationResult } from "../app/src/shared/dictation";

function setup() {
  document.body.innerHTML = "<textarea></textarea><button hidden></button><div></div>";
  const input = document.querySelector("textarea")!;
  const button = document.querySelector("button")!;
  const status = document.querySelector("div")!;
  const recorder = {
    stop: vi.fn(async () => pcmToWav([new Float32Array(100).fill(0.2)])),
    cancel: vi.fn(),
  };
  const capture = vi.fn(async () => recorder);
  const api = {
    dictationStatus: vi.fn(async () => ({ available: true, model: "Whisper Base English" })),
    transcribeDictation: vi
      .fn<(...args: unknown[]) => Promise<DictationResult>>()
      .mockResolvedValue({ ok: true, text: "spoken words" }),
    cancelDictation: vi.fn(async () => {}),
  };
  const busy = vi.fn();
  const controller = new DictationController(input, button, status, api, busy, capture);
  return { input, button, status, recorder, capture, api, controller, busy };
}

describe("dictation draft behavior", () => {
  it("inserts into the draft selection and leaves sending to the user", async () => {
    const h = setup();
    await Promise.resolve();
    h.input.value = "before replace after";
    h.input.setSelectionRange(7, 14);
    await h.controller.toggle();
    expect(h.button.dataset.state).toBe("recording");
    expect(h.input.value).toBe("before replace after");
    await h.controller.toggle();
    expect(h.input.value).toBe("before spoken words after");
    expect(h.status.textContent).toContain("then Send");
    expect(h.controller.busy).toBe(false);
    expect(h.recorder.cancel).toHaveBeenCalled();
  });

  it("preserves typing that happens while the recognizer is working", async () => {
    const h = setup();
    await Promise.resolve();
    let resolve!: (value: DictationResult) => void;
    h.api.transcribeDictation.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.input.value = "old";
    h.input.setSelectionRange(0, 3);
    await h.controller.toggle();
    const finish = h.controller.toggle();
    await Promise.resolve();
    h.input.value = "new typed text";
    h.input.setSelectionRange(14, 14);
    resolve({ ok: true, text: "more words" });
    await finish;
    expect(h.input.value).toBe("new typed text more words");
  });

  it("discards a late result after cancellation and releases the microphone", async () => {
    const h = setup();
    await Promise.resolve();
    let resolve!: (value: DictationResult) => void;
    h.api.transcribeDictation.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.input.value = "keep this";
    await h.controller.toggle();
    const finish = h.controller.toggle();
    await Promise.resolve();
    h.controller.cancel();
    expect(h.api.cancelDictation).toHaveBeenCalled();
    resolve({ ok: true, text: "late words" });
    await finish;
    expect(h.input.value).toBe("keep this");
    expect(h.controller.busy).toBe(false);
    expect(h.recorder.cancel).toHaveBeenCalled();
  });

  it("stops a microphone that opens after cancellation", async () => {
    const h = setup();
    await Promise.resolve();
    let resolve!: (value: typeof h.recorder) => void;
    h.capture.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const start = h.controller.toggle();
    h.controller.cancel();
    resolve(h.recorder);
    await start;
    expect(h.recorder.cancel).toHaveBeenCalled();
    expect(h.api.transcribeDictation).not.toHaveBeenCalled();
    expect(h.controller.busy).toBe(false);
  });

  it("reports permission denial and empty transcription without changing the draft", async () => {
    const h = setup();
    await Promise.resolve();
    h.input.value = "keep";
    h.capture.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await h.controller.toggle();
    expect(h.status.textContent).toContain("Microphone access was denied");
    h.api.transcribeDictation.mockResolvedValueOnce({ ok: true, text: "" });
    await h.controller.toggle();
    await h.controller.toggle();
    expect(h.status.textContent).toContain("No speech detected");
    expect(h.input.value).toBe("keep");
  });

  it("writes signed little-endian mono PCM, clipping invalid samples", () => {
    const wav = pcmToWav([Float32Array.from([-2, 0, 2, NaN])]);
    const view = new DataView(wav);
    expect(view.getUint32(24, true)).toBe(16000);
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([
      -32768, 0, 32767, 0,
    ]);
  });
});
