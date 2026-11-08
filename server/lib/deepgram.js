// Deepgram cloud: STT Nova-3 + TTS Aura-2 (español).
// STT REST ~2.3s y TTS REST ~2.4s medidos desde Uruguay 2026-11-08: más
// lentos que el local (Parakeet 0.4s / Supertonic 1.7s) por el viaje de red
// (~1.1s solo conectar). Su valor: calidad (smart_format, keyterms,
// voces Aura), nube (donde el local no entra, ej. Render) y futuro
// streaming WS + diarización. Auth: `Token KEY` (no Bearer).

import { getDeepgramKey, getSttLanguage } from './settings.js';

export const DEEPGRAM_STT_MODEL = 'nova-3';
const DEEPGRAM_TIMEOUT_MS = 25000;

// Voces Aura-2 español verificadas 2026-11-08 (las 5 es + codeswitch EN-ES:
// Aquila, Carina, Diana, Javier, Selena).
export const DEEPGRAM_TTS_VOICES = {
  M: 'aura-2-javier-es',
  F: 'aura-2-selena-es'
};

// Supertonic M1-M5/F1-F5 → voz Aura equivalente por género.
export function mapVoiceToDeepgram(supertonicVoice) {
  const v = String(supertonicVoice || '').trim().toUpperCase();
  return v.startsWith('F') ? DEEPGRAM_TTS_VOICES.F : DEEPGRAM_TTS_VOICES.M;
}

function authHeaders(extra = {}) {
  const key = getDeepgramKey();
  if (!key) {
    throw new Error('Falta la clave de Deepgram (stt.deepgramKey).');
  }
  return { Authorization: `Token ${key}`, ...extra };
}

// Transcribe un WAV 16kHz (base64). Nova-3 + español + formato
// inteligente + keyterm "Sofia" para que el nombre propio entre siempre.
export async function transcribeDeepgram(wavBase64) {
  const params = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    language: getSttLanguage(),
    smart_format: 'true',
    punctuate: 'true',
    keyterms: 'Sofia:2'
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
  return String(alt?.transcript || '').trim();
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
    throw new Error('Deepgram devolvió audio vacío.');
  }
  return [{ data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' }];
}
