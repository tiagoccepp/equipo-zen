import { GROQ_STT_MODEL, WHISPER_URL, getDeepgramKey, getGroqKey, getSttLanguage, getSttMinConfidence, getSttProvider, getWhisperModel } from './settings.js';
import { transcribeDeepgram } from './deepgram.js';
import { telemetry } from './telemetry.js';

// STT del usuario. Proveedores:
//  - local  (default): Parakeet-TDT-0.6B-v3 vía sherpa-onnx
//              (server/stt/parakeet_server.py, :7790, ~0.4s en CPU),
//              con respaldo OPORTUNISTA a Whisper faster-whisper (:7789).
//  - groq   : Whisper hosteado por Groq (API OpenAI-compatible, rapidísimo).
//  - deepgram: Nova-3 cloud (smart_format + keyterms; ~2.3s desde UY).
//  - browser: SpeechRecognition del navegador (solo el hint del cliente).
//
// DECISIÓN 09/11 (auditoría SKIP/flaky): Parakeet-único-local + fallback
// cloud. faster-whisper NO está instalado en esta máquina (sin .venv-tts,
// `import faster_whisper` falla) y nada lo levanta: Whisper es un respaldo
// oportunista —si algún día responde en :7789 se usa, si no, el
// connection-refused falla en ~1ms SIN reintentos ni sleep (ver
// transcribeLocal + test 'ambos caídos … <500ms'). La cadena real es:
// Parakeet → Whisper(oportunista) → Groq(key) → Deepgram(key) → hint.

const STT_TIMEOUT_MS = 20000;
// Parakeet mide ~398ms de mediana; 8s = colgado, caer a Whisper ya.
// Whisper/Groq/Deepgram mantienen 20-25s (turnos largos legítimos).
export const PARAKEET_TIMEOUT_MS = 8000;
// Reintento por baja confianza (§2e mínimo): solo si la confianza local es
// MUY baja, el turno es corto y hay key de Deepgram. El doble STT duele
// en latencia, así que el techo efectivo es 0.4 aunque el setting sea mayor.
export const LOW_CONFIDENCE_RETRY_MAX = 0.4;
export const CONFIDENCE_RETRY_MAX_SECS = 10;
const PARAKEET_HEALTH_TTL_MS = 15000;
const PARAKEET_HEALTH_TIMEOUT_MS = 1500;

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

// Duración estimada del WAV 16kHz/mono/16-bit (base64) en segundos.
// Sirve para decidir el reintento por confianza sin decodificar el audio.
export function wavSecondsEstimate(wavBase64) {
  const bytes = Math.floor(String(wavBase64 || '').length * 3 / 4);
  if (bytes <= 44) {
    return 0;
  }
  return (bytes - 44) / 32000;
}

// Normalizan resultados viejos (string) y nuevos ({ text, confidence }):
// los stubs de tests viejos y Groq devuelven string; Parakeet/Whisper/
// Deepgram devuelven objeto con confianza.
function resultText(res) {
  if (typeof res === 'string') {
    return res.trim();
  }
  return String(res?.text || '').trim();
}

function resultConfidence(res) {
  const c = (typeof res === 'object' && res !== null) ? res.confidence : undefined;
  return (typeof c === 'number' && Number.isFinite(c)) ? c : null;
}

// Healthcheck de Parakeet con caché que SOLO recuerda DOWN (patrón
// isPiperAvailable en piper.js, pero asimétrico): un éxito resetea al
// instante, así un sidecar recién levantado entra sin esperar el TTL.
// Arranca optimista (0 = nunca visto caído): el primer turno siempre
// intenta Parakeet.
let parakeetDownAt = 0;

export function __resetParakeetHealth() {
  parakeetDownAt = 0;
}

export async function isParakeetAvailable(baseUrl = PARAKEET_URL) {
  if (parakeetDownAt && Date.now() - parakeetDownAt < PARAKEET_HEALTH_TTL_MS) {
    return false;
  }
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PARAKEET_HEALTH_TIMEOUT_MS) });
    if (response.ok) {
      parakeetDownAt = 0;
      return true;
    }
  } catch {
    // Caído o colgado: se marca abajo.
  }
  parakeetDownAt = Date.now();
  return false;
}

