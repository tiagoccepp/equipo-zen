import { TTS_TIMEOUT_MS } from './config.js';
import { getTtsLanguage, getTtsUrl } from './settings.js';

// Adaptador del TTS local Supertonic (supertone-inc/supertonic, servido por
// `supertonic serve`). Devuelve PCM crudo listo para el SpeakerGate; todo
// corre en la máquina: sin nube, sin costo, sin claves.

export const SUPERTONIC_VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'];

// Migración desde las voces Gemini que pudieran quedar en la DB.
export const LEGACY_VOICE_MAP = {
  Charon: 'M1',
  Fenrir: 'M2',
  Aoede: 'F1',
  Puck: 'F2',
  Kore: 'F3'
};

export function normalizeVoice(voice) {
  if (SUPERTONIC_VOICES.includes(voice)) {
    return voice;
  }
  return LEGACY_VOICE_MAP[voice] || 'M1';
}

let availability = { checked: 0, ok: false };

export async function isAvailable() {
  if (Date.now() - availability.checked < 15000) {
    return availability.ok;
  }
  try {
    const response = await fetch(`${getTtsUrl()}/docs`, { signal: AbortSignal.timeout(1500) });
    availability = { checked: Date.now(), ok: response.ok };
  } catch {
    availability = { checked: Date.now(), ok: false };
  }
  return availability.ok;
}

// Extrae el PCM del WAV leyendo los chunks RIFF de verdad (el header no
// siempre mide 44 bytes).
function wavToPcm(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646) { // 'RIFF'
    throw new Error('Supertonic returned no WAV.');
  }
  let offset = 12;
  let sampleRate = 44100;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420) { // 'fmt '
      sampleRate = view.getUint32(offset + 12, true);
    } else if (chunkId === 0x64617461) { // 'data'
      const pcm = buffer.slice(offset + 8, offset + 8 + chunkSize);
      return { pcm, sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV with no data chunk.');
}

// Sintetiza una oración. Devuelve [{ data: base64 PCM, mimeType }] o []
// si el servicio local no está disponible (la reunión sigue sin voz).
export async function synthesize(text, voice, { signal, speed } = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout de Supertonic')), TTS_TIMEOUT_MS);
  const abortListener = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    const response = await fetch(`${getTtsUrl()}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        voice: normalizeVoice(voice),
        lang: getTtsLanguage(),
        response_format: 'wav',
        ...(speed ? { speed } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supertonic HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    const { pcm, sampleRate } = wavToPcm(await response.arrayBuffer());
    availability = { checked: Date.now(), ok: true };
    return [{
      data: Buffer.from(pcm).toString('base64'),
      mimeType: `audio/pcm;rate=${sampleRate}`
    }];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
  }
}
