// Voz Pablo: loop dinámico upstream (VAD continuo + barge-in + ducking).
// Salida: PCM/MP3 con AnalyserNode real. Entrada: mic continuo con VAD
// local, pre-buffer, hints ASR-navegador y barge-in (barge-in.ts verbatim).

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
  levelAvailable = false;

  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: Float32Array<ArrayBuffer> | null = null;
  private active = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  // TF fluidez: cadena de reproducción en orden de llegada. Sin esto, dos
  // MP3 seguidos se decodifican en paralelo y el más corto se agenda
  // primero (orden roto + baches). Todo decode+schedule pasa por acá.
  private playChain: Promise<void> = Promise.resolve();
  // Época anti-stale: flush() (barge-in) la avanza y lo que ya estaba
  // encolado/decodificando se descarta en vez de sonar tarde.
  private epoch = 0;

  private ensure(): AudioContext {
    if (this.context && this.context.state !== 'closed') {
      return this.context;
    }
    const ctx = new AudioContext();
    this.master = ctx.createGain();
    // Analizador DESPUÉS del gain: el ducking también aplaca la UI.
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

  enqueuePcm(base64: string, sampleRate: number): Promise<void> {
    const at = this.epoch;
    this.playChain = this.playChain
      .then(() => {
        if (at === this.epoch) return this.enqueuePcmNow(base64, sampleRate, at);
      })
      .catch(() => {});
    return this.playChain;
  }

  private async enqueuePcmNow(base64: string, sampleRate: number, at: number): Promise<void> {
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
    if (at !== this.epoch) return; // flush() en el medio: descartar.
    this.schedule(buffer);
  }

  playMp3(base64: string): Promise<void> {
    const at = this.epoch;
    this.playChain = this.playChain
      .then(() => {
        if (at === this.epoch) return this.playMp3Now(base64, at);
      })
      .catch(() => {});
    return this.playChain;
  }

  private async playMp3Now(base64: string, at: number): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const bytes = base64ToBytes(base64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buffer = await ctx.decodeAudioData(copy.buffer);
    if (at !== this.epoch) return; // flush() en el medio: descartar.
    this.schedule(buffer);
  }

  private schedule(buffer: AudioBuffer): void {
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
  }

  get playing(): boolean {
    return this.active.size > 0;
  }

  get isPlaying(): boolean {
    return this.active.size > 0;
  }

  /** Amplitud REAL (0..1). Curva medida del TTS: voz 0.03-0.06, énfasis 0.09. */
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

  /** Corta TODO sin cerrar el contexto (barge-in). No dispara onDrained. */
  flush(): void {
    for (const source of this.active) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Ya detenido.
      }
    }
    this.active.clear();
    this.epoch += 1; // lo encolado/decodificando queda stale y se descarta.
    if (this.context) {
      this.nextStart = this.context.currentTime;
    }
  }

  duck(): void {
    // Duck suave (0.5, no 0.2) y transiciones lentas: el duck profundo y
    // rápido se escuchaba como si Pablo se alejara y acercara al micrófono
    // cada vez que el ambiente rozaba el umbral.
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
  // Fase 1 (§3a): los completa app.ts al resolver la gracia, cuando ya
  // se sabe si el habla se reabrió dentro de la ventana.
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
  // Endpointing adaptativo (§3a): ¿hubo barge/interrupt en los últimos
  // 2 turnos? Lo lleva app.ts (ve los dos caminos de corte). Sin esto,
  // el VAD asume que no (default conservador).
  recentBarge?: () => boolean;
}

export interface MicTuning {
  sensitivity: number;
  endSilenceMs: number;
  // Puerta de descarte: bajo esto y sin hint el turno se tira como ruido.
  // 250 ms porque una sílaba ("sí", "no", "dale": 200-400 ms acústicos)
  // menos el onset (4 frames × 30 ms = 120 ms) cuenta 150-300 ms; con 600
  // el desktop (sin Web Speech API → sin hint) era sordo a toda respuesta
  // corta. El juez real del ruido es Silero en el servidor (~12 ms medidos),
  // esto solo evita viajes inútiles. NO confundir con CONFIRM_SPEECH_MS.
  minSpeechMs: number;
}

export const MIC_NORMAL: MicTuning = { sensitivity: 55, endSilenceMs: 800, minSpeechMs: 250 };

