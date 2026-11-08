// Voz Sofia: salida (PCM Supertonic / MP3 Edge con nivel real) + PTT mic
// (getUserMedia + pcm-worklet 16k, de lyns-voice MIT).

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

  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(1024 * 4));
  private active = new Set<AudioBufferSourceNode>();
  private nextStart = 0;

  private ensure(): AudioContext {
    if (!this.context) {
      const ctx = new AudioContext();
      this.master = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.frame = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.master.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.context = ctx;
    }
    return this.context;
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

  /** Nivel real de la voz sonando (0..1). */
  level(): number {
    if (!this.analyser || this.active.size === 0) {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.frame);
    let sum = 0;
    for (let i = 0; i < this.frame.length; i += 1) {
      sum += this.frame[i] * this.frame[i];
    }
    const rms = Math.sqrt(sum / this.frame.length);
    return Math.min(1, Math.pow(rms / 0.09, 0.7));
  }

  stop(): void {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // Ya terminó.
      }
    }
    this.active.clear();
    if (this.context) {
      this.nextStart = this.context.currentTime;
    }
  }
}

export interface PttOptions {
  onFrame: (base64: string) => void;
  onLevel?: (level: number) => void;
}

/** Push-to-talk mínimo: mic → PCM 16k mono → onFrame (base64). */
export class PttMic {
  level = 0;
  private opts: PttOptions;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private raf = 0;
  private starting: Promise<boolean> | null = null;

  constructor(options: PttOptions) {
    this.opts = options;
  }

  get active(): boolean {
    return this.stream !== null;
  }

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

  private async startInner(): Promise<boolean> {
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
        // Sin gesto previo no arranca; igual seguimos.
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    this.buf = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    const worklet = new AudioWorkletNode(ctx, 'pcm-16k', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit'
    });
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(e.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      this.opts.onFrame(btoa(bin));
    };
    source.connect(worklet);
    this.ctx = ctx;
    this.stream = stream;
    this.worklet = worklet;
    this.analyser = analyser;
    const loop = () => {
      if (!this.stream || !this.analyser) return;
      this.raf = requestAnimationFrame(loop);
      this.analyser.getByteFrequencyData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i += 1) {
        sum += this.buf[i] * this.buf[i];
      }
      this.level = Math.min(1, Math.sqrt(sum / this.buf.length) / 90);
      this.opts.onLevel?.(this.level);
    };
    loop();
    return true;
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
    this.level = 0;
    this.opts.onLevel?.(0);
  }
}
