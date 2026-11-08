/**
 * Server-audio TTS for hosts where the browser speech engine is silent.
 *
 * On this Windows host the native `speechSynthesis` engine fires its events but
 * never reaches the output device (Windows SAPI audio is routed away from the
 * speakers), while ordinary media playback works fine. This player fetches a
 * server-rendered WAV (the mcp-voice-hooks `/api/tts-wav` route, which uses
 * PowerShell System.Speech) and plays it through Web Audio, so the audio rides
 * the media path that actually works.
 *
 * Bonus: because we own the decoded buffer, we can route it through a real
 * `AnalyserNode` and drive the Speaking animation from TRUE amplitude. The
 * original spec wanted this ("capture the TTS output stream") but it was
 * infeasible for `speechSynthesis`; it is feasible here.
 *
 * Cross-platform safe: if the endpoint is missing or errors (for example macOS,
 * where the browser voice works), `speak()` resolves `false` so the caller falls
 * back to the native speechSynthesis path. It never throws.
 */

interface FetchResponseLike {
  ok: boolean;
  arrayBuffer: () => Promise<ArrayBuffer>;
}
type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

interface AnalyserLike {
  fftSize: number;
  getByteTimeDomainData: (array: Uint8Array) => void;
  connect: (dest: unknown) => void;
}
interface BufferSourceLike {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect: (dest: unknown) => void;
  start: (when?: number) => void;
  stop: (when?: number) => void;
}
export interface AudioContextLike {
  state: string;
  destination: unknown;
  resume: () => Promise<void>;
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>;
  createBufferSource: () => BufferSourceLike;
  createAnalyser: () => AnalyserLike;
}

export interface MediaTtsOptions {
  /** Server route that returns `audio/wav` for `{ text }`. */
  endpoint?: string;
  onSpeakingStart?: () => void;
  onSpeakingEnd?: () => void;
  onBoundary?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to `new AudioContext()`. */
  audioContextFactory?: () => AudioContextLike;
  /** RMS (0..1) above which a boundary pulse fires. */
  boundaryThreshold?: number;
  /** Minimum ms between boundary pulses. */
  boundaryMinIntervalMs?: number;
  /** Amplitude poll interval (ms). */
  pollIntervalMs?: number;
}

/** The subset of MediaTts that attachTauri drives. Injectable (via the adapter's
 *  mediaTtsFactory) so tests can supply a fake with controllable synth/playback
 *  timing - the speech pump's ordering is otherwise not unit-testable. */
export interface MediaTtsLike {
  readonly isSpeaking: boolean;
  synthesize(text: string): Promise<AudioBuffer | null>;
  playBuffer(buffer: AudioBuffer): Promise<boolean>;
  stop(): void;
  unlock(): void;
  dispose(): void;
}

export class MediaTts implements MediaTtsLike {
  private readonly endpoint: string;
  private readonly onSpeakingStart?: () => void;
  private readonly onSpeakingEnd?: () => void;
  private readonly onBoundary?: () => void;
  private readonly fetchImpl?: FetchLike;
  private readonly audioContextFactory: () => AudioContextLike;
  private readonly boundaryThreshold: number;
  private readonly boundaryMinIntervalMs: number;
  private readonly pollIntervalMs: number;

  private ctx: AudioContextLike | null = null;
  private current: BufferSourceLike | null = null;
  private analyser: AnalyserLike | null = null;
  private envelopeTimer: ReturnType<typeof setInterval> | null = null;
  private lastBoundaryAt = 0;
  private elapsedMs = 0;
  private speaking = false;

