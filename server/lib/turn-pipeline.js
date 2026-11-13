import { withTimeout } from './llm.js';
import { ADDRESSING_ACTION, classifyAddressing } from './addressing.js';
import { beginUserTurn, endUserTurn } from './priority.js';
import { consult as salaConsult, runSalaV2 } from './sala.js';
import { getSalaV2 } from './settings.js';

// ── SpeakerGate ─────────────────────────────────────────────────────────
// Guarantees that only ONE agent emits audio at a time, at the server level.
// The producer calls acquire() (waits for its turn), sendChunk() for each
// PCM chunk, and finish(); release waits for the client's playback_complete ack
// or a timeout based on the sent duration. flush() cuts off the
// current owner (barge-in).
// F-08: ms estimados de una oración sintetizada (PCM base64 16-bit mono).
// Puro: base para el karaoke (reparto por palabra en el cliente).
export function sentenceAudioMs(prepared, sampleRate = 24000) {
  try {
    const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
    const parts = prepared?.kind === 'mp3' ? null : prepared?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return null;
    }
    let bytes = 0;
    for (const p of parts) {
      bytes += Math.ceil((String(p?.data || '').length * 3) / 4);
    }
    const ms = Math.round((bytes / 2 / rate) * 1000);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

// QW-07: heard-text progresivo. Mapea audio sintetizado → etiquetas de
// oración para el cliente. El primer chunk de cada oración lleva {sIdx,
// sText}; los demás solo {sIdx}. Puro y testeable (sin gate ni red).
export function sentenceAudioPlan(prepared, sIdx, { durMs = null } = {}) {
  if (!prepared) {
    return null;
  }
  const idx = Math.max(0, Math.floor(Number(sIdx) || 0));
  const sText = typeof prepared.sentence === 'string' ? prepared.sentence.slice(0, 2000) : '';
  const dur = Number.isFinite(Number(durMs)) && Number(durMs) > 0 ? Math.round(Number(durMs)) : null;
  if (prepared.kind === 'mp3') {
    return { kind: 'mp3', sIdx: idx, sText, ...(dur ? { sDurMs: dur } : {}) };
  }
  const parts = Array.isArray(prepared.parts) ? prepared.parts : [];
  return {
    kind: 'pcm',
    chunks: parts.map((part, i) => ({
      part,
      extra: i === 0
        ? { sIdx: idx, sText, ...(dur ? { sDurMs: dur } : {}) }
        : { sIdx: idx }
    }))
  };
}

export class SpeakerGate {
  constructor({ emit, ackGraceMs = 1500 }) {
    this.emit = emit;
    this.ackGraceMs = ackGraceMs;
    this.owner = null;
    this.waiters = [];
  }

  // Devuelve un token cuando el agente obtiene el altavoz.
  acquire(turnId, agentId, { sampleRate = 24000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        const token = {
          turnId,
          agentId,
          sampleRate,
          sentMs: 0,
          seq: 0,
          finished: false,
          interrupted: false,
          releaseTimer: null,
          released: false
        };
        this.owner = token;
        this.emit({ type: 'agent_audio_start', turnId, agentId, sampleRate });
        this.emit({ type: 'agent_state', agentId, state: 'speaking' });
        resolve(token);
      };

      if (!this.owner) {
        grant();
        return;
      }

      const waiter = { grant, reject, signal };
      if (signal) {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  sendChunk(token, data, mimeType, extra = null) {
    if (this.owner !== token || token.finished) {
      return false;
    }
    token.seq += 1;
    // Duración estimada del PCM base64: bytes/2 muestras a sampleRate.
    const bytes = Math.ceil((String(data).length * 3) / 4);
    token.sentMs += (bytes / 2 / token.sampleRate) * 1000;
    // QW-07: extra lleva {sIdx, sText?} (heard-text progresivo). Solo
    // esas dos claves pasan al evento; nada arbitrario cruza al cliente.
    const tag = {};
    if (extra && Number.isFinite(Number(extra.sIdx))) {
      tag.sIdx = Math.max(0, Math.floor(Number(extra.sIdx)));
    }
    if (extra && typeof extra.sText === 'string' && extra.sText) {
      tag.sText = extra.sText.slice(0, 2000);
    }
    // F-08: duración de la oración (karaoke) + timings reales si los hay.
    if (extra && Number.isFinite(Number(extra.sDurMs)) && Number(extra.sDurMs) > 0) {
      tag.sDurMs = Math.round(Number(extra.sDurMs));
    }
    if (extra && Array.isArray(extra.sTimes) && extra.sTimes.length > 0) {
      tag.sTimes = extra.sTimes.map(Number).filter(Number.isFinite).slice(0, 200);
    }
    this.emit({
      type: 'agent_audio_chunk',
      turnId: token.turnId,
      agentId: token.agentId,
      data,
      mimeType: mimeType || `audio/pcm;rate=${token.sampleRate}`,
      seq: token.seq,
      ...tag
    });
    return true;
  }

  finish(token, reason = 'complete') {
    if (this.owner !== token || token.finished) {
      return;
    }
    token.finished = true;
    this.emit({
      type: 'agent_audio_end',
      turnId: token.turnId,
      agentId: token.agentId,
      reason,
      sentMs: Math.round(token.sentMs)
    });
    if (reason !== 'complete' || token.sentMs === 0) {
      this.emit({ type: 'agent_state', agentId: token.agentId, state: reason === 'interrupted' ? 'interrupted' : 'idle' });
      this.release(token);
      return;
    }
    // Espera del ack del cliente con timeout de gracia.
    token.releaseTimer = setTimeout(() => this.release(token), Math.round(token.sentMs) + this.ackGraceMs);
  }

  onPlaybackComplete(turnId, agentId) {
    const token = this.owner;
    if (token && token.turnId === turnId && token.agentId === agentId && token.finished) {
      this.emit({ type: 'agent_state', agentId, state: 'idle' });
      this.release(token);
    }
  }

  release(token) {
    if (token.released) {
      return;
    }
    token.released = true;
    if (token.releaseTimer) {
      clearTimeout(token.releaseTimer);
      token.releaseTimer = null;
    }
    if (this.owner === token) {
      this.owner = null;
      const next = this.waiters.shift();
      if (next) {
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        next.grant();
      }
    }
  }

  // Barge-in: corta al dueño actual y vacía la cola de espera.
  flush() {
    const token = this.owner;
    if (token && !token.finished) {
      token.interrupted = true;
      this.finish(token, 'interrupted');
    } else if (token) {
      this.release(token);
    }
    for (const waiter of this.waiters) {
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new Error('aborted'));
    }
    this.waiters = [];
  }
}

// ── Cola de turnos cancelable ───────────────────────────────────────────
// Un job activo por vez con AbortController propio. interrupt() aborta el
// job en curso y descarta los pendientes (el turno más nuevo del usuario
// manda). Mantiene el timeout duro para que nada cuelgue la sesión.
export class CancellableTurnQueue {
  constructor({ timeoutMs = 60000, maxPending = 10, onCancelled } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.onCancelled = onCancelled;
    this.pending = [];
    this.current = null;
    this.processing = false;
  }

  push(id, job, onError) {
    if (this.pending.length >= this.maxPending) {
      return false;
    }
    this.pending.push({ id, job, onError });
    void this.drain();
    return true;
  }

  // M-05: steer — el usuario redirige a mitad de turno: se aborta lo
  // actual y el nuevo job entra AL FRENTE (no al final de la cola).
  steer(id, job, onError) {
    this.interrupt('steered');
    if (this.pending.length >= this.maxPending) {
      return false;
    }
    this.pending.unshift({ id, job, onError });
    void this.drain();
    return true;
  }

  // Aborta el job activo y vacía los pendientes.
  interrupt(reason = 'barge_in') {
    for (const entry of this.pending) {
      this.onCancelled?.(entry.id, 'superseded');
    }
    this.pending = [];
    if (this.current) {
      this.current.controller.abort();
      this.onCancelled?.(this.current.id, reason);
    }
  }

  async drain() {
    if (this.processing) {
      return;
    }
    this.processing = true;
    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      const controller = new AbortController();
      this.current = { id: entry.id, controller };
      beginUserTurn();
      try {
        await withTimeout(
          entry.job(controller.signal),
          this.timeoutMs,
          'The turn exceeded the maximum processing time.'
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            entry.onError?.(error);
          } catch {
            // El handler de error nunca tumba la cola.
          }
        }
      } finally {
        this.current = null;
        endUserTurn();
      }
    }
    this.processing = false;
  }
}

