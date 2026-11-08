/**
 * Central configuration substrate. Every value here reproduces the avatar's
 * historical hard-coded behaviour exactly, so `DEFAULT_CONFIG` is a no-op change
 * by itself. Later phases read these knobs (skin, theme, glow mode, mood source,
 * feature flags) to customise the avatar without touching the render/state code.
 *
 * Forward-looking fields (skin/glowMode/features/moodSource/headUrl/amplitudeScale)
 * default to today's behaviour: orb skin, fresnel glow, no bloom, tag-based mood.
 */

export type Skin = 'orb' | 'head' | 'reactor';
export type GlowMode = 'fresnel' | 'halo' | 'bloom';
export type MoodSource = 'tag' | 'api' | 'off';

export interface MeshConfig {
  radius: number;
  detail: number;
}

export interface BreathingConfig {
  amplitude: number;
  frequency: number;
  speed: number;
}

export interface RotationConfig {
  idle: number;
  listening: number;
  thinking: number;
  speaking: number;
}

export interface TimingConfig {
  /** Seconds for a speaking impulse to decay back to rest. */
  impulseDecaySeconds: number;
  /** Thinking pulse rate (radians/sec). */
  thinkingPulseRate: number;
}

export interface PaletteConfig {
  idleRim: number;
  idleCore: number;
  neonRim: number;
  listeningCore: number;
  thinkingRim: number;
  thinkingCore: number;
  speakingCore: number;
}

export interface FeatureFlags {
  /** Post-processing bloom (gated by Spike A; off until confirmed in a browser). */
  bloom: boolean;
  /** Audio-reactive vertex warp in the shader (cosmetic amplifier). */
  shaderWarp: boolean;
}

export interface AvatarConfig {
  /** Which mesh form to render. Default 'reactor' (the arc-reactor core); 'head' and 'orb' remain selectable. */
  skin: Skin;
  /** Named palette variant. */
  theme: string;
  mesh: MeshConfig;
  idle: BreathingConfig;
  rotation: RotationConfig;
  timing: TimingConfig;
  palette: PaletteConfig;
  glowMode: GlowMode;
  /** Scales head breathing displacement so a head pulses without looking melty. */
  amplitudeScale: number;
  features: FeatureFlags;
  moodSource: MoodSource;
  /** Whether an API key is configured. The key itself is NEVER stored here. */
  apiKeyPresent: boolean;
  /** Relative URL of the head GLB, served next to the bundle. */
  headUrl: string;
}

export const DEFAULT_CONFIG: AvatarConfig = {
  skin: 'reactor',
  theme: 'q',
  mesh: { radius: 1.2, detail: 3 },
  idle: { amplitude: 0.12, frequency: 1.1, speed: 0.5 },
  rotation: { idle: 0.15, listening: 0.1, thinking: 0.6, speaking: 0.2 },
  timing: { impulseDecaySeconds: 0.32, thinkingPulseRate: 7.5 },
  palette: {
    idleRim: 0x3a5f8f,
    idleCore: 0x0a1530,
    neonRim: 0x00f0ff,
    listeningCore: 0x0077ff,
    thinkingRim: 0x33e0ff,
    thinkingCore: 0x0088ff,
    speakingCore: 0x00a0ff,
  },
  glowMode: 'fresnel',
  amplitudeScale: 1,
  features: { bloom: false, shaderWarp: false },
  moodSource: 'tag',
  apiKeyPresent: false,
  headUrl: 'head.glb',
};

export type ThemeName = 'cyan' | 'aurora' | 'ember';

export const THEME_PALETTES: Record<ThemeName, PaletteConfig> = {
  cyan: {
    idleRim: 0x3a5f8f,
    idleCore: 0x0a1530,
    neonRim: 0x00f0ff,
    listeningCore: 0x0077ff,
    thinkingRim: 0x33e0ff,
    thinkingCore: 0x0088ff,
    speakingCore: 0x00a0ff,
  },
  aurora: {
    idleRim: 0x3a8f5f,
    idleCore: 0x0a2818,
    neonRim: 0x00ffaa,
    listeningCore: 0x00cc77,
    thinkingRim: 0x33ffb8,
    thinkingCore: 0x00dd88,
    speakingCore: 0x00eea0,
  },
  ember: {
    idleRim: 0x8f5f3a,
    idleCore: 0x281408,
    neonRim: 0xff8800,
    listeningCore: 0xff6600,
    thinkingRim: 0xffaa33,
    thinkingCore: 0xff7700,
    speakingCore: 0xff9900,
  },
};

/** Deep clone so callers can mutate a config without touching the defaults. */
export function cloneConfig(config: AvatarConfig): AvatarConfig {
  return {
    ...config,
    mesh: { ...config.mesh },
    idle: { ...config.idle },
    rotation: { ...config.rotation },
    timing: { ...config.timing },
    palette: { ...config.palette },
    features: { ...config.features },
  };
}
