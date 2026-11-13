// Pablo voice: dynamic upstream loop (continuous VAD + barge-in + ducking).
// Output: PCM/MP3 with a real AnalyserNode. Input: continuous mic with local
// VAD, pre-buffer, browser-ASR hints and barge-in (barge-in.ts verbatim).

import { evaluateBargeIn, idleBargeInState, trimPreBuffer, type BargeInState } from './lib/barge-in.ts';

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export class VoiceOut {
  onDrained: (() => void) | null = null;
  // QW-07: fires when each chunk is scheduled (real audible start ≈ +20ms).
  // The tag travels opaque (the server tags sentences with sIdx/sText).
  onChunkStart: ((tag: unknown) => void) | null = null;
  levelAvailable = false;

  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: Float32Array<ArrayBuffer> | null = null;
  private active = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  // TF fluency: playback chain in arrival order. Without this, two
  // back-to-back MP3s decode in parallel and the shorter one gets scheduled
  // first (broken order + gaps). All decode+schedule goes through here.
  private playChain: Promise<void> = Promise.resolve();
  // Anti-stale epoch: flush() (barge-in) advances it and whatever was already
  // queued/decoding is dropped instead of playing late.
  private epoch = 0;

  private ensure(): AudioContext {
    if (this.context && this.context.state !== 'closed') {
      return this.context;
    }
    const ctx = new AudioContext();
    this.master = ctx.createGain();
    // Analyser AFTER the gain: ducking also quiets the UI.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.frame = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.context = ctx;
    this.nextStart = ctx.currentTime;
    return ctx;
  }

  async unlock(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
  }

  enqueuePcm(base64: string, sampleRate: number, tag: unknown = null): Promise<void> {
    const at = this.epoch;
    this.playChain = this.playChain
      .then(() => {
        if (at === this.epoch) return this.enqueuePcmNow(base64, sampleRate, at, tag);
      })
      .catch(() => {});
    return this.playChain;
  }

  private async enqueuePcmNow(base64: string, sampleRate: number, at: number, tag: unknown = null): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = Math.max(-1, Math.min(1, samples[i] / 32768));
    }
    if (at !== this.epoch) return; // flush() in the middle: drop it.
    this.schedule(buffer, tag);
  }

  playMp3(base64: string, tag: unknown = null): Promise<void> {
    const at = this.epoch;
    this.playChain = this.playChain
      .then(() => {
        if (at === this.epoch) return this.playMp3Now(base64, at, tag);
      })
      .catch(() => {});
    return this.playChain;
  }

  private async playMp3Now(base64: string, at: number, tag: unknown = null): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const bytes = base64ToBytes(base64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buffer = await ctx.decodeAudioData(copy.buffer);
    if (at !== this.epoch) return; // flush() in the middle: drop it.
    this.schedule(buffer, tag);
  }

  private schedule(buffer: AudioBuffer, tag: unknown = null): void {
    const ctx = this.context as AudioContext;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master as GainNode);
    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
      if (this.active.size === 0) {
        this.onDrained?.();
      }
    };
    const startAt = Math.max(ctx.currentTime + 0.02, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    if (tag !== null && tag !== undefined) {
      try {
        this.onChunkStart?.(tag);
      } catch {
        // Text reveal must never break the audio.
      }
    }
  }

  get playing(): boolean {
    return this.active.size > 0;
  }

  get isPlaying(): boolean {
    return this.active.size > 0;
  }

  /** REAL amplitude (0..1). Measured TTS curve: voice 0.03-0.06, emphasis 0.09. */
  level(): number {
    if (!this.analyser || !this.frame || this.context?.state !== 'running') {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.frame);
    let sum = 0;
    for (let i = 0; i < this.frame.length; i += 1) {
      sum += this.frame[i] * this.frame[i];
    }
    const rms = Math.sqrt(sum / this.frame.length);
    if (rms > 0.004 && !this.levelAvailable) {
      this.levelAvailable = true;
    }
    return Math.min(1, Math.pow(rms / 0.09, 0.7));
  }

  /** Cuts EVERYTHING without closing the context (barge-in). Does not fire onDrained. */
  flush(): void {
    for (const source of this.active) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.active.clear();
    this.epoch += 1; // queued/decoding work goes stale and is dropped.
    if (this.context) {
      this.nextStart = this.context.currentTime;
    }
  }

  /** QW-09: "working" earcon — two soft sine tones, without touching the
   *  speech chain (doesn't consume nextStart or enter `active`: never fires
   *  onDrained or moves the gate). */
  playWorkingEarcon(): void {
    try {
      const ctx = this.ensure();
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      const t0 = ctx.currentTime + 0.02;
      const notes: Array<[number, number]> = [[660, 0], [880, 0.14]];
      for (const [freq, offset] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + offset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.22);
        osc.connect(gain);
        gain.connect(this.master as GainNode);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.25);
      }
    } catch {
      // No audio: silence, never an exception.
    }
  }

  duck(): void {
    // Gentle duck (0.5, not 0.2) and slow transitions: deep, fast ducking
    // sounded like Pablo moving away from and back toward the mic
    // every time the room noise touched the threshold.
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(0.5, this.context.currentTime, 0.08);
    }
  }

  restoreGain(): void {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(1, this.context.currentTime, 0.2);
    }
  }

  stop(): void {
    this.flush();
    void this.context?.suspend();
  }
}

