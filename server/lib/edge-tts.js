// TTS cloud keyless vía Microsoft Edge (paquete node-edge-tts, sin API key).
// Fallback cuando Supertonic local no responde (ej. demo en la nube, donde
// los modelos no entran en RAM): el servidor sintetiza MP3 por oración y el
// cliente lo decodifica con Web Audio. Si Edge falla, el cliente cae a
// speechSynthesis (timeout) — la cadena nunca se rompe.
import { createRequire } from 'node:module';
import { getTtsLanguage } from './settings.js';

const require = createRequire(import.meta.url);

const EDGE_VOICES = {
  es: { M: 'es-ES-AlvaroNeural', F: 'es-ES-ElviraNeural', lang: 'es-ES' },
  en: { M: 'en-US-AndrewNeural', F: 'en-US-AvaNeural', lang: 'en-US' }
};

// Idioma configurado (tts.language): 'en*' usa las voces en-US.
function edgeTable() {
  return String(getTtsLanguage() || 'es').toLowerCase().startsWith('en') ? EDGE_VOICES.en : EDGE_VOICES.es;
}
const DEFAULT_EDGE_VOICE = 'es-ES-AlvaroNeural';
const EDGE_TIMEOUT_MS = 20000;
const MAX_EDGE_CHARS = 2000;

// Supertonic M1-M5/F1-F5 → voz Edge equivalente por género, en el idioma
// configurado (tts.language).
export function mapVoiceToEdge(supertonicVoice) {
  const table = edgeTable();
  const v = String(supertonicVoice || '').trim().toUpperCase();
  if (v.startsWith('F')) {
    return table.F;
  }
  return table.M;
}

// Valida magia MP3: tag ID3 o frame-sync MPEG (0xFF + 3 bits altos).
export function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 4) {
    return false;
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) {
    return true;
  }
  return b0 === 0xff && (b1 & 0xe0) === 0xe0;
}

let cachedCtor = null;
let loadFailed = false;

function edgeCtor() {
  if (cachedCtor) {
    return cachedCtor;
  }
  if (loadFailed) {
    return null;
  }
  try {
    cachedCtor = require('node-edge-tts').EdgeTTS || null;
  } catch {
    loadFailed = true;
    return null;
  }
  if (!cachedCtor) {
    loadFailed = true;
  }
  return cachedCtor;
}

export async function synthesizeEdgeMp3(text, { voice = 'M1', timeoutMs = EDGE_TIMEOUT_MS } = {}) {
  const Ctor = edgeCtor();
  if (!Ctor) {
    throw new Error('edge-tts no instalado');
  }
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EDGE_CHARS);
  if (!clean) {
    throw new Error('texto vacío');
  }
  const tts = new Ctor({ voice: mapVoiceToEdge(voice), lang: edgeTable().lang, timeout: timeoutMs });
  const chunks = [];
  for await (const chunk of tts.streamAudio(clean)) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
    // subLine (word boundaries): se ignoran, solo importa el audio.
  }
  const audio = Buffer.concat(chunks);
  if (!looksLikeMp3(audio)) {
    throw new Error('Edge devolvió audio inválido');
  }
  return { data: audio.toString('base64'), mimeType: 'audio/mpeg' };
}
