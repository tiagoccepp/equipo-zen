import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';

import {
  AUDIO_MIME_TYPE,
  FALLBACK_TRANSCRIBE_DELAY_MS,
  LIVE_TRANSCRIPT_FINALIZE_MS,
  MAX_INLINE_TRANSCRIBE_BYTES,
  MODEL,
  TRANSCRIBE_MODEL
} from './config.js';
import { cleanTranscript, getShortError } from './text.js';

export class LiveAudioTranscriberRuntime {
  constructor(keyRingInstance, memory, callbacks) {
    this.keyRing = keyRingInstance;
    this.memory = memory;
    this.callbacks = callbacks;
    this.session = null;
    this.key = null;
    this.connecting = null;
    this.transcript = '';
    this.finalizeTimer = null;
    this.lastFinalized = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
  }

  async prepareListening() {
    this.callbacks.emit({ type: 'audio_listening_start' });
    if (!this.keyRing.hasKeys()) {
      return;
    }
    await this.ensureSession();
  }

  async startListening() {
    this.transcript = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
    this.callbacks.emit({ type: 'audio_listening_start' });
    if (!this.keyRing.hasKeys()) {
      return;
    }
    await this.ensureSession();
  }

  async sendAudio(data, mimeType = AUDIO_MIME_TYPE) {
    if (!data) {
      return;
    }

    this.captureAudioChunk(data);
    // Sin claves no hay sesión Live: el turno se finaliza con el
    // transcriptHint del reconocimiento del navegador (modo simulación).
    if (!this.keyRing.hasKeys()) {
      return;
    }
    await this.ensureSession();
    try {
      this.session.sendRealtimeInput({
        audio: {
          data,
          mimeType
        }
      });
    } catch (error) {
      await this.rotateAfterFailure(error, 'transcriptor');
      this.session?.sendRealtimeInput({
        audio: {
          data,
          mimeType
        }
      });
    }
  }

  endAudio({ closeStream = false, transcriptHint = '' } = {}) {
    if (this.acceptClientTranscript(transcriptHint)) {
      return;
    }

    if (closeStream) {
      try {
        this.session?.sendRealtimeInput({ audioStreamEnd: true });
      } catch (error) {
        this.callbacks.emit({
          type: 'api_rotation_failed',
          scope: 'transcriptor',
          message: getShortError(error)
        });
      }
    }
    this.scheduleFinalize(FALLBACK_TRANSCRIBE_DELAY_MS);
  }

  acceptClientTranscript(text) {
    const finalText = cleanTranscript(text);
    if (!finalText) {
      return false;
    }

    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    this.emitFinalTranscript(finalText, 'client');
    return true;
  }

  stopListening() {
    this.endAudio({ closeStream: true });
    this.callbacks.emit({ type: 'audio_listening_stop' });
  }

  reset() {
    this.transcript = '';
    this.lastFinalized = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.fallbackInProgress = false;
    this.turnFinalized = false;
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
  }

  async ensureSession() {
    if (!this.keyRing.hasKeys()) {
      throw new Error('No hay claves Gemini configuradas para audio Live.');
    }
    if (this.session) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectWithRotation().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async connectWithRotation() {
    const attempts = Math.max(1, this.keyRing.size());
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.connect();
        return;
      } catch (error) {
        lastError = error;
        this.callbacks.emit({
          type: 'api_rotation_start',
          scope: 'audio',
          message: 'Rotando clave de audio Live.'
        });
      }
    }