// Habla sostenida para confirmar (cortar al agente / dar el turno por real).
// Queda en 600: una tos (150-250 ms) jamás debe interrumpir. Desacoplado de
// minSpeechMs (09/11: descarte 600→250) para no abrir cortes fantasma.
export const CONFIRM_SPEECH_MS = 600;

// ── Endpointing adaptativo (§3a) ────────────────────────────────────
// Decisión pura y testeable: cuánto silencio cierra el habla y cuánta
// gracia espera después, según lo que se lleva escuchado del turno.
// Base 800/1000 (endSilence histórico; gracia recortada de 1200 el 09/11
// tras medir que la espera VAD+gracia era el 85% del stop→transcript).
// Solo se mueve el umbral cuando la señal es clara. Ante la duda, no cortar.

export const END_SILENCE_BASE_MS = 800;
export const END_SILENCE_FAST_MS = 575;
// Lento 1100→900 (09/11): la gracia con reapertura ya protege los cortes,
// y 900+1000=1900 ms de pausa tolerada sigue 3× sobre la pausa fluida
// (<600 ms). Ahorra 200 ms en cada turno corto, que es el caso común.
export const END_SILENCE_SLOW_MS = 900;
// Gracia 1200→1000 (09/11): mismo argumento (medido: 85% del stop→transcript
// era espera VAD+gracia, no STT). app.ts la consume vía computeEndpointing;
// su fallback local GRACE_MS quedó alineado a 1000 en el ship.
export const GRACE_BASE_MS = 1000;
export const GRACE_FAST_MS = 600;

// Habla clara para acortar: RMS muy por encima del piso y con nivel mínimo.
const FAST_MIN_SNR = 3;
const FAST_MIN_MAX_RMS = 0.05;
const FAST_MAX_FLOOR = 0.025;
// Piso alto: el silencio medido es poco fiable, no se acorta nada.
const FLOOR_HIGH = 0.03;
// Palabras de cierre: la frase ya está completa aunque no haya punto.
const CLOSING_WORDS = new Set(['gracias', 'chau', 'dale']);
// Funcionales: la frase está a medio armar, seguro sigue.
const FUNCTION_WORDS = new Set(['el', 'la', 'de', 'que', 'y', 'para', 'un']);

/** Últimos 20 chars del hint: telemetría compacta para calibrar. */
export function hintTail(hint: string): string {
  return hint.slice(-20);
}

// Normaliza para comparar palabras (el ASR a veces manda "si" sin tilde).
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

/** ¿El hint suena a frase terminada? Punto/signo, cierre o sí-no aislado. */
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
  // sí/no aislado: el turno entero es la respuesta.
  return words.length === 1 && (last === 'si' || last === 'no');
}

/** ¿El hint quedó en palabra funcional? La frase sigue, no cortar. */
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
 * Umbrales de cierre para el turno en curso. Rápido solo cuando TODO
 * acompaña (turno largo + frase completa + habla clara); lento ante
 * cualquier duda (turno corto, frase a medias, cortes recientes o ruido).
 */
