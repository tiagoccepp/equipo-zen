import { withTimeout } from './gemini.js';

// Cola secuencial de turnos con timeout por turno y profundidad acotada.
// Reemplaza la cadena de promesas infinita: un turno colgado ya no bloquea
// la sesión para siempre. (El workstream de tiempo real la evoluciona a
// cancelable con AbortController.)
export class TurnQueue {
  constructor({ timeoutMs = 60000, maxPending = 10 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.pending = [];
    this.processing = false;
  }

  get size() {
    return this.pending.length + (this.processing ? 1 : 0);
  }

  // job: async () => void — debe manejar sus propios errores de dominio;
  // acá solo se garantiza el timeout y que la cola siga viva.
  push(job, onError) {
    if (this.pending.length >= this.maxPending) {
      return false;
    }
    this.pending.push({ job, onError });
    void this.drain();
    return true;
  }

  async drain() {
    if (this.processing) {
      return;
    }
    this.processing = true;
    while (this.pending.length > 0) {
      const { job, onError } = this.pending.shift();
      try {
        await withTimeout(job(), this.timeoutMs, 'El turno excedió el tiempo máximo de procesamiento.');
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // El handler de error nunca debe tumbar la cola.
        }
      }
    }
    this.processing = false;
  }
}
