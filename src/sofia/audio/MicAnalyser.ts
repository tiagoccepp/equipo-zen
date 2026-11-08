/**
 * Microphone amplitude analyser for the Listening state.
 *
 * Uses `getUserMedia` -> `AnalyserNode` -> `getByteFrequencyData` to produce a
 * normalised [0, 1] level. This is the one place real audio analysis is
 * feasible (mic input), unlike TTS output which the browser does not expose to
 * an AnalyserNode (see SpeechReactor).
 *
 * Security/privacy: audio-only (no video), the stream is requested on a user
 * gesture by the caller, and `stop()` stops every track to release the mic.
 */

import { computeBands } from './bands';

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export interface MicAnalyserOptions {
  onLevel: (level: number) => void;
  /** Optional per-frame log-spaced frequency bands (richer Listening reaction). */
  onBands?: (bands: Float32Array) => void;
  /** Number of frequency bands to emit (default 4: bass/low-mid/high-mid/treble). */
  bandCount?: number;
  fftSize?: number;
  /** Injectable for tests; defaults to navigator.mediaDevices.getUserMedia. */
  getUserMedia?: GetUserMedia;
  /** Injectable for tests; defaults to the platform AudioContext. */
  audioContextFactory?: () => AudioContext;
}

/**
 * Normalise frequency-bin bytes to a [0, 1] level (mean energy). Pure and
 * unit-tested.
 */
export function computeLevel(data: Uint8Array): number {
  if (data.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const v of data) {
    sum += v;
  }
  return sum / data.length / 255;
}

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultAudioContextFactory(): AudioContext {
  return new AudioContext();
}

export class MicAnalyser {
  private readonly onLevel: (level: number) => void;
  private readonly onBands: ((bands: Float32Array) => void) | undefined;
  private readonly bandCount: number;
  private readonly fftSize: number;
  private readonly getUserMedia: GetUserMedia;
  private readonly audioContextFactory: () => AudioContext;

  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private bandsBuffer: Float32Array | null = null;
  private rafId = 0;
  private active = false;
  // Monotonic token used to cancel an in-flight start() if stop() lands during
  // the getUserMedia await (prevents re-acquiring/leaking the mic).
  private startToken = 0;

  constructor(options: MicAnalyserOptions) {
    this.onLevel = options.onLevel;
    this.onBands = options.onBands;
    this.bandCount = options.bandCount ?? 4;
    this.fftSize = options.fftSize ?? 512;
    this.getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Request the mic and begin emitting levels. Resolves `true` on success,
   * `false` if permission is denied or audio is unavailable (and emits level 0).
   */
  async start(): Promise<boolean> {
    if (this.active) {
      return true;
    }
    const token = ++this.startToken;
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({ audio: true, video: false });
    } catch {
      this.onLevel(0);
      return false;
    }
    if (token !== this.startToken) {
      // stop() (or a newer start) landed during the await: release and bail.
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return false;
    }

    this.stream = stream;
    this.context = this.audioContextFactory();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.buffer = new Uint8Array(this.analyser.frequencyBinCount);
    this.source.connect(this.analyser);

    this.active = true;
    this.loop();
    return true;
  }

  /** Read the current level once (used by the loop and by tests). */
  sample(): number {
    if (!this.analyser) {
      return 0;
    }
    this.analyser.getByteFrequencyData(this.buffer);
    return computeLevel(this.buffer);
  }

  private loop(): void {
    if (!this.active) {
      return;
    }
    // One getByteFrequencyData per frame feeds both the level and the bands.
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.buffer);
      this.onLevel(computeLevel(this.buffer));
      if (this.onBands) {
        if (this.bandsBuffer?.length !== this.bandCount) {
          this.bandsBuffer = new Float32Array(this.bandCount);
        }
        this.onBands(computeBands(this.buffer, this.bandCount, this.bandsBuffer));
      }
    } else {
      this.onLevel(0);
    }
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  /** Stop analysis and release the microphone. */
  stop(): void {
    this.startToken += 1; // invalidate any in-flight start()
    this.active = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.context && this.context.state !== 'closed') {
      void this.context.close();
    }
    this.context = null;
    this.analyser = null;
    this.onLevel(0);
  }
}
