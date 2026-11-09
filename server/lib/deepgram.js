// Deepgram cloud: STT Nova-3 + TTS Aura-2 (español).
// STT REST ~2.3s y TTS REST ~2.4s medidos desde Uruguay 2026-11-08: más
// lentos que el local (Parakeet 0.4s / Supertonic 1.7s) por el viaje de red
// (~1.1s solo conectar). Su valor: calidad (smart_format, keyterms,
// voces Aura), nube (donde el local no entra, ej. Render) y futuro
// streaming WS + diarización. Auth: `Token KEY` (no Bearer).

import { getDeepgramKey, getSttLanguage, getTtsLanguage } from './settings.js';

export const DEEPGRAM_STT_MODEL = 'nova-3';
const DEEPGRAM_TIMEOUT_MS = 25000;

// Voces Aura-2 verificadas 2026-11-08 contra la API real (speak → 200 +
// audio no vacío). ES: las 5 es + codeswitch (Javier M / Selena F).
// EN: Thalia F / Orpheus M (candidatas aura-2-*-en; Basil y Ares 403).
export const DEEPGRAM_TTS_VOICES = {
  es: { M: 'aura-2-javier-es', F: 'aura-2-selena-es' },
  en: { M: 'aura-2-orpheus-en', F: 'aura-2-thalia-en' }
};

// Supertonic M1-M5/F1-F5 → voz Aura equivalente por género, en el idioma
// configurado (tts.language: 'en*' usa las inglesas).
export function mapVoiceToDeepgram(supertonicVoice) {
  const v = String(supertonicVoice || '').trim().toUpperCase();
  const lang = String(getTtsLanguage() || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
  const table = DEEPGRAM_TTS_VOICES[lang];
  return v.startsWith('F') ? table.F : table.M;
}

function authHeaders(extra = {}) {
  const key = getDeepgramKey();
  if (!key) {
    throw new Error('Missing Deepgram key (stt.deepgramKey).');
  }
  return { Authorization: `Token ${key}`, ...extra };
}

// Transcribe un WAV 16kHz (base64). Nova-3 + idioma de settings +
// formato inteligente + keyterm "Pablo" para que el nombre propio entre
// siempre (antes Sofia, renombrado 2026-11-08). Devuelve { text,
// confidence }: la confianza es la del mejor alternative (0..1) o null
// si la respuesta no la trae — stt.js la usa para el reintento §2e.
export async function transcribeDeepgram(wavBase64) {
  // 'auto' (default): detect_language del lado Deepgram — el usuario mezcla
  // ES/EN y forzar un idioma hace que el otro salga basura ('and' por una
  // frase en español, visto 2026-11-08). Verificado Nova-3 200 OK.
  const sttLang = String(getSttLanguage() || 'auto').toLowerCase();
  const params = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    ...(sttLang.startsWith('auto') ? { detect_language: 'true' } : { language: sttLang }),
    smart_format: 'true',
    punctuate: 'true',
    keyterms: 'Pablo:2'
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'audio/wav', Accept: 'application/json' }),
    body: Buffer.from(wavBase64, 'base64'),
    signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Deepgram STT HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const body = await response.json();
  const alt = body?.results?.channels?.[0]?.alternatives?.[0];
  const confidence = (typeof alt?.confidence === 'number' && Number.isFinite(alt.confidence))
    ? alt.confidence
    : null;
  return { text: String(alt?.transcript || '').trim(), confidence };
}

// Sintetiza una oración. Devuelve [{ data: base64 PCM 16k, mimeType }] en
// el mismo formato que Supertonic, listo para el SpeakerGate.
export async function synthesizeDeepgram(text, voice) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return [];
  }
  const params = new URLSearchParams({
    model: mapVoiceToDeepgram(voice),
    encoding: 'linear16',
    container: 'none',
    sample_rate: '16000'
  });
  const response = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'audio/*' }),
    body: JSON.stringify({ text: clean.slice(0, 2000) }),
    signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Deepgram TTS HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length < 100) {
    throw new Error('Deepgram returned empty audio.');
  }
  return [{ data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' }];
}
