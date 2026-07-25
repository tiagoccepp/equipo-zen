import { cleanTranscript } from './text.js';

// Transcriptor sin nube: el reconocimiento de voz corre EN el navegador
// (SpeechRecognition) y llega como transcriptHint junto con audio_end.
// Este runtime solo enmarca el turno (listening start/stop) y finaliza
// con el hint; mantiene la interfaz que consume MeetingSession.
export class HintTranscriberRuntime {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.lastFinalized = '';
    this.turnFinalized = false;
  }

  async prepareListening() {
    this.callbacks.emit({ type: 'audio_listening_start' });
  }

  async startListening() {
    this.turnFinalized = false;
    this.callbacks.emit({ type: 'audio_listening_start' });
  }

  // El audio PCM ya no viaja al servidor; se tolera por compatibilidad.
  async sendAudio() {}

  endAudio({ transcriptHint = '' } = {}) {
    if (this.acceptClientTranscript(transcriptHint)) {
      return;
    }
    this.callbacks.emit({
      type: 'audio_transcription_empty',
      message: 'No capté la frase con el reconocimiento del navegador; probá de nuevo o escribí el turno.'
    });
  }

  acceptClientTranscript(text) {
    const finalText = cleanTranscript(text);
    if (!finalText || finalText === this.lastFinalized) {
      return false;
    }
    this.turnFinalized = true;
    this.lastFinalized = finalText;
    this.callbacks.emit({
      type: 'user_audio_turn_final',
      text: finalText,
      source: 'client'
    });
    this.callbacks.onTranscript(finalText);
    return true;
  }

  stopListening() {
    this.callbacks.emit({ type: 'audio_listening_stop' });
  }

  reset() {
    this.lastFinalized = '';
    this.turnFinalized = false;
  }

  close() {}
}
