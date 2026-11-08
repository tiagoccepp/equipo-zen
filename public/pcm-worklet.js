// AudioWorklet processor: mic audio -> 16 kHz mono Int16 frames.
//
// Lives in public/ (served verbatim at the app root, no bundling/transpilation):
// AudioWorklet code runs in AudioWorkletGlobalScope and cannot be a normal ESM
// module, and a `?url` import of a .js does not get emitted by Vite. Loaded via
// `audioWorklet.addModule('/pcm-worklet.js')`.
//
// Reads the mono input (128-sample render quanta at the context sampleRate),
// resamples to 16 kHz with a drift-free fractional accumulator, packs ~30 ms
// (480-sample) Int16 frames, and transfers each frame's ArrayBuffer to the main
// thread. A 480-sample frame at 16 kHz is exactly what the Rust webrtc-vad wants.

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 480; // 30 ms @ 16 kHz

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope (the context's rate).
    this._ratio = sampleRate / TARGET_RATE; // e.g. 48000/16000 = 3.0
    this._pos = 0; // fractional read cursor within the continuous input stream
    this._prevTail = 0; // last input sample of the previous quantum
    this._haveTail = false;
    this._frame = new Int16Array(FRAME_SAMPLES);
    this._frameLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const n = channel.length; // 128
    while (this._pos < n) {
      const i = Math.floor(this._pos);
      const frac = this._pos - i;
      // Linear interpolation between samples i-1 and i (evaluated at _pos-1, i.e. a
      // fixed ~1-input-sample group delay; harmless for STT). i-1 == -1 uses the
      // tail carried from the previous quantum.
      let a;
      if (i > 0) a = channel[i - 1];
      else if (this._haveTail) a = this._prevTail;
      else a = channel[0];
      const b = channel[i];
      let s = a + (b - a) * frac;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._frame[this._frameLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._frameLen === FRAME_SAMPLES) {
        const out = this._frame;
        this.port.postMessage(out.buffer, [out.buffer]); // transfer (zero-copy)
        this._frame = new Int16Array(FRAME_SAMPLES);
        this._frameLen = 0;
      }
      this._pos += this._ratio;
    }

    // Carry the fractional cursor + tail into the next quantum (no drift).
    this._pos -= n;
    this._prevTail = channel[n - 1];
    this._haveTail = true;
    return true; // REQUIRED on Chromium/WebView2 to keep the node alive
  }
}

registerProcessor('pcm-16k', Pcm16kProcessor);