// ── VAD continuo + barge-in ───────────────────────────────────────────

export interface TurnVoiceStats {
  speechMs: number;
  maxRms: number;
  duckFrames: number;
  bargeInterrupts: number;
  floor: number;
  startEff: number;
  // Phase 1 (§3a): app.ts fills these in when resolving the grace period,
  // once it knows whether speech reopened inside the window.
  reopened?: boolean;
  hintEnd?: string;
}

export interface LiveMicOptions {
  onTurnStats?: (stats: TurnVoiceStats) => void;
  onChunk: (base64: string) => void;
  onSpeechStart: () => void;
  onSpeechConfirmed: (speechMs: number) => void;
  onSpeechEnd: (hint: string) => void;
  onDiscarded: () => void;
  onInterrupt: () => void;
  onDuck: (ducked: boolean) => void;
  onMeter?: (level: number, speaking: boolean) => void;
  onState?: (label: string) => void;
  isAgentSpeaking: () => boolean;
  hintText: () => string;
  resetHint: () => void;
  // Adaptive endpointing (§3a): were there barge/interrupt events in the last
  // 2 turns? app.ts tracks it (it sees both cutoff paths). Without this,
  // the VAD assumes no (conservative default).
  recentBarge?: () => boolean;
}

export interface MicTuning {
  sensitivity: number;
  endSilenceMs: number;
  // Discard gate: below this and without a hint the turn is dropped as noise.
  // 250 ms because one syllable (e.g. "yes", "no", "ok": ~200-400 ms acoustic)
  // minus the onset (4 frames × 30 ms = 120 ms) counts 150-300 ms; with 600
  // the desktop (no Web Speech API → no hint) was deaf to any short
  // answer. The real noise judge is Silero on the server (~12 ms measured),
  // this only avoids useless round trips. Do NOT confuse with CONFIRM_SPEECH_MS.
  minSpeechMs: number;
}

export const MIC_NORMAL: MicTuning = { sensitivity: 55, endSilenceMs: 800, minSpeechMs: 250 };

// Sustained speech to confirm (cut the agent / treat the turn as real).
// Stays at 600: a cough (150-250 ms) must never interrupt. Decoupled from
// minSpeechMs (09/11: discard 600→250) to avoid phantom cutoffs.
export const CONFIRM_SPEECH_MS = 600;

// ── Adaptive endpointing (§3a) ──────────────────────────────────────
// Pure, testable decision: how much silence closes speech and how much
// grace it waits afterwards, based on what has been heard this turn.
// Base 800/1000 (historical endSilence; grace trimmed from 1200 on 09/11
// after measuring VAD+grace wait was 85% of stop→transcript).
// The threshold only moves when the signal is clear. When in doubt, don't cut.

export const END_SILENCE_BASE_MS = 800;
export const END_SILENCE_FAST_MS = 575;
// Slow 1100→900 (09/11): grace with reopening already protects cutoffs,
// and 900+1000=1900 ms of tolerated pause is still 3× the fluent pause
// (<600 ms). Saves 200 ms on every short turn, which is the common case.
export const END_SILENCE_SLOW_MS = 900;
// Grace 1200→1000 (09/11): same argument (measured: 85% of stop→transcript
// was VAD+grace wait, not STT). app.ts consumes it via computeEndpointing;
// its local GRACE_MS fallback was aligned to 1000 at ship time.
export const GRACE_BASE_MS = 1000;
export const GRACE_FAST_MS = 600;

// Clear speech to shorten: RMS well above the floor and with a minimum level.
const FAST_MIN_SNR = 3;
const FAST_MIN_MAX_RMS = 0.05;
const FAST_MAX_FLOOR = 0.025;
// High floor: measured silence is unreliable, nothing gets shortened.
const FLOOR_HIGH = 0.03;
// Closing words: the sentence is complete even without a period.
const CLOSING_WORDS = new Set(['gracias', 'chau', 'dale']);
// Function words: the sentence is half-built, it surely continues.
const FUNCTION_WORDS = new Set(['el', 'la', 'de', 'que', 'y', 'para', 'un']);

