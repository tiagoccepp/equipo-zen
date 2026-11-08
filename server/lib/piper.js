// Adaptador del TTS local Piper (sidecar server/tts/piper_server.py :7791).
// 25-300ms por oración en CPU (ver .audit/piper/PIPER-EVAL.md): va PRIMERO
// en la cadena de voz porque latencia 0 manda. F* → daniela (femenina
// rioplatense), M* → sharvard (masculina). Si el sidecar no responde,
// la cadena sigue con Supertonic → Deepgram → Edge como siempre.
import { TTS_TIMEOUT_MS } from './config.js';

const PIPER_URL = process.env.PIPER_URL || 'http://127.0.0.1:7791';

export function mapVoiceToPiper(voice) {
  const v = String(voice || '').trim().toUpperCase();
  if (v.startsWith('F')) {
    return 'daniela';
  }
  return 'sharvard';
}

let availability = { checked: 0, ok: false };

export async function isPiperAvailable() {
  if (Date.now() - availability.checked < 15000) {
    return availability.ok;
  }
  try {
    const response = await fetch(`${PIPER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    availability = { checked: Date.now(), ok: response.ok };
  } catch {
    availability = { checked: Date.now(), ok: false };
  }
  return availability.ok;
}

// Extrae el PCM del WAV leyendo los chunks RIFF de verdad.
function wavToPcm(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x52494646) { // 'RIFF'
    throw new Error('Piper no devolvió un WAV.');
  }
  let offset = 12;
  let sampleRate = 16000;
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
  throw new Error('WAV sin chunk data.');
}

// Sintetiza una oración. Devuelve [{ data: base64 PCM, mimeType }] o []
// si el texto está vacío. Si el sidecar no responde, lanza (la cadena cae
// al siguiente TTS).
export async function synthesizePiper(text, voice, { signal } = {}) {
  const clean = String(text || '').trim();
  if (!clean) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout de Piper')), TTS_TIMEOUT_MS);
  const abortListener = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    const response = await fetch(`${PIPER_URL}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice: mapVoiceToPiper(voice) }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Piper HTTP ${response.status}: ${detail.slice(0, 200)}`);
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
