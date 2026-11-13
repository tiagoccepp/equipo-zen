// QW-07: progressive heard-text — the agent's text is revealed in time with
// the audio that plays, never earlier (no spoilers). Each audio chunk arrives
// tagged with sIdx (sentence index); the first chunk of each sentence also
// carries sText. Without audio (text mode / voice off) everything shows at once,
// same as before.

export interface AudioTag {
  turnId: string;
  agentId: string;
  sIdx: number;
  sText?: string;
  // F-08: karaoke — estimated duration (ms) + real timings when available.
  sDurMs?: number;
  sTimes?: number[];
}

/** Reveal state for a turn: observed sentences + how far it has been shown. */
export class HeardTurn {
  private sentences = new Map<number, string>();
  private revealedUpTo = -1;
  private ended = false;

  /** A chunk with sIdx started playing → newly-revealed texts, in order. */
  observe(tag: AudioTag): string[] {
    if (this.ended) return [];
    const idx = Math.max(0, Math.floor(Number(tag.sIdx) || 0));
    if (typeof tag.sText === 'string' && tag.sText.trim()) {
      this.sentences.set(idx, tag.sText);
    }
    const fresh: string[] = [];
    // Rule ≤: if a sentence had no audio of its own (silent), it is revealed
    // together with the next audible one — never leaves a gap.
    for (let i = this.revealedUpTo + 1; i <= idx; i += 1) {
      const text = this.sentences.get(i);
      if (text !== undefined) {
        fresh.push(text);
      }
      this.revealedUpTo = i;
    }
    return fresh;
  }

  /** Has anything been revealed yet? (decides if the turn uses progressive mode). */
  get progressive(): boolean {
    return this.revealedUpTo >= 0;
  }

  /** Cierre: devuelve el texto completo a mostrar (re-render final). */
  finalize(full: string): string {
    this.ended = true;
    return full;
  }

  get isEnded(): boolean {
    return this.ended;
  }
}

/** Extrae el tag de un evento de audio del servidor (chunk o mp3). */
export function audioTagFromEvent(msg: {
  turnId?: unknown;
  agentId?: unknown;
  sIdx?: unknown;
  sText?: unknown;
  sDurMs?: unknown;
  sTimes?: unknown;
}): AudioTag | null {
  const sIdx = Number(msg.sIdx);
  if (!Number.isFinite(sIdx) || sIdx < 0) {
    return null;
  }
  const dur = Number(msg.sDurMs);
  const times = Array.isArray(msg.sTimes) ? (msg.sTimes as unknown[]).map(Number).filter(Number.isFinite) : [];
  return {
    turnId: String(msg.turnId || ''),
    agentId: String(msg.agentId || ''),
    sIdx: Math.floor(sIdx),
    ...(typeof msg.sText === 'string' && msg.sText ? { sText: msg.sText } : {}),
    ...(Number.isFinite(dur) && dur > 0 ? { sDurMs: Math.round(dur) } : {}),
    ...(times.length > 0 ? { sTimes: times.slice(0, 200) } : {})
  };
}