/** Last 20 chars of the hint: compact telemetry for calibration. */
export function hintTail(hint: string): string {
  return hint.slice(-20);
}

// Normalizes for word comparison (ASR sometimes sends "si" without the accent).
function normWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function tailWords(hintEnd: string): string[] {
  return hintEnd.trim().split(/\s+/).map(normWord).filter(Boolean);
}

/** Does the hint sound like a finished sentence? Punctuation, closing word or isolated yes/no. */
export function isTerminalHint(hintEnd: string): boolean {
  const trimmed = hintEnd.trim();
  if (!trimmed) {
    return false;
  }
  if (/[.!?…?!]$/.test(trimmed)) {
    return true;
  }
  const words = tailWords(trimmed);
  if (words.length === 0) {
    return false;
  }
  const last = words[words.length - 1];
  if (CLOSING_WORDS.has(last)) {
    return true;
  }
  // isolated yes/no: the whole turn is the answer.
  return words.length === 1 && (last === 'si' || last === 'no');
}

/** Did the hint end on a function word? The sentence continues, don't cut. */
export function endsFunctional(hintEnd: string): boolean {
  const words = tailWords(hintEnd);
  if (words.length === 0) {
    return false;
  }
  return FUNCTION_WORDS.has(words[words.length - 1]);
}

export interface EndpointingInput {
  speechMs: number;
  hintEnd: string;
  floor: number;
  maxRms: number;
  recentBarge: boolean;
}

export interface EndpointingDecision {
  endSilenceMs: number;
  graceMs: number;
}

/**
 * Closing thresholds for the current turn. Fast only when EVERYTHING
 * lines up (long turn + complete sentence + clear speech); slow on
 * any doubt (short turn, half sentence, recent cutoffs or noise).
 */
export function computeEndpointing(input: EndpointingInput): EndpointingDecision {
  const { speechMs, hintEnd, floor, maxRms, recentBarge } = input;
  const terminal = isTerminalHint(hintEnd);
  const longTurn = speechMs > 2500;

  // Slow wins: when in doubt, don't cut.
  const slow = speechMs < 1500
    || endsFunctional(hintEnd)
    || recentBarge
    || floor >= FLOOR_HIGH;
  if (slow) {
    return { endSilenceMs: END_SILENCE_SLOW_MS, graceMs: GRACE_BASE_MS };
  }

  // Fast only with clear speech on top of a complete sentence + long turn.
  const clearSpeech = floor <= FAST_MAX_FLOOR
    && maxRms >= FAST_MIN_MAX_RMS
    && maxRms >= floor * FAST_MIN_SNR;
  if (longTurn && terminal && clearSpeech) {
    return { endSilenceMs: END_SILENCE_FAST_MS, graceMs: GRACE_FAST_MS };
  }
  // Short grace with a complete sentence + long turn even if the audio isn't
  // crisp: the VAD already closed, only the following wait is shortened.
  if (longTurn && terminal) {
    return { endSilenceMs: END_SILENCE_BASE_MS, graceMs: GRACE_FAST_MS };
  }
  return { endSilenceMs: END_SILENCE_BASE_MS, graceMs: GRACE_BASE_MS };
}

function thresholds(sensitivity: number): { start: number; cont: number } {
  const s = Math.max(10, Math.min(90, sensitivity));
  const start = 0.062 - (s / 100) * 0.052;
  return { start, cont: start * 0.55 };
}

/**
 * Continuous upstream mic: stays on; the VAD opens/closes turns
 * by RMS. While an agent speaks, every frame goes through barge-in:
 * reversible duck → confirmed interrupt. 640 ms pre-buffer so the
 * interrupting phrase arrives whole.
 */
export class LiveMic {
  private opts: LiveMicOptions;
  private tuning: MicTuning;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private lastMeterAt = 0;
  private lastFrameAt = 0;
  private calib: number[] = [];
  private floor = 0;
  private watchdog: number | null = null;
  private onsetFrames = 0;
  private confirmed = false;
  private turnMaxRms = 0;
  private turnStartEff = 0;
  private totalDuckFrames = 0;
  private totalBargeInterrupts = 0;
  private static readonly MAX_TURN_MS = 30000;
  private static readonly STALL_MS = 1500;
  private static readonly ONSET_FRAMES = 4;
  private preBuffer: Array<{ data: string; durationMs: number }> = [];
  private barge: BargeInState = idleBargeInState();
  bargePhase: 'idle' | 'listening' | 'cut' = 'idle';
  level = 0;

