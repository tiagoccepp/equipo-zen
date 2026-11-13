// M-01: doble canal update+filler con timing explícito.
// UPDATE = progreso informativo (se ve en status); FILLER = relleno de voz
// (se escucha). Reglas duras:
// - Update: throttle 4s + dedupe + tope 200ch (el status no parpadea).
// - Filler: throttle 8s + solo si no hubo habla reciente (nunca pisa voz).
// - Los dos canales son best-effort: jamás bloquean ni rompen el turno.

export const UPDATE_MIN_INTERVAL_MS = 4000;
export const UPDATE_MAX_CHARS = 200;
export const FILLER_MIN_INTERVAL_MS = 8000;
export const FILLER_AFTER_SPEECH_MS = 3000;

export function createNarrationGate({ now = () => Date.now() } = {}) {
  let lastUpdateAt = 0;
  let lastUpdateText = '';
  let lastFillerAt = 0;
  let lastSpeechAt = 0;

  return {
    // El TTS/habla avisa para que el filler no pise voz.
    markSpeech() {
      lastSpeechAt = now();
    },
    // ¿Sale este update? Dedupe + throttle + recorte.
    update(text) {
      const clean = String(text || '').trim().slice(0, UPDATE_MAX_CHARS);
      if (!clean || clean === lastUpdateText) {
        return null;
      }
      const t = now();
      if (t - lastUpdateAt < UPDATE_MIN_INTERVAL_MS) {
        return null;
      }
      lastUpdateAt = t;
      lastUpdateText = clean;
      return clean;
    },
    // ¿Sale un filler ahora? Throttle + silencio de habla reciente.
    filler() {
      const t = now();
      if (t - lastFillerAt < FILLER_MIN_INTERVAL_MS) {
        return false;
      }
      if (t - lastSpeechAt < FILLER_AFTER_SPEECH_MS) {
        return false;
      }
      lastFillerAt = t;
      return true;
    }
  };
}
