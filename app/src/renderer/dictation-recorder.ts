import { DICTATION_SAMPLE_RATE, MAX_DICTATION_SECONDS } from "../shared/dictation.js";

export interface DictationRecorder {
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
}

export function pcmToWav(chunks: readonly Float32Array[]): ArrayBuffer {
  const count = chunks.reduce((n, c) => n + c.length, 0);
  if (count > DICTATION_SAMPLE_RATE * MAX_DICTATION_SECONDS)
    throw new Error("Recording is too long.");
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  return buffer;
}

// Audio stays in memory, already resampled by Web Audio for the local decoder.

export async function openMicrophone(signal: AbortSignal): Promise<DictationRecorder> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone recording is unavailable.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let context: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let stopped = false;
  let chunks: Float32Array[] = [];
  let count = 0;
  let flushed: (() => void) | undefined;
  const cleanup = () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    worklet?.disconnect();
    if (context && context.state !== "closed") void context.close().catch(() => {});
    signal.removeEventListener("abort", cancel);
  };
  const cancel = () => {
    chunks = [];
    cleanup();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
    await context.audioWorklet.addModule(
      new URL("./dictation-worklet.js", window.location.href).href,
    );
    signal.throwIfAborted();
    worklet = new AudioWorkletNode(context, "orbit-microphone");
    worklet.port.onmessage = (
      event: MessageEvent<{ samples?: Float32Array; flushed?: boolean }>,
    ) => {
      if (stopped) return;
      if (event.data.samples) {
        const remaining = DICTATION_SAMPLE_RATE * MAX_DICTATION_SECONDS - count;
        const samples = event.data.samples.slice(0, remaining);
        if (samples.length) {
          chunks.push(samples);
          count += samples.length;
        }
      }
      if (event.data.flushed) flushed?.();
    };
    const source = context.createMediaStreamSource(stream);
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(worklet).connect(mute).connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
    return {
      cancel,
      stop: async () => {
        if (stopped) throw new Error("Recording was cancelled.");
        source.disconnect();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 250);
          flushed = () => {
            clearTimeout(timeout);
            resolve();
          };
          worklet!.port.postMessage("flush");
        });
        signal.throwIfAborted();
        cleanup();
        const wav = pcmToWav(chunks);
        chunks = [];
        return wav;
      },
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