  constructor(options: LiveMicOptions, tuning: MicTuning = MIC_NORMAL) {
    this.opts = options;
    this.tuning = tuning;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  get userSpeaking(): boolean {
    return this.speaking;
  }

  /** Returns barge-in to rest (the orb uses bargePhase for energy). */
  resetBarge(): void {
    this.barge = idleBargeInState();
    this.bargePhase = 'idle';
  }

  async start(): Promise<boolean> {
    if (this.active) {
      return true;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch {
      return false;
    }
    const ctx = new AudioContext();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // No prior gesture; continue anyway.
      }
    }
    try {
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
    } catch {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
      return false;
    }
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-16k', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit'
    });
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      this.handlePcm(e.data);
    };
    source.connect(worklet);
    this.ctx = ctx;
    this.stream = stream;
    this.worklet = worklet;
    this.barge = idleBargeInState();
    this.bargePhase = 'idle';
    this.calib = [];
    this.floor = 0;
    this.lastFrameAt = performance.now();
    // Watchdog: if frames stop (or the turn drags on) while speaking,
    // closing is forced. Without this, a stuck WebKit = eternal "recording".
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
    }
    this.watchdog = window.setInterval(() => {
      if (!this.speaking) {
        return;
      }
      const gap = performance.now() - this.lastFrameAt;
      if (gap > LiveMic.STALL_MS || this.speechMs > LiveMic.MAX_TURN_MS) {
        this.endSpeech(this.opts.hintText());
      }
    }, 500);
    return true;
  }

  stop(cancelSpeech: boolean): void {
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.preBuffer = [];
    this.barge = idleBargeInState();
    this.bargePhase = 'idle';
    this.level = 0;
    if (cancelSpeech) {
      this.opts.onMeter?.(0, false);
    }
  }

  private handlePcm(buf: ArrayBuffer): void {
    const pcm = new Int16Array(buf);
    // Normalized RMS (same scale as the upstream worklet).
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    const rms = pcm.length > 0 ? Math.sqrt(sum / pcm.length) : 0;
    this.lastFrameAt = performance.now();
    // Adaptive noise floor: fast start (20 frames) + slow tracking
    // of the room while there is no speech or agent sound. Without this,
    // mic autoGain and room changes left the threshold pinned
    // and any noise cut the agent.
    if (!this.speaking && !this.opts.isAgentSpeaking()) {
      if (this.calib.length < 20) {
        this.calib.push(rms);
        if (this.calib.length === 20) {
          const sorted = [...this.calib].sort((a, b) => a - b);
          // Cap: if the user spoke during calibration, don't ruin the next turn.
          this.floor = Math.min(sorted[17] * 2.2, 0.04);
        }
      } else {
        // Slow tracker (tau ~6s): rises and falls with the actual room.
        this.floor = Math.min(0.04, Math.max(0, this.floor + (rms - this.floor) * 0.01));
      }
    }
    const durationMs = (pcm.length / 16000) * 1000;
    // Base64 of the raw PCM.
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const data = btoa(bin);

    const { start, cont } = thresholds(this.tuning.sensitivity);
    // The room floor wins if it exceeds the theoretical threshold (noisy mic).
    const contEff = Math.max(cont, this.floor);
    const startEff = Math.max(start, this.floor * 1.4);
    const now = performance.now();
    if (now - this.lastMeterAt > 180) {
      this.lastMeterAt = now;
      this.level = rms;
      this.opts.onMeter?.(rms, this.speaking);
    }

    // Barge-in: the mic stays live while the agent speaks.
    const decision = evaluateBargeIn(this.barge, {
      rms,
      durationMs,
      startThreshold: startEff,
      agentSpeaking: this.opts.isAgentSpeaking(),
      userSpeaking: this.speaking
    });
    this.barge = decision.state;

    if (decision.interrupt) {
      this.totalBargeInterrupts += 1;
      this.bargePhase = 'cut';
      this.opts.onDuck(false);
      this.opts.onInterrupt();
      // Normal flow continues: this chunk opens the person's turn.
    } else if (decision.duck) {
      this.totalDuckFrames += 1;
      this.bargePhase = 'listening';
      this.opts.onDuck(true);
      this.preBuffer.push({ data, durationMs });
      this.preBuffer = trimPreBuffer(this.preBuffer);
      return;
    } else if (decision.reset) {
      if (this.bargePhase !== 'idle') {
        this.bargePhase = 'idle';
        this.opts.onDuck(false);
      }
    }

    if (!this.speaking) {
      this.preBuffer.push({ data, durationMs });
      this.preBuffer = trimPreBuffer(this.preBuffer);
      // Onset confirmation: real speech holds the level for several
      // frames; a keyboard click is 1-3 frames and dies here.
      if (rms >= startEff) {
        this.onsetFrames += 1;
      } else {
        this.onsetFrames = 0;
      }
      if (this.onsetFrames >= LiveMic.ONSET_FRAMES) {
        this.onsetFrames = 0;
        this.speaking = true;
        this.silenceMs = 0;
        this.speechMs = 0;
        this.confirmed = false;
        this.turnMaxRms = 0;
        this.turnStartEff = startEff;
        this.opts.resetHint();
        this.opts.onSpeechStart();
        // Flush the pre-buffer: the attack is not lost.
        for (const buffered of this.preBuffer) {
          this.opts.onChunk(buffered.data);
        }
        this.preBuffer = [];
      }
      return;
    }

    this.opts.onChunk(data);
    this.speechMs += durationMs;
    if (rms > this.turnMaxRms) this.turnMaxRms = rms;
    // Sustained speech: the turn is real now (CONFIRM won't stop it and
    // minSpeechMs won't discard it) — notify once so the
    // interrupt cuts here and not on any cough that barely opens the VAD.
    if (!this.confirmed && this.speechMs >= CONFIRM_SPEECH_MS) {
      this.confirmed = true;
      this.opts.onSpeechConfirmed(Math.round(this.speechMs));
    }
    if (rms < contEff) {
      this.silenceMs += durationMs;
    } else {
      this.silenceMs = 0;
    }

    // Adaptive endpointing (§3a): the closing silence is decided per
    // frame from accumulated speech + hint + floor. The base (800) is identical
    // to MIC_NORMAL; it only moves with a clear signal.
    const endpointing = computeEndpointing({
      speechMs: this.speechMs,
      hintEnd: hintTail(this.opts.hintText()),
      floor: this.floor,
      maxRms: this.turnMaxRms,
      recentBarge: this.opts.recentBarge?.() ?? false
    });
    if (this.silenceMs >= endpointing.endSilenceMs) {
      this.endSpeech(this.opts.hintText());
    }
  }

  /** Single turn close (VAD, watchdog or cap): idempotent. */
  private endSpeech(hint: string): void {
    if (!this.speaking) {
      return;
    }
    this.speaking = false;
    this.silenceMs = 0;
    this.opts.onMeter?.(0, false);
    const speechMs = Math.round(this.speechMs);
    this.speechMs = 0;
    // Turn stats for telemetry (tune thresholds with real data).
    this.opts.onTurnStats?.({
      speechMs,
      maxRms: Math.round(this.turnMaxRms * 10000) / 10000,
      duckFrames: this.totalDuckFrames,
      bargeInterrupts: this.totalBargeInterrupts,
      floor: Math.round(this.floor * 10000) / 10000,
      startEff: Math.round(this.turnStartEff * 10000) / 10000
    });
    // Discard: no hint and below minSpeechMs (250) is a tiny noise (clicks die
    // at onset; short coughs here). Anything longer goes to the server and Silero decides.
    if (!hint && speechMs < this.tuning.minSpeechMs) {
      this.opts.resetHint();
      this.opts.onDiscarded();
      return;
    }
    this.opts.onSpeechEnd(hint);
  }
}

