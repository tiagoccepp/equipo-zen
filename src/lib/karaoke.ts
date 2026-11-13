// F-08: karaoke — resalta palabra por palabra al ritmo del audio.
// Sin timings reales (Piper no los da): reparto proporcional al largo de
// cada palabra sobre sDurMs. Con sTimes reales: se usan tal cual.
// Puro y testeable; el DOM lo maneja app.ts.

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
  // Reparto proporcional al largo (las largas suenan más).
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

/** Índice de palabra activa a `elapsedMs` (-1 = ninguna, p.ej. terminado). */
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
    return -1; // terminó hace rato: soltar el resaltado
  }
  return idx;
}
