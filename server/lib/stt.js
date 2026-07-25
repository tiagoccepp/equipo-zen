import { GROQ_STT_MODEL, WHISPER_URL, getGroqKey, getSttLanguage, getSttProvider, getWhisperModel } from './settings.js';

// STT del usuario. Proveedores:
//  - local  (default): Whisper open source de OpenAI vía faster-whisper
//              (server/stt/whisper_server.py, 100% en la máquina).
//  - groq   : Whisper hosteado por Groq (API OpenAI-compatible, rapidísimo).
//  - browser: SpeechRecognition del navegador (solo el hint del cliente).

const STT_TIMEOUT_MS = 20000;

// Ensambla un WAV 16kHz/mono/16-bit desde los chunks PCM base64 del micrófono.
export function buildWavBase64FromPcmChunks(chunks, sampleRate = 16000) {
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
  const header = Buffer.alloc(44);
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

export async function whisperHealthy() {
  try {
    const response = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function transcribeLocal(wavBase64) {
  const response = await fetch(`${WHISPER_URL}/v1/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_base64: wavBase64,
      language: getSttLanguage(),
      model: getWhisperModel()
    }),
    signal: AbortSignal.timeout(STT_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Whisper local HTTP ${response.status}`);
  }
  const body = await response.json();
  return String(body.text || '').trim();
}

async function transcribeGroq(wavBase64) {
  const key = getGroqKey();
  if (!key) {
    throw new Error('Falta la clave de Groq (Ajustes → Oído).');
  }
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wavBase64, 'base64')], { type: 'audio/wav' }), 'turno.wav');
  form.append('model', GROQ_STT_MODEL);
  form.append('language', getSttLanguage());
  form.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Groq HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const body = await response.json();
  return String(body.text || '').trim();
}

// Devuelve { text, source } o lanza. hint = transcripción del navegador,
// usada como red de seguridad si el proveedor elegido falla.
export async function transcribeTurn({ wavBase64, hint = '' }) {
  const provider = getSttProvider();

  if (provider === 'browser' || !wavBase64) {
    if (hint) {
      return { text: hint, source: 'client' };
    }
    throw new Error('Sin transcripción del navegador.');
  }

  try {
    const text = provider === 'groq' ? await transcribeGroq(wavBase64) : await transcribeLocal(wavBase64);
    if (text) {
      return { text, source: provider };
    }
    throw new Error('Transcripción vacía.');
  } catch (error) {
    if (hint) {
      return { text: hint, source: 'client' };
    }
    throw error;
  }
}