// ── Browser ASR (safety net: hint for the STT) ────────────────────────

export class BrowserSpeech {
  private recognition: any = null;
  private utterance = '';

  get supported(): boolean {
    return typeof window !== 'undefined'
      && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start(lang?: string): void {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor || this.recognition) {
      return;
    }
    try {
      this.recognition = new Ctor();
      this.recognition.lang = lang || 'en-US';
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.onresult = (event: any) => {
        let text = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          text += event.results[i][0]?.transcript || '';
        }
        if (text.trim()) {
          this.utterance = text.trim();
        }
      };
      this.recognition.onerror = () => {
        // El VAD sigue enmarcando; sin hint el servidor pide reintento.
      };
      this.recognition.onend = () => {
        // Chrome corta sesiones largas: reenganchar si seguimos en voz.
        if (this.recognition) {
          try {
            this.recognition.start();
          } catch {
            // Ya estaba corriendo.
          }
        }
      };
      this.recognition.start();
    } catch {
      this.recognition = null;
    }
  }

  stop(): void {
    const rec = this.recognition;
    this.recognition = null;
    try {
      rec?.stop();
    } catch {
      // Ya detenido.
    }
  }

  latestUtterance(): string {
    return this.utterance;
  }

  resetUtterance(): void {
    this.utterance = '';
  }
}
