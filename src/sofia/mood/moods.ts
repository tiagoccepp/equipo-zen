/**
 * Mood vocabulary and the visual mapping for each mood.
 *
 * Mood is layered on top of the four activity states (idle/listening/thinking/
 * speaking): the activity state owns MOTION (amplitude, rotation, scale), and
 * the mood owns a COLOR TINT and a glow adjustment. `neutral` has weight 0, so a
 * neutral mood leaves the avatar exactly as it was before moods existed (this is
 * the zero-regression default).
 */

export type Mood = 'neutral' | 'focused' | 'happy' | 'concerned' | 'error' | 'curious';

export const MOODS: readonly Mood[] = [
  'neutral',
  'focused',
  'happy',
  'concerned',
  'error',
  'curious',
];

export interface MoodVisual {
  /** Rim tint (hex). */
  rim: number;
  /** Core tint (hex). */
  core: number;
  /** Multiplier applied to the activity glow. */
  glowMul: number;
  /** Amplitude of a small glow shimmer (0 = steady). */
  flutter: number;
  /** How strongly the mood tint overrides the activity color (0..1). */
  weight: number;
}

export const MOOD_TABLE: Record<Mood, MoodVisual> = {
  // weight 0 => pass-through: neutral equals the pre-mood look exactly.
  neutral: { rim: 0x00f0ff, core: 0x0077ff, glowMul: 1.0, flutter: 0.0, weight: 0.0 },
  // High-contrast palette: each rim is well separated from the base cyan and from the
  // others; core is the rim at ~50% brightness (same hue, deeper companion).
  focused: { rim: 0x7c4dff, core: 0x3e2780, glowMul: 1.05, flutter: 0.0, weight: 0.45 },
  happy: { rim: 0x00e676, core: 0x00733b, glowMul: 1.2, flutter: 0.0, weight: 0.6 },
  curious: { rim: 0xe040fb, core: 0x70207e, glowMul: 1.1, flutter: 0.1, weight: 0.55 },
  concerned: { rim: 0xffab00, core: 0x805600, glowMul: 1.1, flutter: 0.15, weight: 0.6 },
  error: { rim: 0xff1744, core: 0x800c22, glowMul: 1.25, flutter: 0.35, weight: 0.7 },
};

export function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value);
}
