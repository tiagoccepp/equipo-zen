import { withTimeout } from './gemini.js';

// ── SpeakerGate ─────────────────────────────────────────────────────────
// Garantiza que UN solo agente emite audio a la vez, a nivel servidor.
// El productor hace acquire() (espera su turno), sendChunk() por cada
// chunk PCM y finish(); la liberación espera el ack playback_complete del
// cliente o un timeout basado en la duración enviada. flush() corta al
// dueño actual (barge-in).
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

  sendChunk(token, data, mimeType) {
    if (this.owner !== token || token.finished) {
      return false;
    }
    token.seq += 1;
    // Duración estimada del PCM base64: bytes/2 muestras a sampleRate.
    const bytes = Math.ceil((String(data).length * 3) / 4);
    token.sentMs += (bytes / 2 / token.sampleRate) * 1000;
    this.emit({
      type: 'agent_audio_chunk',
      turnId: token.turnId,
      agentId: token.agentId,
      data,
      mimeType: mimeType || `audio/pcm;rate=${token.sampleRate}`,
      seq: token.seq
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
      try {
        await withTimeout(
          entry.job(controller.signal),
          this.timeoutMs,
          'El turno excedió el tiempo máximo de procesamiento.'
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
      }
    }
    this.processing = false;
  }
}