// ── Gate pre-respuesta Team v1 (sala) ─────────────────────────────────────
// Punto ÚNICO de gate: se llama ANTES del respond normal con el texto del
// usuario y la ruta ya decidida. Devuelve el TEAM NOTE a inyectar al
// contexto del turno, o null si el turno sigue con flujo normal (flag off,
// gate negativo, error, timeout). Nunca lanza: degradación segura.
// El cableado (llamarla desde meeting-session/agent-runtime) es integración
// posterior; este helper es el punto de gate testeable y documentado.
export async function maybeConsultSala({ text, route = null, deps = {} } = {}) {
  try {
    // v2 ON → rondas ordenadas + síntesis; devuelve el NOTE o null.
    // v2 OFF → consult v1, comportamiento intacto.
    const v2On = deps.flagV2 !== undefined ? deps.flagV2 : getSalaV2();
    if (v2On) {
      const sala = await runSalaV2({ text, route, deps });
      return sala ? sala.note : null;
    }
    return await salaConsult({ text, route, deps });
  } catch {
    return null;
  }
}

// ── Gate pre-respuesta addressing (Equipo v2, T1) ───────────────────────────
// Punto ÚNICO de direccionamiento: se llama ANTES del respond normal con el
// texto del usuario y contexto (chatActive, lastTurn, …). Devuelve
// { decision, action, confidence, source } donde action ∈
// responder | solo-contexto | ignorar, o null si el turno sigue legacy
// (modo off, error, timeout). Nunca lanza: degradación segura.
// El cableado (llamarla desde meeting-session/agent-runtime) es integración
// posterior (main); este helper es el punto de gate testeable y documentado.
export async function maybeClassifyAddressing({ text, context = {}, deps = {} } = {}) {
  try {
    const result = await classifyAddressing({ text, context }, deps);
    if (!result || result.source === 'bypass') {
      return null;
    }
    return {
      decision: result.decision,
      action: ADDRESSING_ACTION[result.decision] || 'responder',
      confidence: result.confidence,
      source: result.source
    };
  } catch {
    return null;
  }
}
