/**
 * Eases the avatar's color/glow toward the current mood. The AvatarController
 * consumes this through the small `MoodLayer` interface: each frame it asks the
 * mood layer to tint the activity color and adjust the glow. Motion stays owned
 * by the activity state; mood only tints.
 *
 * A `neutral` mood has weight 0, so `colors()` returns the activity color
 * unchanged and `glow()` returns the activity glow unchanged: with no mood (or a
 * neutral mood) the avatar looks exactly as it did before moods existed.
 */

import { lerp, lerpHex, toRgb, packRgb } from './colorBlend';
import { MOOD_TABLE, type Mood } from './moods';

/** The view the AvatarController has of the mood layer. */
export interface MoodLayer {
  /** Advance easing/flutter. `time` is elapsed seconds. */
  tick(time: number): void;
  /** Blend an activity color toward the current mood tint. Returns [rim, core]. */
  colors(activityRim: number, activityCore: number): readonly [number, number];
  /** Adjust an activity glow by the mood glow multiplier plus flutter. */
  glow(activityGlow: number): number;
}

// Seconds for an eased value to converge after a mood change.
const EASE_SECONDS = 0.4;
// Glow shimmer rate (radians/sec) for moods with a nonzero flutter.
const FLUTTER_RATE = 9;
// Hard ceiling so glow never blows out additive blending.
const MAX_GLOW = 3.5;

export class MoodController implements MoodLayer {
  private current: Mood = 'neutral';

  // Eased state, initialised to neutral (weight 0 => pass-through). Rim/core are kept
  // as FLOAT [r,g,b] channels, NOT packed ints: easing a packed int in place stalls
  // because lerpHex rounds every step and a sub-0.5 per-frame delta rounds to zero, so
  // a small channel gap (e.g. neutral->happy green, 240->255) never closes and the mood
  // color never reaches its target (worse at high refresh rates, where the per-frame
  // step is smaller). Float channels, rounded only at output, converge correctly.
  private eRim: [number, number, number] = toRgb(MOOD_TABLE.neutral.rim);
  private eCore: [number, number, number] = toRgb(MOOD_TABLE.neutral.core);
  private eWeight = MOOD_TABLE.neutral.weight;
  private eGlowMul = MOOD_TABLE.neutral.glowMul;
  private eFlutter = MOOD_TABLE.neutral.flutter;
  private flutter = 0;
  private lastTime: number | null = null;

  get mood(): Mood {
    return this.current;
  }

  /** Set the target mood; the visuals ease toward it over ~400ms. */
  setMood(mood: Mood): void {
    this.current = mood;
  }

  tick(time: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    const a = dt <= 0 ? 0 : Math.min(1, dt / EASE_SECONDS);
    const target = MOOD_TABLE[this.current];
    // Ease each rim/core channel in float space (inlined to avoid a per-frame alloc).
    this.eRim[0] = lerp(this.eRim[0], (target.rim >> 16) & 255, a);
    this.eRim[1] = lerp(this.eRim[1], (target.rim >> 8) & 255, a);
    this.eRim[2] = lerp(this.eRim[2], target.rim & 255, a);
    this.eCore[0] = lerp(this.eCore[0], (target.core >> 16) & 255, a);
    this.eCore[1] = lerp(this.eCore[1], (target.core >> 8) & 255, a);
    this.eCore[2] = lerp(this.eCore[2], target.core & 255, a);
    this.eWeight = lerp(this.eWeight, target.weight, a);
    this.eGlowMul = lerp(this.eGlowMul, target.glowMul, a);
    // Ease the shimmer amplitude too, so it ramps in with the color/glow rather
    // than snapping to full on a mood change.
    this.eFlutter = lerp(this.eFlutter, target.flutter, a);
    this.flutter = this.eFlutter * (0.5 + 0.5 * Math.sin(time * FLUTTER_RATE));
  }

  colors(activityRim: number, activityCore: number): readonly [number, number] {
    const eRim = packRgb(this.eRim[0], this.eRim[1], this.eRim[2]);
    const eCore = packRgb(this.eCore[0], this.eCore[1], this.eCore[2]);
    return [lerpHex(activityRim, eRim, this.eWeight), lerpHex(activityCore, eCore, this.eWeight)];
  }

  glow(activityGlow: number): number {
    return Math.min(MAX_GLOW, activityGlow * this.eGlowMul + this.flutter);
  }
}
