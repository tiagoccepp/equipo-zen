// F-08: karaoke — highlights word by word in time with the audio.
// Without real timings (Piper doesn't provide them): proportional split by the
// length of each word over sDurMs. With real sTimes: they are used as-is.
// Pure and testable; the DOM is handled by app.ts.

export const KARAOKE_FALLBACK_MS_PER_WORD = 400;
export const KARAOKE_MIN_MS_PER_WORD = 120;

export interface KaraokeCue {
  words: string[];
  starts: number[]; // ms de inicio por palabra
  durMs: number;
}

/** Arma cues: sTimes reales > reparto proporcional > fallback 400ms/palabra. */
export function buildCues(text: string, opts: { durMs?: number; sTimes?: number[] } = {}): KaraokeCue {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { words: [], starts: [], durMs: 0 };
  }
  const real = Array.isArray(opts.sTimes) ? opts.sTimes.filter((n) => Number.isFinite(n)) : [];
  if (real.length === words.length) {
    // sTimes = ms de inicio por palabra (alineaciones reales).
    const starts = real.map((n) => Math.max(0, Math.round(n)));
    const durMs = Math.max(...starts) + KARAOKE_MIN_MS_PER_WORD;
    return { words, starts, durMs };
  }
  const total = Number.isFinite(opts.durMs) && (opts.durMs as number) > 0
    ? Math.round(opts.durMs as number)
    : words.length * KARAOKE_FALLBACK_MS_PER_WORD;
  // Proportional share by length (longer ones take longer to say).
  const weights = words.map((w) => Math.max(2, w.length));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const starts: number[] = [];
  let acc = 0;
  for (const w of weights) {
    starts.push(Math.round(acc));
    acc += (w / wSum) * total;
  }
  return { words, starts, durMs: total };
}

/** Active word index at `elapsedMs` (-1 = none, e.g. finished). */
export function activeWord(cue: KaraokeCue, elapsedMs: number): number {
  if (cue.words.length === 0 || elapsedMs < 0) {
    return -1;
  }
  let idx = -1;
  for (let i = 0; i < cue.starts.length; i += 1) {
    if (elapsedMs >= cue.starts[i]) {
      idx = i;
    } else {
      break;
    }
  }
  if (elapsedMs > cue.durMs + 500) {
    return -1; // finished a while ago: release the highlight
  }
  return idx;
}
