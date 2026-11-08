/**
 * Pure color/scalar blending helpers for the mood layer. Colors are plain hex
 * integers blended channel-wise in legacy (non-sRGB) RGB to match the r128
 * color space the avatar already renders in.
 */

export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Linear interpolation between two scalars (t clamped to [0, 1]). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Split a hex color into its [r, g, b] channels (0..255). */
export function toRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/** Pack [r, g, b] (floats allowed) into a hex color, rounding each channel. */
export function packRgb(r: number, g: number, b: number): number {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** Channel-wise linear interpolation between two hex colors (t clamped). */
export function lerpHex(a: number, b: number, t: number): number {
  const u = clamp01(t);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * u);
  const g = Math.round(ag + (bg - ag) * u);
  const bl = Math.round(ab + (bb - ab) * u);
  return (r << 16) | (g << 8) | bl;
}