export async function postTranscribe(url, wavBase64, { withModel = false, timeoutMs = STT_TIMEOUT_MS } = {}) {
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
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`STT local HTTP ${response.status}`);
  }
  const body = await response.json();
  const confidence = typeof body.confidence === 'number' && Number.isFinite(body.confidence)
    ? body.confidence
    : null;
  return { text: String(body.text || '').trim(), confidence };
}

export async function transcribeLocal(wavBase64, { parakeetUrl = PARAKEET_URL, whisperUrl = WHISPER_URL, parakeetTimeoutMs = PARAKEET_TIMEOUT_MS, whisperTimeoutMs = STT_TIMEOUT_MS } = {}) {
  // Parakeet primero (rápido); Whisper de respaldo OPORTUNISTA (casi nunca
  // está: sin faster-whisper instalado el puerto está cerrado y el fetch
  // rechaza en ~1ms, SIN reintentos ni sleeps — el skip es gratis). Si el
  // health dice caído, se salta directo a Whisper sin pagar el intento.
  if (await isParakeetAvailable(parakeetUrl)) {
    try {
      const res = await postTranscribe(parakeetUrl, wavBase64, { timeoutMs: parakeetTimeoutMs });
      if (res.text) {
        return res;
      }
    } catch {
      // Caído o lento: sigue Whisper.
    }
  }
  return postTranscribe(whisperUrl, wavBase64, { withModel: true, timeoutMs: whisperTimeoutMs });
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
// Si el resultado local trae confianza MUY baja (< min(0.4, setting)) y el
// turno es corto (<10s) con key de Deepgram, reintenta UNA vez con
// Deepgram; si ese reintento falla o sale vacío, vale el texto original.
// Devuelve { text, source } o lanza.
export async function transcribeWithFallback({ wavBase64, hint = '', provider = 'local', groqKey = '', deepgramKey = '', minConfidence = getSttMinConfidence(), localFn, groqFn, deepgramFn }) {
  const retryThreshold = Math.min(Number(minConfidence) || 0, LOW_CONFIDENCE_RETRY_MAX);

  // Reintento por baja confianza: solo en el path local con confianza
  // numérica. Nunca cuando el proveedor ya es Deepgram.
  async function maybeRetryLowConfidence(res) {
    const confidence = resultConfidence(res);
    if (confidence === null || confidence >= retryThreshold) {
      return null;
    }
    if (provider === 'deepgram' || !deepgramKey || !deepgramFn) {
      return null;
    }
    if (wavSecondsEstimate(wavBase64) >= CONFIDENCE_RETRY_MAX_SECS) {
      return null;
    }
    try {
      const retry = await deepgramFn(wavBase64);
      const text = resultText(retry);
      telemetry.add({ type: 'stt_retry', payload: { from: provider, confidence, retried: Boolean(text) } });
      if (text) {
        return { text, source: 'deepgram' };
      }
    } catch (error) {
      telemetry.add({ type: 'stt_retry', payload: { from: provider, confidence, retried: false, error: String(error?.message || error).slice(0, 120) } });
    }
    return null;
  }

  if (provider === 'browser' || !wavBase64) {
    if (hint) {
      return { text: hint, source: 'client' };
    }
    if (groqKey && wavBase64) {
      const text = resultText(await groqFn(wavBase64));
      if (text) {
        return { text, source: 'groq' };
      }
    }
    if (deepgramKey && wavBase64 && deepgramFn) {
      const text = resultText(await deepgramFn(wavBase64));
      if (text) {
        return { text, source: 'deepgram' };
      }
    }
    throw new Error('No browser transcription.');
  }

  try {
    const res = provider === 'groq'
      ? await groqFn(wavBase64)
      : provider === 'deepgram' && deepgramFn
        ? await deepgramFn(wavBase64)
        : await localFn(wavBase64);
    const text = resultText(res);
    if (text) {
      if (provider !== 'groq' && provider !== 'deepgram') {
        const retried = await maybeRetryLowConfidence(res);
        if (retried) {
          return retried;
        }
      }
      return { text, source: provider };
    }
    throw new Error('Empty transcription.');
  } catch (error) {
    if (provider !== 'groq' && groqKey) {
      try {
        const text = resultText(await groqFn(wavBase64));
        if (text) {
          return { text, source: 'groq' };
        }
      } catch {
        // Sigue a Deepgram / hint.
      }
    }
    if (provider !== 'deepgram' && deepgramKey && deepgramFn) {
      try {
        const text = resultText(await deepgramFn(wavBase64));
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