export function computeEndpointing(input: EndpointingInput): EndpointingDecision {
  const { speechMs, hintEnd, floor, maxRms, recentBarge } = input;
  const terminal = isTerminalHint(hintEnd);
  const longTurn = speechMs > 2500;

  // Lento gana: ante la duda, no cortar.
  const slow = speechMs < 1500
    || endsFunctional(hintEnd)
    || recentBarge
    || floor >= FLOOR_HIGH;
  if (slow) {
    return { endSilenceMs: END_SILENCE_SLOW_MS, graceMs: GRACE_BASE_MS };
  }

  // Rápido solo con habla clara además de frase completa + turno largo.
  const clearSpeech = floor <= FAST_MAX_FLOOR
    && maxRms >= FAST_MIN_MAX_RMS
    && maxRms >= floor * FAST_MIN_SNR;
  if (longTurn && terminal && clearSpeech) {
    return { endSilenceMs: END_SILENCE_FAST_MS, graceMs: GRACE_FAST_MS };
  }
  // Gracia corta con frase completa + turno largo aunque el audio no sea
  // nítido: el VAD ya cerró, solo se acorta la espera posterior.
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
 * Micrófono continuo upstream: queda prendido; el VAD abre/cierra turnos
 * por RMS. Mientras un agente habla, cada frame pasa por el barge-in:
 * duck reversible → interrupt confirmado. Pre-buffer de 640 ms para que
 * la frase que corta llegue entera.
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

  /** Vuelve el barge-in a reposo (el orbe usa bargePhase para la energía). */
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
        // Sin gesto previo; igual seguimos.
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
    // Watchdog: si los frames se cortan (o el turno se eterniza) hablando,
    // se fuerza el cierre. Sin esto, WebKit trabado = "grabando" eterno.
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
    // RMS normalizado (misma escala que el worklet upstream).
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    const rms = pcm.length > 0 ? Math.sqrt(sum / pcm.length) : 0;
    this.lastFrameAt = performance.now();
    // Piso de ruido adaptativo: arranque rápido (20 frames) + seguimiento
    // lento del ambiente mientras no hay habla ni agente sonando. Sin esto,
    // el autoGain del mic y los cambios de ambiente dejaban el umbral
    // clavado y cualquier ruido cortaba al agente.
    if (!this.speaking && !this.opts.isAgentSpeaking()) {
      if (this.calib.length < 20) {
        this.calib.push(rms);
        if (this.calib.length === 20) {
          const sorted = [...this.calib].sort((a, b) => a - b);
          // Tope: si el usuario habló durante la calibración, no arruinar el próximo turno.
          this.floor = Math.min(sorted[17] * 2.2, 0.04);
        }
      } else {
        // Seguidor lento (tau ~6s): sube y baja con el ambiente real.
        this.floor = Math.min(0.04, Math.max(0, this.floor + (rms - this.floor) * 0.01));
      }
    }
    const durationMs = (pcm.length / 16000) * 1000;
    // Base64 del PCM crudo.
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const data = btoa(bin);

    const { start, cont } = thresholds(this.tuning.sensitivity);
    // El piso ambiente manda si supera al umbral teórico (mic ruidoso).
    const contEff = Math.max(cont, this.floor);
    const startEff = Math.max(start, this.floor * 1.4);
    const now = performance.now();
    if (now - this.lastMeterAt > 180) {
      this.lastMeterAt = now;
      this.level = rms;
      this.opts.onMeter?.(rms, this.speaking);
    }

    // Barge-in: el mic sigue vivo mientras el agente habla.
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
      // Sigue el flujo normal: este chunk abre el turno de la persona.
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
      // Confirmación de arranque: el habla real sostiene el nivel varios
      // frames; un click de teclado es 1-3 frames y muere acá.
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
        // Flush del pre-buffer: no se pierde el ataque.
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
    // Habla sostenida: el turno ya es real (CONFIRM no lo va a frenar y
    // minSpeechMs no lo va a descartar) — avisar una vez para que el
    // interrupt corte acá y no con cualquier tos que apenas abre el VAD.
    if (!this.confirmed && this.speechMs >= CONFIRM_SPEECH_MS) {
      this.confirmed = true;
      this.opts.onSpeechConfirmed(Math.round(this.speechMs));
    }
    if (rms < contEff) {
      this.silenceMs += durationMs;
    } else {
      this.silenceMs = 0;
    }

    // Endpointing adaptativo (§3a): el silencio que cierra se decide por
    // frame según habla acumulada + hint + piso. La base (800) es idéntica
    // a MIC_NORMAL; solo se mueve con señal clara.
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

  /** Cierre único del turno (VAD, watchdog o tope): idempotente. */
  private endSpeech(hint: string): void {
    if (!this.speaking) {
      return;
    }
    this.speaking = false;
    this.silenceMs = 0;
    this.opts.onMeter?.(0, false);
    const speechMs = Math.round(this.speechMs);
    this.speechMs = 0;
    // Stats del turno para telemetría (afinar umbrales con datos reales).
    this.opts.onTurnStats?.({
      speechMs,
      maxRms: Math.round(this.turnMaxRms * 10000) / 10000,
      duckFrames: this.totalDuckFrames,
      bargeInterrupts: this.totalBargeInterrupts,
      floor: Math.round(this.floor * 10000) / 10000,
      startEff: Math.round(this.turnStartEff * 10000) / 10000
    });
    // Descarte: sin hint y bajo minSpeechMs (250) es un ruidito (clicks mueren
    // en el onset; toses cortas acá). Lo más largo va al servidor y decide Silero.
    if (!hint && speechMs < this.tuning.minSpeechMs) {
      this.opts.resetHint();
      this.opts.onDiscarded();
      return;
    }
    this.opts.onSpeechEnd(hint);
  }
}

// ── ASR del navegador (red de seguridad: hint para el STT) ────────────

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