  constructor(options: MediaTtsOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/tts-wav';
    this.onSpeakingStart = options.onSpeakingStart;
    this.onSpeakingEnd = options.onSpeakingEnd;
    this.onBoundary = options.onBoundary;
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
    this.boundaryThreshold = options.boundaryThreshold ?? 0.06;
    this.boundaryMinIntervalMs = options.boundaryMinIntervalMs ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 60;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Resume the audio context under a user gesture so later playback is allowed
   * by the browser autoplay policy. Best-effort; never throws.
   */
  unlock(): void {
    try {
      const ctx = this.ensureContext();
      if (ctx?.state === 'suspended') {
        void ctx.resume();
      }
    } catch {
      // Best-effort only.
    }
  }

  /**
   * Fetch + decode `text` into a ready-to-play `AudioBuffer` WITHOUT starting
   * playback. Returns `null` on empty text or any fetch/decode failure (the caller
   * skips that chunk). Splitting synthesis from playback lets the caller synthesize
   * the NEXT chunk while the current one is still playing (pipelining), so chunks
   * play back-to-back with no inter-chunk synthesis gap. Never rejects.
   */
  async synthesize(text: string): Promise<AudioBuffer | null> {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      return null;
    }
    const fetchImpl = this.fetchImpl;
    const ctx = this.ensureContext();
    if (!fetchImpl || !ctx) {
      return null;
    }
    try {
      const res = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        return null;
      }
      const data = await res.arrayBuffer();
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          // Autoplay may still be locked; decode/playback will simply be silent.
        }
      }
      return await ctx.decodeAudioData(data);
    } catch {
      return null;
    }
  }

  /**
   * Play an already-decoded buffer, cutting off any previous reply, and drive the
   * Speaking animation from the real amplitude envelope. Resolves `true` when
   * playback started, `false` otherwise. Never rejects.
   */
  async playBuffer(buffer: AudioBuffer): Promise<boolean> {
    const ctx = this.ensureContext();
    if (!ctx) {
      return false;
    }
    try {
      this.stop(); // cut off any previous reply still playing
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      this.current = source;
      this.analyser = analyser;
      source.onended = () => this.handleEnded(source);
      this.speaking = true;
      this.onSpeakingStart?.();
      this.startEnvelope();
      source.start(0);
      return true;
    } catch {
      this.finishSpeaking();
      return false;
    }
  }

  /**
   * Synthesize `text` on the server and play it. Resolves `true` when handled
   * (played, or empty text), `false` to tell the caller to fall back to the
   * native speech engine. Never rejects. Retained for non-pipelining callers and
   * the unit tests; the pipelined path uses `synthesize` + `playBuffer` directly.
   */
  async speak(text: string): Promise<boolean> {
    const buffer = await this.synthesize(text);
    if (buffer === null) {
      // Preserve the prior contract: empty text = handled (true); a real
      // fetch/decode failure = false so the caller can fall back.
      const trimmed = typeof text === 'string' ? text.trim() : '';
      return trimmed === '';
    }
    return this.playBuffer(buffer);
  }

  /** Stop any in-flight playback and emit a clean end. */
  stop(): void {
    const source = this.current;
    if (source) {
      this.current = null;
      try {
        source.onended = null;
        source.stop(0);
      } catch {
        // Already stopped / not started; ignore.
      }
    }
    this.finishSpeaking();
  }

  dispose(): void {
    this.stop();
    this.analyser = null;
    this.ctx = null;
  }

  private ensureContext(): AudioContextLike | null {
    if (this.ctx) {
      return this.ctx;
    }
    try {
      this.ctx = this.audioContextFactory();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  private handleEnded(source: BufferSourceLike): void {
    if (this.current !== source) {
      return; // superseded by a newer reply
    }
    this.current = null;
    this.finishSpeaking();
  }

  private finishSpeaking(): void {
    this.stopEnvelope();
    this.analyser = null;
    if (this.speaking) {
      this.speaking = false;
      this.onSpeakingEnd?.();
    }
  }

  private startEnvelope(): void {
    this.stopEnvelope();
    const analyser = this.analyser;
    if (!analyser || typeof setInterval === 'undefined') {
      return;
    }
    const bins = new Uint8Array(analyser.fftSize);
    this.lastBoundaryAt = 0;
    this.elapsedMs = 0;
    this.envelopeTimer = setInterval(() => {
      const a = this.analyser;
      if (!this.speaking || !a) {
        return;
      }
      this.elapsedMs += this.pollIntervalMs;
      a.getByteTimeDomainData(bins);
      let sumSq = 0;
      for (const bin of bins) {
        const v = (bin - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / bins.length);
      if (
        rms >= this.boundaryThreshold &&
        this.elapsedMs - this.lastBoundaryAt >= this.boundaryMinIntervalMs
      ) {
        this.lastBoundaryAt = this.elapsedMs;
        this.onBoundary?.();
      }
    }, this.pollIntervalMs);
  }

  private stopEnvelope(): void {
    if (this.envelopeTimer !== null) {
      clearInterval(this.envelopeTimer);
      this.envelopeTimer = null;
    }
  }
}

function defaultAudioContextFactory(): AudioContextLike {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) {
    throw new Error('AudioContext unavailable');
  }
  return new Ctor();
}
