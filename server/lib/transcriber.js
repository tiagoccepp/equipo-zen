import { buildWavBase64FromPcmChunks, transcribeTurn } from './stt.js';
import { speechVerdict } from './silero.js';
import { telemetry } from './telemetry.js';
import { getSttProvider } from './settings.js';
import { cleanTranscript, getShortError } from './text.js';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// Alucinaciones típicas de Whisper/Parakeet sobre ruido (teclado, ventilador,
// silencio): si la transcripción es SOLO esto, no fue un turno, fue ruido.
const JUNK_PHRASES = [
  'thank you', 'thanks for watching', 'subscribe', 'suscribete', 'suscríbete',
  'gracias por ver', 'hasta la proxima', 'hasta la próxima', 'amara.org',
  'sous-titres', 'all rights reserved', 'todos los derechos reservados',
  'silence', 'silencio', 'you', 'shh', 'hmm', 'mmm', 'eh', 'ah', 'oh',
  'laughter', 'risa', 'applause', 'aplausos', 'music', 'musica', 'música',
  'transcribe', 'transcripción', 'inaudible'
];

// Afirmaciones y acks: repetirlos es énfasis rioplatense ("sí, sí", "dale
// dale"), no alucinación. Exentas de la regla de palabra-repetida (09/11:
// el filtro viejo las marcaba junk y el usuario tenía que repetir).
const REPEAT_OK = new Set(['si', 'no', 'dale', 'ok', 'ya', 'bien', 'claro', 'bueno', 'gracias', 'chau', 'vale']);
// Gruñidos: una sola de estas palabras (o solo estas repetidas) es ruido.
function normalizeJunk(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isJunkTranscript(text) {
  const norm = normalizeJunk(text);
  if (!norm) {
    return true;
  }
  if (norm.length < 2) {
    return true;
  }
  const GRUNTS = new Set(['mmm', 'eh', 'ah', 'oh', 'shh', 'hmm', 'ehem']);
  const words = norm.split(' ');
  const uniq = new Set(words);
  // Una sola palabra repetida N veces ("mmm mmm", "you you you"): loop de
  // ruido o alucinación — salvo afirmaciones, que se repiten para enfatizar.
  if (words.length > 1 && uniq.size === 1) {
    return !REPEAT_OK.has(words[0]);
  }
  if (words.length === 1 && GRUNTS.has(words[0])) {
    return true;
  }
  return JUNK_PHRASES.some((phrase) => norm === phrase || norm.startsWith(`${phrase} `) || norm.endsWith(` ${phrase}`));
}

// Captura el audio del turno (PCM 16kHz del micrófono) y lo transcribe con
// el proveedor elegido en Ajustes: Whisper local (default), Groq, o el
// SpeechRecognition del navegador (hint). El hint siempre viaja como red
// de seguridad.
export class CaptureTranscriberRuntime {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.chunks = [];
    this.capturedBytes = 0;
    this.lastFinalized = '';
    this.busy = false;
  }

  async prepareListening() {
    this.callbacks.emit({ type: 'audio_listening_start' });
  }

  async startListening() {
    this.chunks = [];
    this.capturedBytes = 0;
    this.callbacks.emit({ type: 'audio_listening_start' });
  }

  async sendAudio(data) {
    if (!data || getSttProvider() === 'browser') {
      return;
    }
    const bytes = Math.ceil((String(data).length * 3) / 4);
    if (this.capturedBytes + bytes > MAX_CAPTURE_BYTES) {
      return;
    }
    this.chunks.push(data);
    this.capturedBytes += bytes;
  }

  endAudio({ transcriptHint = '' } = {}) {
    const hint = cleanTranscript(transcriptHint);
    const chunks = this.chunks;
    this.chunks = [];
    this.capturedBytes = 0;
    // Cada audio_end es un veredicto nuevo: el dedup cross-turn tragaba en
    // silencio las repeticiones legítimas ("dale"... "dale"). Dentro del
    // turno no hay doble finalize (busy + chunks consumidos), así que resetear
    // acá no pierde protección (09/11).
    this.lastFinalized = '';

    if (this.busy) {
      return;
    }
    this.busy = true;
    void this.processTurn(chunks, hint);
  }

  async processTurn(chunks, hint) {
    const t0 = Date.now();
    // Duración aprox del turno en segundos (desde bytes PCM16 16k mono).
    // Clave 'secs' (no 'audioSecs'): el sanitizador omite claves con 'audio'.
    const secs = Math.round((chunks.reduce((n, c) => n + Math.ceil(String(c || '').length * 3 / 4), 0) / 32000) * 100) / 100;
    const turnEvent = (extra) => telemetry.add({ type: 'audio_turn_stt', payload: { secs, ...extra } });
    try {
      // Compuerta Silero: sin habla real no se gasta STT (ahorra 1-2s y
      // evita alucinaciones). Null = Silero no disponible: seguir normal.
      const verdict = await speechVerdict(chunks);
      if (verdict && !verdict.speech) {
        turnEvent({ empty: true, reason: 'silero_no_speech', silero: { maxProb: verdict.maxProb, ratio: verdict.speechRatio }, sttMs: Date.now() - t0 });
        this.callbacks.emit({
          type: 'audio_transcription_empty',
          message: 'Just background noise; keep talking.',
          silero: { maxProb: verdict.maxProb, ratio: verdict.speechRatio }
        });
        return;
      }
      const wavBase64 = chunks.length > 0 ? buildWavBase64FromPcmChunks(chunks) : '';
      if (wavBase64 && getSttProvider() !== 'browser') {
        this.callbacks.emit({ type: 'audio_transcription_status', message: 'Transcribing…' });
      }
      try {
        const t1 = Date.now();
        const { text, source } = await transcribeTurn({ wavBase64, hint });
        turnEvent({ empty: !cleanTranscript(text), source, sttMs: Date.now() - t1, silero: verdict ? { maxProb: verdict.maxProb, ratio: verdict.speechRatio } : null });
        this.finalize(text, source);
      } catch (error) {
        turnEvent({ empty: true, reason: 'stt_error', sttMs: Date.now() - t0 });
        this.callbacks.emit({
          type: 'audio_transcription_empty',
          message: `Couldn't transcribe that turn (${getShortError(error)}); try again or type it.`
        });
      }
    } finally {
      this.busy = false;
    }
  }

  finalize(text, source) {
    const finalText = cleanTranscript(text);
    // Dedup intra-turno (endAudio resetea lastFinalized cada turno: repetir la
    // misma frase en turnos distintos es legítimo y debe salir).
    if (!finalText || finalText === this.lastFinalized) {
      return;
    }
    if (isJunkTranscript(finalText)) {
      this.callbacks.emit({ type: 'audio_transcription_empty', message: 'Just background noise; keep talking.' });
      return;
    }
    this.lastFinalized = finalText;
    this.callbacks.emit({ type: 'user_audio_turn_final', text: finalText, source });
    this.callbacks.onTranscript(finalText);
  }

  // Compat con la sesión (aceptación directa del hint en flujos viejos).
  acceptClientTranscript(text) {
    const finalText = cleanTranscript(text);
    if (!finalText) {
      return false;
    }
    this.finalize(finalText, 'client');
    return true;
  }

  stopListening() {
    this.callbacks.emit({ type: 'audio_listening_stop' });
  }

  reset() {
    this.chunks = [];
    this.capturedBytes = 0;
    this.lastFinalized = '';
  }

  close() {}
}
