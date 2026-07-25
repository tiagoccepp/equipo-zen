import {
  MINIMAX_MODEL,
  MINIMAX_MODELS,
  SUPERTONIC_LANGUAGE,
  SUPERTONIC_URL,
  collectApiKeys,
  uniqueModelList
} from './config.js';

// Ajustes del usuario (sección Settings de la UI): viven en SQLite y
// SOBREESCRIBEN a las variables de entorno. Los módulos leen SIEMPRE por
// estos getters, así los cambios aplican en caliente sin reiniciar.

export const MINIMAX_MODEL_OPTIONS = ['MiniMax-M2', 'MiniMax-M2.1', 'MiniMax-M2.5', 'MiniMax-M2.7', 'MiniMax-M3'];
export const WHISPER_MODEL_OPTIONS = ['base', 'small', 'medium', 'large-v3-turbo'];
export const STT_PROVIDERS = ['local', 'groq', 'browser'];
export const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
export const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:7789';

let store = null;
let keyRing = null;

export function initSettings(storeInstance, keyRingInstance) {
  store = storeInstance;
  keyRing = keyRingInstance;
  keyRing.setKeys(getMinimaxKeys());
}

function dbValue(key) {
  return store?.getSetting(key) ?? null;
}

// ── LLM (MiniMax) ────────────────────────────────────────────────────────

export function getMinimaxKeys() {
  const fromDb = dbValue('llm.apiKey');
  if (fromDb) {
    return [fromDb];
  }
  return collectApiKeys();
}

export function getMinimaxModels() {
  const chosen = dbValue('llm.model') || MINIMAX_MODEL;
  return uniqueModelList([chosen, ...MINIMAX_MODELS]);
}

// ── STT (oído) ───────────────────────────────────────────────────────────

export function getSttProvider() {
  const value = dbValue('stt.provider');
  return STT_PROVIDERS.includes(value) ? value : 'local';
}

export function getWhisperModel() {
  const value = dbValue('stt.whisperModel');
  return WHISPER_MODEL_OPTIONS.includes(value) ? value : (process.env.WHISPER_MODEL || 'small');
}

export function getGroqKey() {
  return dbValue('stt.groqKey') || process.env.GROQ_API_KEY || '';
}

export function getSttLanguage() {
  return dbValue('stt.language') || 'es';
}

// ── TTS (voz) ────────────────────────────────────────────────────────────

export function getTtsLanguage() {
  return dbValue('tts.language') || SUPERTONIC_LANGUAGE;
}

export function getTtsUrl() {
  return dbValue('tts.url') || SUPERTONIC_URL;
}

// ── Lectura/escritura desde la UI ───────────────────────────────────────

const EDITABLE_KEYS = new Set([
  'llm.apiKey',
  'llm.model',
  'stt.provider',
  'stt.whisperModel',
  'stt.groqKey',
  'stt.language',
  'tts.language'
]);

const SECRET_KEYS = new Set(['llm.apiKey', 'stt.groqKey']);

function mask(value) {
  if (!value) {
    return '';
  }
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

// Vista segura para GET /api/settings: nunca devuelve secretos completos.
export function publicSettings() {
  return {
    llm: {
      provider: 'minimax',
      apiKeySet: getMinimaxKeys().length > 0,
      apiKeyMasked: mask(getMinimaxKeys()[0] || ''),
      model: getMinimaxModels()[0],
      modelOptions: MINIMAX_MODEL_OPTIONS
    },
    stt: {
      provider: getSttProvider(),
      providerOptions: STT_PROVIDERS,
      whisperModel: getWhisperModel(),
      whisperModelOptions: WHISPER_MODEL_OPTIONS,
      groqKeySet: Boolean(getGroqKey()),
      groqKeyMasked: mask(getGroqKey()),
      language: getSttLanguage()
    },
    tts: {
      engine: 'supertonic',
      language: getTtsLanguage(),
      url: getTtsUrl()
    }
  };
}

// Aplica un patch { 'llm.apiKey': '...', ... }. Valores vacíos borran el
// override (se vuelve al valor de entorno/default).
export function applySettings(patch) {
  const applied = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!EDITABLE_KEYS.has(key)) {
      continue;
    }
    const value = String(raw ?? '').trim();
    if (key === 'llm.model' && value && !MINIMAX_MODEL_OPTIONS.includes(value)) {
      continue;
    }
    if (key === 'stt.provider' && value && !STT_PROVIDERS.includes(value)) {
      continue;
    }
    if (key === 'stt.whisperModel' && value && !WHISPER_MODEL_OPTIONS.includes(value)) {
      continue;
    }
    if (value) {
      store.setSetting(key, value);
    } else {
      store.deleteSetting(key);
    }
    applied.push(key);
    if (!SECRET_KEYS.has(key)) {
      store.logChange('user', 'setting', key, 'update', { value });
    } else {
      store.logChange('user', 'setting', key, 'update', { value: mask(value) });
    }
  }

  if (applied.includes('llm.apiKey')) {
    keyRing.setKeys(getMinimaxKeys());
  }
  return applied;
}
