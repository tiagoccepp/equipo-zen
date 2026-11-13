// QW-07: heard-text progresivo — el texto del agente se revela al ritmo
// del audio que suena, nunca antes (no spoiler). Cada chunk de audio llega
// etiquetado con sIdx (índice de oración); el primero de cada oración trae
// además sText. Sin audio (modo texto / voz apagada) se muestra todo junto,
// igual que antes.

export interface AudioTag {
  turnId: string;
  agentId: string;
  sIdx: number;
  sText?: string;
  // F-08: karaoke — duración estimada (ms) + timings reales si los hay.
  sDurMs?: number;
  sTimes?: number[];
}

/** Estado de revelado de un turno: oraciones observadas + hasta dónde se mostró. */
export class HeardTurn {
  private sentences = new Map<number, string>();
  private revealedUpTo = -1;
  private ended = false;

  /** Un chunk con sIdx empezó a sonar → textos newly-revealed, en orden. */
  observe(tag: AudioTag): string[] {
    if (this.ended) return [];
    const idx = Math.max(0, Math.floor(Number(tag.sIdx) || 0));
    if (typeof tag.sText === 'string' && tag.sText.trim()) {
      this.sentences.set(idx, tag.sText);
    }
    const fresh: string[] = [];
    // Regla ≤: si una oración no tuvo audio propio (silenciosa), se revela
    // junto con la siguiente audible — nunca queda un hueco.
    for (let i = this.revealedUpTo + 1; i <= idx; i += 1) {
      const text = this.sentences.get(i);
      if (text !== undefined) {
        fresh.push(text);
      }
      this.revealedUpTo = i;
    }
    return fresh;
  }

  /** ¿Ya se reveló algo? (decide si el turno va en modo progresivo). */
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
