/**
 * Microphone capture for the Tauri STT path.
 *
 * One `getUserMedia` stream is dual-tapped from a single `MediaStreamAudioSource`:
 *  - an `AnalyserNode` drives the Listening visual (level + log-spaced bands),
 *    reusing the same pure analysis as `MicAnalyser`;
 *  - an `AudioWorkletNode` (`pcm-16k`) decimates to 16 kHz mono Int16 and emits
 *    ~30 ms frames, forwarded to the Rust VAD/STT worker via `onFrame`.
 *
 * Neither tap connects to `destination`, and the worklet has `numberOfOutputs:0`,
 * so the mic is never played back (no feedback with the avatar's TTS). Must be
 * started on a user gesture (mic permission + WebView2 autoplay policy).
 */

import { computeLevel } from './MicAnalyser';
import { computeBands } from './bands';

// The visual FFT (Listening level + bands) is cosmetic; 30fps is plenty and
// halves the per-frame analysis + callback cost vs running on every rAF.
const ANALYSIS_INTERVAL_MS = 1000 / 30;

// The worklet is shipped from `public/` (served verbatim at the app root) rather
// than imported: AudioWorklet code runs in its own global scope and cannot be a
// normal ESM module, and a `?url` import of a .js is not emitted by Vite.
const WORKLET_URL = '/pcm-worklet.js';

export interface SttCaptureOptions {
  /** One ~30 ms 16 kHz mono Int16 frame (480 samples) per call. */
  onFrame: (frame: Int16Array) => void;
  /** Mic amplitude [0,1] for the Listening reaction. */
  onLevel?: (level: number) => void;
  /** Log-spaced frequency bands for the richer Listening reaction. */
  onBands?: (bands: Float32Array) => void;
  bandCount?: number;
  fftSize?: number;
  /** Preferred mic device ID (from enumerateDevices). Empty string = system default. */
  deviceId?: string;
  /** Injectable for tests; defaults to navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injectable for tests; defaults to a new AudioContext. */
  audioContextFactory?: () => AudioContext;
}

export class SttCapture {
  private readonly opts: SttCaptureOptions;
  private readonly bandCount: number;
  private readonly fftSize: number;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private bandsBuffer: Float32Array | null = null;
  private rafId = 0;
  private lastAnalysis = 0;
  private active = false;
  private startToken = 0;
  private starting: Promise<boolean> | null = null;

  constructor(options: SttCaptureOptions) {
    this.opts = options;
    this.bandCount = options.bandCount ?? 4;
    this.fftSize = options.fftSize ?? 512;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Request the mic and begin capture. MUST be called from a user gesture.
   * Concurrent calls share one in-flight attempt: a second `start()` made before
   * the first resolves (e.g. a double-tap during the mic-permission/worklet window)
   * returns the same promise instead of opening a second `getUserMedia` stream.
   */
  start(): Promise<boolean> {
    if (this.active) {
      return Promise.resolve(true);
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startInner().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Acquire the mic stream, or null on permission denial / no device. */
  private async acquireStream(): Promise<MediaStream | null> {
    const getUserMedia =
      this.opts.getUserMedia ??
      ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.opts.deviceId) {
      audioConstraints.deviceId = { exact: this.opts.deviceId };
    }
    try {
      return await getUserMedia({ audio: audioConstraints, video: false });
    } catch {
      return null; // permission denied / no device
    }
  }

  private async startInner(): Promise<boolean> {
    const token = ++this.startToken;
    const stream = await this.acquireStream();
    if (!stream) return false;
    if (token !== this.startToken) {
      stopTracks(stream); // stop() landed during await
      return false;
    }

    const ctx = (this.opts.audioContextFactory ?? (() => new AudioContext()))();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // Autoplay may still be locked; capture simply will not run until a gesture.
      }
    }
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch {
      discardCapture(stream, ctx);
      return false;
    }
    if (token !== this.startToken) {
      discardCapture(stream, ctx);
      return false;
    }

    const source = ctx.createMediaStreamSource(stream);

    // Tap 1: analyser for the visual (never connected onward -> no audible output).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    this.buffer = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    // Tap 2: STT worklet. numberOfOutputs:0 -> nothing routes to the speakers.
    const worklet = new AudioWorkletNode(ctx, 'pcm-16k', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      this.opts.onFrame(new Int16Array(e.data));
    };
    source.connect(worklet);

    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.worklet = worklet;
    this.active = true;
    this.loop();
    return true;
  }

  private loop(now = 0): void {
    if (!this.active || !this.analyser) {
      return;
    }
    this.rafId = requestAnimationFrame((t) => this.loop(t));
    if (now - this.lastAnalysis < ANALYSIS_INTERVAL_MS) {
      return; // throttle the cosmetic FFT to ~30fps
    }
    this.lastAnalysis = now;
    this.analyser.getByteFrequencyData(this.buffer);
    this.opts.onLevel?.(computeLevel(this.buffer));
    if (this.opts.onBands) {
      if (this.bandsBuffer?.length !== this.bandCount) {
        this.bandsBuffer = new Float32Array(this.bandCount);
      }
      this.opts.onBands(computeBands(this.buffer, this.bandCount, this.bandsBuffer));
    }
  }

  /** Stop capture and release the mic. */
  stop(): void {
    this.startToken += 1; // invalidate any in-flight start()
    this.active = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.opts.onLevel?.(0);
  }
}

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

/** Abandon a half-built capture: release the mic and close its context. */
function discardCapture(stream: MediaStream, ctx: AudioContext): void {
  stopTracks(stream);
  if (ctx.state !== 'closed') void ctx.close();
}
