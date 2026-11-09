import { GROQ_STT_MODEL, WHISPER_URL, getDeepgramKey, getGroqKey, getSttLanguage, getSttProvider, getWhisperModel } from './settings.js';
import { transcribeDeepgram } from './deepgram.js';

// STT del usuario. Proveedores:
//  - local  (default): Parakeet-TDT-0.6B-v3 vía sherpa-onnx
//              (server/stt/parakeet_server.py, :7790, ~0.4s en CPU),
//              con fallback a Whisper faster-whisper (:7789).
//  - groq   : Whisper hosteado por Groq (API OpenAI-compatible, rapidísimo).
//  - deepgram: Nova-3 cloud (smart_format + keyterms; ~2.3s desde UY).
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

const PARAKEET_URL = process.env.PARAKEET_URL || 'http://127.0.0.1:7790';

async function postTranscribe(url, wavBase64, withModel) {
  // 'auto': language null — faster-whisper autodetecta; Parakeet ignora.
  const sttLang = String(getSttLanguage() || 'auto').toLowerCase();
  const payload = { audio_base64: wavBase64, language: sttLang.startsWith('auto') ? null : sttLang };
  if (withModel) {
    payload.model = getWhisperModel();
  }
  const response = await fetch(`${url}/v1/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(STT_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`STT local HTTP ${response.status}`);
  }
  const body = await response.json();
  return String(body.text || '').trim();
}

async function transcribeLocal(wavBase64) {
  // Parakeet primero (rápido); Whisper de respaldo (compatible).
  try {
    const text = await postTranscribe(PARAKEET_URL, wavBase64, false);
    if (text) {
      return text;
    }
  } catch {
    // Caído o lento: sigue Whisper.
  }
  return postTranscribe(WHISPER_URL, wavBase64, true);
}

async function transcribeGroq(wavBase64) {
  const key = getGroqKey();
  if (!key) {
    throw new Error('Missing Groq key (Settings → Hearing).');
  }
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(wavBase64, 'base64')], { type: 'audio/wav' }), 'turno.wav');
  form.append('model', GROQ_STT_MODEL);
  // 'auto': sin language — Whisper autodetecta (forzar un idioma hace
  // que el otro salga basura).
  const groqLang = String(getSttLanguage() || 'auto').toLowerCase();
  if (!groqLang.startsWith('auto')) {
    form.append('language', groqLang);
  }
  form.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    // Cloudflare 1010 sin UA de navegador (verificado 2026-11-08).
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
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

// Cadena de transcripción (inyectable para tests): proveedor elegido →
// Groq automático si hay clave (cubre Brave/Firefox sin hint) → Deepgram
// automático si hay clave → hint del navegador → error.
// Devuelve { text, source } o lanza.
export async function transcribeWithFallback({ wavBase64, hint = '', provider = 'local', groqKey = '', deepgramKey = '', localFn, groqFn, deepgramFn }) {
  if (provider === 'browser' || !wavBase64) {
    if (hint) {
      return { text: hint, source: 'client' };
    }
    if (groqKey && wavBase64) {
      const text = await groqFn(wavBase64);
      if (text) {
        return { text, source: 'groq' };
      }
    }
    if (deepgramKey && wavBase64 && deepgramFn) {
      const text = await deepgramFn(wavBase64);
      if (text) {
        return { text, source: 'deepgram' };
      }
    }
    throw new Error('No browser transcription.');
  }

  try {
    const text = provider === 'groq'
      ? await groqFn(wavBase64)
      : provider === 'deepgram' && deepgramFn
        ? await deepgramFn(wavBase64)
        : await localFn(wavBase64);
    if (text) {
      return { text, source: provider };
    }
    throw new Error('Empty transcription.');
  } catch (error) {
    if (provider !== 'groq' && groqKey) {
      try {
        const text = await groqFn(wavBase64);
        if (text) {
          return { text, source: 'groq' };
        }
      } catch {
        // Sigue a Deepgram / hint.
      }
    }
    if (provider !== 'deepgram' && deepgramKey && deepgramFn) {
      try {
        const text = await deepgramFn(wavBase64);
        if (text) {
          return { text, source: 'deepgram' };
        }
      } catch {
        // Cae al hint del navegador.
      }
    }
    if (hint) {
      return { text: hint, source: 'client' };
    }
    throw error;
  }
}

export async function transcribeTurn({ wavBase64, hint = '' }) {
  return transcribeWithFallback({
    wavBase64,
    hint,
    provider: getSttProvider(),
    groqKey: getGroqKey(),
    deepgramKey: getDeepgramKey(),
    localFn: transcribeLocal,
    groqFn: transcribeGroq,
    deepgramFn: transcribeDeepgram
  });
}
