import fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  MAX_DICTATION_BYTES,
  DICTATION_SAMPLE_RATE,
  type DictationResult,
  type DictationStatus,
} from "../shared/dictation.js";

export interface SpeechPaths {
  binary: string;
  model: string;
}

/** Accept only the bounded PCM format produced by Orbit, never paths or flags. */
export function validateDictationWav(value: unknown): Buffer {
  if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array))
    throw new Error("Invalid microphone recording.");
  if (value.byteLength < 46 || value.byteLength > MAX_DICTATION_BYTES)
    throw new Error("Record between a moment and two minutes of speech.");
  const bytes =
    value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.toString("ascii", 12, 16) !== "fmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== DICTATION_SAMPLE_RATE ||
    bytes.readUInt32LE(28) !== DICTATION_SAMPLE_RATE * 2 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2
  )
    throw new Error("Invalid microphone recording.");
  return bytes;
}

function hasSound(bytes: Buffer): boolean {
  let peak = 0;
  let square = 0;
  for (let i = 44; i < bytes.length; i += 2) {
    const v = bytes.readInt16LE(i) / 32768;
    peak = Math.max(peak, Math.abs(v));
    square += v * v;
  }
  return peak > 0.01 && Math.sqrt(square / ((bytes.length - 44) / 2)) > 0.003;
}

/** Audio goes to stdin; only a temporary transcript is written, then removed. */
export async function decodeDictation(
  paths: SpeechPaths,
  wav: Buffer,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "orbit-dictation-"));
  const output = path.join(dir, "transcript");
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        paths.binary,
        ["-m", paths.model, "-f", "-", "-l", "en", "-oj", "-of", output, "-np", "-nt", "-t", "4"],
        {
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        },
      );
      let spawnError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", (error) => {
        spawnError = error;
      });
      child.stdin.on("error", () => {
        /* close reports spawn failures and cancellation */
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        if (signal.aborted) reject(signal.reason);
        else if (spawnError || code !== 0)
          reject(new Error("Speech recognition failed. Try recording again."));
        else resolve();
      });
      child.stdin.end(wav);
    });
    signal.throwIfAborted();
    const raw = await fsp.readFile(`${output}.json`, "utf8");
    if (raw.length > 128_000) throw new Error("Speech recognition returned too much text.");
    const result = JSON.parse(raw) as { transcription?: Array<{ text: unknown }> };
    if (
      !Array.isArray(result.transcription) ||
      result.transcription.some((row) => typeof row.text !== "string")
    )
      throw new Error("Speech recognition returned an invalid transcript.");
    return result.transcription
      .map((row) => row.text)
      .join("")
      .trim();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export class DictationService {
  private active?: { id: string; controller: AbortController };
  constructor(
    private readonly paths: SpeechPaths,
    private readonly decode = decodeDictation,
  ) {}

  status(): DictationStatus {
    const model = "Whisper Base English";
    try {
      if (
        fs.statSync(this.paths.model).size !== 59_721_011 ||
        !fs.statSync(this.paths.binary).isFile()
      )
        throw new Error("Missing speech resources");
      return { available: true, model };
    } catch {
      return { available: false, model, error: "Local dictation is unavailable in this build." };
    }
  }

  async transcribe(id: unknown, value: unknown): Promise<DictationResult> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      return { ok: false, error: "Invalid dictation request." };
    if (this.active) return { ok: false, error: "Another recording is being transcribed." };
    let wav: Buffer;
    try {
      wav = validateDictationWav(value);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    if (!hasSound(wav)) return { ok: true, text: "" };
    const available = this.status();
    if (!available.available) return { ok: false, error: available.error! };
    const controller = new AbortController();
    this.active = { id, controller };
    const timer = setTimeout(
      () => controller.abort(new Error("Transcription timed out. Try a shorter recording.")),
      180_000,
    );
    timer.unref();
    try {
      return { ok: true, text: await this.decode(this.paths, wav, controller.signal) };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason?.message === "Cancelled")
        return { ok: false, cancelled: true, error: "Dictation cancelled." };
      return {
        ok: false,
        error: controller.signal.aborted
          ? controller.signal.reason.message
          : error instanceof Error
            ? error.message
            : "Speech recognition failed. Try recording again.",
      };
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }

  cancel(id: unknown): void {
    if (this.active && id === this.active.id) this.active.controller.abort(new Error("Cancelled"));
  }

  dispose(): void {
    this.active?.controller.abort(new Error("Cancelled"));
  }
}
