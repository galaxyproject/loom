/* global AudioWorkletProcessor, registerProcessor */
// A same-origin app asset so capture works under Orbit's script-src 'self'.
class OrbitMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.length = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage({ flushed: true });
    };
  }
  flush() {
    if (!this.length) return;
    const samples = this.samples.slice(0, this.length);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length)
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0;
        for (const channel of channels) value += channel[i] / channels.length;
        this.samples[this.length++] = value;
        if (this.length === this.samples.length) this.flush();
      }
    return true;
  }
}
registerProcessor("orbit-microphone", OrbitMicrophone);
