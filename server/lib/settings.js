import {
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDERS,
  SUPERTONIC_LANGUAGE,
  SUPERTONIC_URL,
  collectProviderKeys,
  uniqueModelList
} from './config.js';

// Ajustes del usuario (sección Settings de la UI): viven en SQLite y
// SOBREESCRIBEN a las variables de entorno. Los módulos leen SIEMPRE por
// estos getters, así los cambios aplican en caliente sin reiniciar.

// Lo que ofrece el desplegable sale de los proveedores, no de una copia: así la
// lista contra la que se valida al GUARDAR y la lista contra la que se valida al
// LEER son literalmente la misma, y no puede volver a pasar que un modelo entre
// por la UI y después el servidor lo ignore.
export const LLM_MODEL_OPTIONS = Object.fromEntries(
  Object.values(LLM_PROVIDERS).map((provider) => [provider.id, provider.models])
);
export const MINIMAX_MODEL_OPTIONS = LLM_MODEL_OPTIONS.minimax;
export const DEEPSEEK_MODEL_OPTIONS = LLM_MODEL_OPTIONS.deepseek;
export const OPENCODE_MODEL_OPTIONS = LLM_MODEL_OPTIONS.opencode;
export const WHISPER_MODEL_OPTIONS = ['base', 'small', 'medium', 'large-v3-turbo'];
export const STT_PROVIDERS = ['local', 'groq', 'deepgram', 'browser'];
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

// ── LLM: MiniMax o DeepSeek ──────────────────────────────────────────────
//
// Los dos hablan el formato de OpenAI, así que cambiar de proveedor es
// cambiar a dónde apunta el cliente, con qué clave y con qué modelos.

export function getLlmProvider() {
  const value = dbValue('llm.provider');
  return LLM_PROVIDERS[value] ? value : DEFAULT_LLM_PROVIDER;
}

export function getLlmProviderConfig() {
  return LLM_PROVIDERS[getLlmProvider()];
}

export function getLlmKeys(providerId = getLlmProvider()) {
  const provider = LLM_PROVIDERS[providerId];
  if (!provider) {
    return [];
  }
  const fromDb = dbValue(provider.settingKey);
  if (fromDb) {
    return [fromDb];
  }
  return collectProviderKeys(providerId);
}

export function getLlmModels() {
  const provider = getLlmProviderConfig();
  const chosen = dbValue('llm.model');
  // El modelo elegido solo vale si es de este proveedor: al cambiar de
  // proveedor no se arrastra un nombre que el otro no conoce.
  const valido = chosen && provider.models.includes(chosen) ? chosen : provider.defaultModel;
  return uniqueModelList([valido, ...provider.models]);
}

// Nombres viejos, para no romper lo que ya los usa.
export const getMinimaxKeys = getLlmKeys;
export const getMinimaxModels = getLlmModels;

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

export function getDeepgramKey() {
  return dbValue('stt.deepgramKey') || process.env.DEEPGRAM_API_KEY || '';
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
  'llm.provider',
  'llm.apiKey',
  'llm.deepseekKey',
  'llm.opencodeKey',
  'llm.groqKey',
  'llm.model',
  'stt.provider',
  'stt.whisperModel',
  'stt.groqKey',
  'stt.deepgramKey',
  'stt.language',
  'tts.language'
]);

const SECRET_KEYS = new Set(['llm.apiKey', 'llm.deepseekKey', 'llm.opencodeKey', 'llm.groqKey', 'stt.groqKey', 'stt.deepgramKey']);

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
      provider: getLlmProvider(),
      providerOptions: Object.values(LLM_PROVIDERS).map(({ id, label }) => ({ id, label })),
      // La clave de cada proveedor se guarda por separado: cambiar de uno a
      // otro y volver no obliga a pegarla de nuevo.
      apiKeySet: getLlmKeys('minimax').length > 0,
      apiKeyMasked: mask(getLlmKeys('minimax')[0] || ''),
      deepseekKeySet: getLlmKeys('deepseek').length > 0,
      deepseekKeyMasked: mask(getLlmKeys('deepseek')[0] || ''),
      opencodeKeySet: getLlmKeys('opencode').length > 0,
      opencodeKeyMasked: mask(getLlmKeys('opencode')[0] || ''),
      model: getLlmModels()[0],
      modelOptions: LLM_MODEL_OPTIONS[getLlmProvider()] || MINIMAX_MODEL_OPTIONS
    },
    stt: {
      provider: getSttProvider(),
      providerOptions: STT_PROVIDERS,
      whisperModel: getWhisperModel(),
      whisperModelOptions: WHISPER_MODEL_OPTIONS,
      groqKeySet: Boolean(getGroqKey()),
      groqKeyMasked: mask(getGroqKey()),
      deepgramKeySet: Boolean(getDeepgramKey()),
      deepgramKeyMasked: mask(getDeepgramKey()),
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
    // El modelo se valida contra CUALQUIER proveedor conocido: el patch puede
    // traer proveedor y modelo juntos, y el orden de las claves no debe decidir
    // si el modelo entra o se descarta.
    if (key === 'llm.model' && value && !Object.values(LLM_MODEL_OPTIONS).flat().includes(value)) {
      continue;
    }
    if (key === 'llm.provider' && value && !LLM_PROVIDERS[value]) {
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

  if (applied.some((key) => key === 'llm.apiKey' || key === 'llm.deepseekKey' || key === 'llm.opencodeKey' || key === 'llm.provider')) {
    keyRing.setKeys(getMinimaxKeys());
  }
  return applied;
}
