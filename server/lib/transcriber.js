import { buildWavBase64FromPcmChunks, transcribeTurn } from './stt.js';
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
  // Gruñidos ("mmm", "eh eh") = ruido; pero "sí"/"no" solos son válidos.
  const GRUNTS = new Set(['mmm', 'eh', 'ah', 'oh', 'shh', 'hmm', 'mmm', 'ehem']);
  const words = norm.split(' ');
  if (words.length > 1 && words.length <= 3 && new Set(words).size === 1) {
    return true;
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

    if (this.busy) {
      return;
    }
    this.busy = true;

    const wavBase64 = chunks.length > 0 ? buildWavBase64FromPcmChunks(chunks) : '';
    if (wavBase64 && getSttProvider() !== 'browser') {
      this.callbacks.emit({ type: 'audio_transcription_status', message: 'Transcribiendo…' });
    }

    void transcribeTurn({ wavBase64, hint })
      .then(({ text, source }) => {
        this.finalize(text, source);
      })
      .catch((error) => {
        this.callbacks.emit({
          type: 'audio_transcription_empty',
          message: `No pude transcribir el turno (${getShortError(error)}); probá de nuevo o escribí.`
        });
      })
      .finally(() => {
        this.busy = false;
      });
  }

  finalize(text, source) {
    const finalText = cleanTranscript(text);
    if (!finalText || finalText === this.lastFinalized) {
      return;
    }
    if (isJunkTranscript(finalText)) {
      this.callbacks.emit({ type: 'audio_transcription_empty', message: 'Solo ruido de fondo; seguí hablando nomás.' });
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
