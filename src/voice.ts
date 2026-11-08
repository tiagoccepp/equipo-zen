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

  async enqueuePcm(base64: string, sampleRate: number): Promise<void> {
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
    this.schedule(buffer);
  }

  async playMp3(base64: string): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const bytes = base64ToBytes(base64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const buffer = await ctx.decodeAudioData(copy.buffer);
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
    if (this.context) {
      this.nextStart = this.context.currentTime;
    }
  }

  duck(): void {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(0.2, this.context.currentTime, 0.03);
    }
  }

  restoreGain(): void {
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(1, this.context.currentTime, 0.05);
    }
  }

  stop(): void {
    this.flush();
    void this.context?.suspend();
  }
}

// ── VAD continuo + barge-in ───────────────────────────────────────────

export interface LiveMicOptions {
  onChunk: (base64: string) => void;
  onSpeechStart: () => void;
  onSpeechConfirmed: () => void;
  onSpeechEnd: (hint: string) => void;
  onDiscarded: () => void;
  onInterrupt: () => void;
  onDuck: (ducked: boolean) => void;
  onMeter?: (level: number, speaking: boolean) => void;
  onState?: (label: string) => void;
  isAgentSpeaking: () => boolean;
  hintText: () => string;
  resetHint: () => void;
}

export interface MicTuning {
  sensitivity: number;
  endSilenceMs: number;
  minSpeechMs: number;
}

export const MIC_NORMAL: MicTuning = { sensitivity: 55, endSilenceMs: 800, minSpeechMs: 600 };

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
    // Calibración de piso de ruido: primeros 40 frames (~2.4s) sin habla.
    if (!this.speaking && this.calib.length < 40) {
      this.calib.push(rms);
      if (this.calib.length === 40) {
        const sorted = [...this.calib].sort((a, b) => a - b);
        // Tope: si el usuario habló durante la calibración, no arruinar el próximo turno.
        this.floor = Math.min(sorted[35] * 2.2, 0.04);
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
      this.bargePhase = 'cut';
      this.opts.onDuck(false);
      this.opts.onInterrupt();
      // Sigue el flujo normal: este chunk abre el turno de la persona.
    } else if (decision.duck) {
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
    // Habla sostenida: el turno ya es real (minSpeechMs no lo va a
    // descartar) — avisar una vez para que el interrupt corte acá y no
    // con cualquier tos que apenas abre el VAD.
    if (!this.confirmed && this.speechMs >= this.tuning.minSpeechMs) {
      this.confirmed = true;
      this.opts.onSpeechConfirmed();
    }
    if (rms < contEff) {
      this.silenceMs += durationMs;
    } else {
      this.silenceMs = 0;
    }

    if (this.silenceMs >= this.tuning.endSilenceMs) {
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
      this.recognition.lang = lang || 'es-ES';
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