    throw lastError || new Error('No hay una clave disponible para audio Live.');
  }

  async connect() {
    this.key = this.keyRing.acquire();
    if (!this.key) {
      throw new Error('Todas las claves Gemini estan en cooldown para audio Live.');
    }

    const ai = new GoogleGenAI({ apiKey: this.key.value });
    const config = {
      responseModalities: [Modality.TEXT],
      maxOutputTokens: 24,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      inputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 120,
          silenceDurationMs: 300
        }
      },
      systemInstruction: [
        'You are a real-time transcription engine for a virtual meeting system.',
        '',
        'YOUR ONLY JOB:',
        'Transcribe exactly what the user says in Spanish.',
        '',
        'OUTPUT RULES:',
        '- Return only the transcription. Nothing else.',
        '- No punctuation corrections, no summaries, no explanations.',
        '- No timestamps, no speaker labels, no formatting.',
        '- If the audio is unclear or there is no speech: return an empty string.',
        '- If you must return any non-transcription text for any reason: return only "OK".',
        '',
        'Do not interpret. Do not respond. Do not assist. Only transcribe.'
      ].join('\n')
    };

    try {
      this.session = await ai.live.connect({
        model: MODEL,
        config,
        callbacks: {
          onopen: () => {
            this.keyRing.reportSuccess(this.key);
            this.callbacks.emit({
              type: 'api_rotation_resolved',
              scope: 'audio',
              keyId: this.key.id
            });
          },
          onmessage: (message) => this.handleMessage(message),
          onerror: (error) => {
            this.keyRing.reportFailure(this.key, error);
            this.callbacks.emit({
              type: 'api_rotation_start',
              scope: 'audio',
              message: 'Reconectando audio Live.'
            });
          },
          onclose: () => {
            this.session = null;
          }
        }
      });
    } catch (error) {
      this.keyRing.reportFailure(this.key, error);
      this.session = null;
      throw error;
    }
  }

  async rotateAfterFailure(error, scope) {
    this.keyRing.reportFailure(this.key, error);
    this.callbacks.emit({
      type: 'api_rotation_start',
      scope,
      message: 'Rotando clave de audio Live.'
    });
    this.close();
    this.session = null;
    await this.ensureSession();
  }

  handleMessage(message) {
    const content = message?.serverContent;
    if (!content) {
      return;
    }

    if (content.inputTranscription?.text) {
      this.transcript += content.inputTranscription.text;
      this.callbacks.emit({
        type: 'user_audio_transcript_delta',
        delta: content.inputTranscription.text,
        text: this.transcript.trim()
      });
      this.scheduleFinalize(LIVE_TRANSCRIPT_FINALIZE_MS);
    }

    if (content.generationComplete || content.turnComplete) {
      this.scheduleFinalize(LIVE_TRANSCRIPT_FINALIZE_MS);
    }
  }

  scheduleFinalize(delay) {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
    }

    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      void this.finalizeTranscript();
    }, delay);
  }

  async finalizeTranscript() {
    if (this.turnFinalized) {
      return;
    }

    const text = this.transcript.trim();
    if (!text || text === this.lastFinalized) {
      if (!text) {
        await this.finalizeWithBufferedAudio();
      }
      return;
    }

    this.emitFinalTranscript(text, 'live');
  }

  async finalizeWithBufferedAudio() {
    if (this.turnFinalized || this.fallbackInProgress || this.audioBytes < 1600) {
      return;
    }
    if (!this.keyRing.hasKeys()) {
      this.audioChunks = [];
      this.audioBytes = 0;
      this.callbacks.emit({
        type: 'audio_transcription_empty',
        message: 'Sin claves Gemini solo funciona el reconocimiento del navegador; probá de nuevo o escribí el turno.'
      });
      return;
    }
    this.fallbackInProgress = true;

    this.callbacks.emit({
      type: 'audio_transcription_status',
      message: 'Transcribiendo audio...'
    });

    try {
      const text = await this.transcribeBufferedAudio();
      if (text) {
        this.emitFinalTranscript(text, 'fallback');
        return;
      }

      this.callbacks.emit({
        type: 'audio_transcription_empty',
        message: 'No pude detectar una frase clara.'
      });
    } catch (error) {
      this.callbacks.emit({
        type: 'api_rotation_failed',
        scope: 'audio',
        message: getShortError(error)
      });
    } finally {
      this.fallbackInProgress = false;
      this.audioChunks = [];
      this.audioBytes = 0;
    }
  }

  async transcribeBufferedAudio() {
    if (this.audioBytes > MAX_INLINE_TRANSCRIBE_BYTES) {
      throw new Error('El turno de audio es demasiado largo para transcripcion inline.');
    }

    const wavData = buildWavBase64FromPcmChunks(this.audioChunks);
    const attempts = Math.max(1, this.keyRing.size());
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const key = this.keyRing.acquire();
      if (!key) {
        break;
      }

      try {
        const ai = new GoogleGenAI({ apiKey: key.value });
        const response = await ai.models.generateContent({
          model: TRANSCRIBE_MODEL,
          config: {
            maxOutputTokens: 64,
            temperature: 0,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    'You are a fallback transcription engine.\n\n' +
                    'Transcribe exactly what the user said in Spanish.\n\n' +
                    'Return only the transcription text.\n' +
                    '- No quotes.\n' +
                    '- No explanation.\n' +
                    '- No timestamps.\n' +
                    '- If there is no clear speech, return an empty string.'
                },
                {
                  inlineData: {
                    mimeType: 'audio/wav',
                    data: wavData
                  }
                }
              ]
            }
          ]
        });
        this.keyRing.reportSuccess(key);
        return cleanTranscript(response.text || '');
      } catch (error) {
        lastError = error;
        this.keyRing.reportFailure(key, error);
        this.callbacks.emit({
          type: 'api_rotation_start',
          scope: 'audio',
          message: 'Rotando clave para transcribir audio.'
        });
      }
    }

    throw lastError || new Error('No hay claves disponibles para transcribir audio.');
  }

  emitFinalTranscript(text, source) {
    const finalText = cleanTranscript(text);
    if (!finalText || this.turnFinalized || finalText === this.lastFinalized) {
      return;
    }

    this.turnFinalized = true;
    this.lastFinalized = finalText;
    this.transcript = '';
    this.audioChunks = [];
    this.audioBytes = 0;
    this.callbacks.emit({
      type: 'user_audio_turn_final',
      text: finalText,
      source
    });
    this.callbacks.onTranscript(finalText);
  }

  captureAudioChunk(data) {
    const bytes = Math.ceil((String(data).length * 3) / 4);
    if (this.audioBytes + bytes > MAX_INLINE_TRANSCRIBE_BYTES) {
      return;
    }
    this.audioChunks.push(data);
    this.audioBytes += bytes;
  }

  close() {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    try {
      this.session?.close?.();
    } catch {
      // Closing is best effort.
    }
    this.session = null;
  }
}

export function buildWavBase64FromPcmChunks(chunks) {
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
  const header = Buffer.alloc(44);
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]).toString('base64');
}
