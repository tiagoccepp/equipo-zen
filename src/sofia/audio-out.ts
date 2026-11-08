// Salida de audio Sofia: PCM del servidor (Supertonic) y MP3 (Edge) por un
// solo canal Web Audio con medidor de nivel real para el orbe.

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export class SofiaAudioOut {
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
      this.master.gain.value = 1;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.frame = new Float32Array(this.analyser.fftSize);
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

  /** Nivel real de la voz sonando (0..1), curva de medidor. */
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
