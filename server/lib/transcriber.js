import { buildWavBase64FromPcmChunks, transcribeTurn } from './stt.js';
import { getSttProvider } from './settings.js';
import { cleanTranscript, getShortError } from './text.js';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

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
