/**
 * Collapse an FFT magnitude buffer into a few log-spaced frequency bands,
 * normalized to [0, 1]. Log spacing matches human pitch perception: the low
 * bands (bass) get finer resolution than the highs, so a linear split does not
 * waste most bands on inaudible treble.
 *
 * Pure and unit-tested. The avatar uses bass to drive amplitude/compression and
 * treble to add a glow shimmer, a richer Listening reaction than a single mean.
 */

/** Exponential edge position in [0, n] for fraction `b / bandCount`. */
function edge(b: number, bandCount: number, n: number): number {
  return Math.pow(n + 1, b / bandCount) - 1;
}

export function computeBands(data: Uint8Array, bandCount: number, out?: Float32Array): Float32Array {
  const count = Math.max(0, Math.floor(bandCount));
  // Reuse the caller's buffer when it fits (avoids a per-frame allocation in the
  // listening loop); otherwise allocate.
  const result = out?.length === count ? out : new Float32Array(count);
  const n = data.length;
  if (count === 0 || n === 0) {
    result.fill(0);
    return result;
  }
  for (let b = 0; b < count; b += 1) {
    const lo = Math.min(n - 1, Math.floor(edge(b, count, n)));
    const hi = Math.min(n, Math.max(lo + 1, Math.floor(edge(b + 1, count, n))));
    let sum = 0;
    let bins = 0;
    for (let i = lo; i < hi; i += 1) {
      sum += data[i];
      bins += 1;
    }
    result[b] = bins > 0 ? sum / bins / 255 : 0;
  }
  return result;
}
