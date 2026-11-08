import { perlin3 } from './noise';

/**
 * Parameters controlling the per-vertex displacement. The avatar state machine
 * (Phase 3) animates `amplitude`/`frequency`/`speed` to express idle breathing,
 * listening compression, thinking turbulence, and speaking impulses.
 */
export interface DeformationParams {
  /** Peak displacement along the vertex normal (world units). */
  amplitude: number;
  /** Spatial noise frequency (higher = more, smaller ripples). */
  frequency: number;
  /** Time evolution speed of the noise field. */
  speed: number;
}

// Two octaves with weights 1 + 0.5; normalise so the summed noise stays in
// [-1, 1] and the final displacement is bounded by |amplitude|.
const OCTAVE_NORM = 1 / 1.5;

/**
 * Signed displacement for a rest-position vertex at a given time.
 *
 * Pure and deterministic. Guarantees:
 *  - `amplitude === 0` returns exactly 0 (true idle freeze).
 *  - result is bounded within [-amplitude, amplitude].
 *  - continuous in space and time (inherited from Perlin noise).
 */
export function displacement(
  x: number,
  y: number,
  z: number,
  time: number,
  params: DeformationParams,
): number {
  if (params.amplitude === 0) {
    return 0;
  }
  const f = params.frequency;
  const t = time * params.speed;
  const octave1 = perlin3(x * f + t, y * f + t, z * f + t);
  const octave2 = 0.5 * perlin3(x * f * 2 - t, y * f * 2 - t, z * f * 2 - t);
  return params.amplitude * (octave1 + octave2) * OCTAVE_NORM;
}
