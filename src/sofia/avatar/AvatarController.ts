import { IDLE_PARAMS } from './Avatar';
import { DEFAULT_CONFIG, type AvatarConfig, type PaletteConfig } from '../config/config';
import type { MoodLayer } from '../mood/MoodController';
import type { DeformationParams } from './deformation';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Minimal surface the controller drives. The real `Avatar` satisfies this
 * structurally, and tests pass a lightweight fake so the state logic can be
 * verified without WebGL.
 */
export interface ControllableAvatar {
  setParams(next: Partial<DeformationParams>): void;
  setGlow(value: number): void;
  setColors(rim: number, core: number): void;
  idleRotationSpeed: number;
  readonly mesh: {
    rotation: { x: number; y: number; z: number };
    scale: { set(x: number, y: number, z: number): void };
  };
}

export interface AvatarControllerOptions {
  avatar: ControllableAvatar;
  onStateChange?: (state: AvatarState) => void;
  /** Tunable palette/timing/rotation. Defaults to today's exact values. */
  config?: AvatarConfig;
  /**
   * Optional mood layer. Activity drives motion; the mood layer tints color and
   * adjusts glow. Without it (or with a neutral mood) behaviour is unchanged.
   */
  moodProvider?: MoodLayer;
}

/**
 * Translates the four behavioural states (AVATAR_SPEC section 4) into live
 * avatar parameters every frame:
 *
 *  - idle:      slow ambient breathing + rotation, baseline glow
 *  - listening: amplitude/compression driven by live mic level
 *  - thinking:  rapid pulsing + fast orbital rotation
 *  - speaking:  word-boundary impulses + intense bright-blue glow
 */
export class AvatarController {
  private readonly avatar: ControllableAvatar;
  private readonly onStateChange?: (state: AvatarState) => void;
  private readonly config: AvatarConfig;
  private readonly mood: MoodLayer | undefined;

  private state: AvatarState = 'idle';
  private micLevel = 0;
  private micBands: Float32Array | null = null;
  private impulse = 0;
  private lastTime: number | null = null;

  constructor(options: AvatarControllerOptions) {
    this.avatar = options.avatar;
    this.onStateChange = options.onStateChange;
    this.config = options.config ?? DEFAULT_CONFIG;
    this.mood = options.moodProvider;
  }

  /** Apply colors through the mood layer (pass-through when no mood is set). */
  private emitColors(rim: number, core: number): void {
    if (this.mood) {
      const [moodRim, moodCore] = this.mood.colors(rim, core);
      this.avatar.setColors(moodRim, moodCore);
    } else {
      this.avatar.setColors(rim, core);
    }
  }

  /** Apply glow through the mood layer (pass-through when no mood is set). */
  private emitGlow(value: number): void {
    this.avatar.setGlow(this.mood ? this.mood.glow(value) : value);
  }

  get current(): AvatarState {
    return this.state;
  }

  setState(state: AvatarState): void {
    if (state === this.state) {
      return;
    }
    this.state = state;
    if (state !== 'speaking') {
      this.impulse = 0;
    }
    if (state !== 'listening') {
      this.micBands = null;
    }
    this.onStateChange?.(state);
  }

  /** Swap the color palette at runtime (theme switching). */
  setPalette(palette: PaletteConfig): void {
    const p = this.config.palette;
    p.idleRim = palette.idleRim;
    p.idleCore = palette.idleCore;
    p.neonRim = palette.neonRim;
    p.listeningCore = palette.listeningCore;
    p.thinkingRim = palette.thinkingRim;
    p.thinkingCore = palette.thinkingCore;
    p.speakingCore = palette.speakingCore;
  }

  /** Live microphone level in [0, 1], fed by the mic analyser. */
  setMicLevel(level: number): void {
    this.micLevel = clamp01(level);
  }

  /** Live log-spaced frequency bands in [0, 1], fed by the mic analyser. */
  setMicBands(bands: Float32Array): void {
    this.micBands = bands.length > 0 ? bands : null;
  }

  /** Register a speech word-boundary impulse (or synthetic envelope tick). */
  pulse(strength = 1): void {
    this.impulse = Math.min(1, this.impulse + clamp01(strength));
  }

  /** Per-frame update; `time` is elapsed seconds. */
  tick(time: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.impulse = Math.max(0, this.impulse - dt / this.config.timing.impulseDecaySeconds);
    this.mood?.tick(time);

    switch (this.state) {
      case 'idle':
        this.applyIdle();
        break;
      case 'listening':
        this.applyListening();
        break;
      case 'thinking':
        this.applyThinking(time);
        break;
      case 'speaking':
        this.applySpeaking();
        break;
    }
  }

  private applyIdle(): void {
    const { palette, rotation } = this.config;
    this.avatar.setParams(IDLE_PARAMS);
    this.emitGlow(1.0);
    this.emitColors(palette.idleRim, palette.idleCore);
    this.avatar.idleRotationSpeed = rotation.idle;
    this.avatar.mesh.rotation.x = 0;
    this.avatar.mesh.scale.set(1, 1, 1);
  }

  private applyListening(): void {
    const { palette, rotation } = this.config;
    const bands = this.micBands;
    // Bass drives amplitude/compression; treble adds frequency detail + glow
    // shimmer. With no bands the behaviour is byte-identical to the level-only
    // version (bass = level, treble = 0).
    const bass = bands ? bands[0] : this.micLevel;
    const treble = bands ? (bands.at(-1) ?? 0) : 0;
    this.avatar.setParams({ amplitude: 0.05 + bass * 0.5, frequency: 1.4 + treble * 0.6, speed: 0.9 });
    this.emitGlow(1.2 + bass * 0.8 + treble * 0.3);
    this.emitColors(palette.neonRim, palette.listeningCore);
    this.avatar.idleRotationSpeed = rotation.listening;
    this.avatar.mesh.rotation.x = 0;
    // Vertical compression conveys live audio feedback (spec: "compresses vertically").
    this.avatar.mesh.scale.set(1, 1 - bass * 0.35, 1);
  }

  private applyThinking(time: number): void {
    const { palette, rotation, timing } = this.config;
    const pulse = 0.5 + 0.5 * Math.sin(time * timing.thinkingPulseRate);
    this.avatar.setParams({ amplitude: 0.1 + pulse * 0.25, frequency: 2.0, speed: 2.5 });
    this.emitGlow(1.3 + pulse * 0.6);
    this.emitColors(palette.thinkingRim, palette.thinkingCore);
    this.avatar.idleRotationSpeed = rotation.thinking;
    // Orbital wobble around X for the "circular pattern".
    this.avatar.mesh.rotation.x = Math.sin(time * 1.5) * 0.4;
    this.avatar.mesh.scale.set(1, 1, 1);
  }

  private applySpeaking(): void {
    const { palette, rotation } = this.config;
    const impulse = this.impulse;
    this.avatar.setParams({ amplitude: 0.12 + impulse * 0.6, frequency: 1.7, speed: 1.2 });
    // Intense bright-blue glow that spikes on each word.
    this.emitGlow(1.8 + impulse * 1.2);
    this.emitColors(palette.neonRim, palette.speakingCore);
    this.avatar.idleRotationSpeed = rotation.speaking;
    this.avatar.mesh.rotation.x = 0;
    const pop = 1 + impulse * 0.1;
    this.avatar.mesh.scale.set(pop, pop, pop);
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
