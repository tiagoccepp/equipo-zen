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
export const WHISPER_MODEL_OPTIONS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo'];
// Motor TTS local preferido: 'auto' = cadena actual (Piper → Supertonic),
// 'piper'/'supertonic' fuerzan el orden (el otro queda de respaldo). El Deepgram
// con key siempre va primero (override cloud, ver agent-runtime).
export const TTS_ENGINE_OPTIONS = ['auto', 'piper', 'supertonic'];
// Motores direccionables por tts.order (espejo de stt.order): la cascada
// TTS se recorre en ese orden y SOLO los listados se intentan. 'edge'
// resuelve en speakSentence (path MP3); el resto en generateAudioParts.
export const TTS_ENGINES = ['piper', 'supertonic', 'deepgram', 'edge'];
export const STT_PROVIDERS = ['local', 'groq', 'deepgram', 'browser'];
// Motores direccionables por stt.order (la cadena STT se recorre en ese
// orden; local = parakeet+whisper partible). El hint del navegador es
// red final implícita, no un motor.
export const STT_ENGINES = ['parakeet', 'whisper', 'groq', 'deepgram'];
export const DEFAULT_STT_ORDER = 'parakeet,groq,deepgram';
export const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
export const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:7789';

let store = null;
let keyRing = null;

export function initSettings(storeInstance, keyRingInstance) {
  store = storeInstance;
  keyRing = keyRingInstance;
  keyRing.setKeys(getMinimaxKeys());
}

export function dbValue(key) {
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

// E-14: modelos por proveedor (llm.models = CSV custom SOLO para el
// activo; el resto usa su lista curada). "Todos sus modelos" = curados +
// custom pegable.
export function getLlmModelsFor(providerId) {
  const provider = LLM_PROVIDERS[providerId];
  if (!provider) {
    return [];
  }
  if (providerId === getLlmProvider()) {
    const custom = String(dbValue('llm.models') || '').split(',')
      .map((m) => m.trim()).filter(Boolean);
    if (custom.length > 0) {
      return uniqueModelList(custom);
    }
  }
  const chosen = dbValue('llm.model');
  const valido = chosen && provider.models.includes(chosen) ? chosen : provider.defaultModel;
  return uniqueModelList([valido, ...provider.models]);
}

export function getLlmModels() {
  return getLlmModelsFor(getLlmProvider());
}

// A-10: tiers por complejidad — strong (lead, default primero) y fast
// (workers chicos: saludos, router, acks; default último).
export function getStrongModel() {
  const custom = String(dbValue('llm.strong') || '').trim();
  if (custom) {
    return custom;
  }
  return getLlmModels()[0];
}

export function getFastModel() {
  const custom = String(dbValue('llm.fast') || '').trim();
  if (custom) {
    return custom;
  }
  const list = getLlmModels();
  return list[list.length - 1];
}

export function modelsForTier(tier) {
  const all = getLlmModels();
  if (tier === 'fast') {
    return [getFastModel(), ...all.filter((m) => m !== getFastModel())];
  }
  if (tier === 'strong') {
    return [getStrongModel(), ...all.filter((m) => m !== getStrongModel())];
  }
  return all;
}

// E-14: orden de failover — activo primero, luego llm.failover (válidos con
// llaves), luego el resto con llaves. Sin llaves = fuera.
export function getFailoverOrder() {
  const active = getLlmProvider();
  const wanted = String(dbValue('llm.failover') || '').split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== active && LLM_PROVIDERS[p] && getLlmKeys(p).length > 0);
  const rest = Object.keys(LLM_PROVIDERS)
    .filter((p) => p !== active && !wanted.includes(p) && getLlmKeys(p).length > 0);
  return [active, ...wanted, ...rest];
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
  // 09/11: default tiny (era small). Whisper es el último fallback local y el
  // box vive al 96% de RAM: tiny-int8 (~200M cargado) transcribe igual y no
  // swapea; small/base/medium siguen elegibles en Ajustes.
  return WHISPER_MODEL_OPTIONS.includes(value) ? value : (process.env.WHISPER_MODEL || 'tiny');
}

export function getGroqKey() {
  return dbValue('stt.groqKey') || process.env.GROQ_API_KEY || '';
}

export function getDeepgramKey() {
  return dbValue('stt.deepgramKey') || process.env.DEEPGRAM_API_KEY || '';
}

export function getSttLanguage() {
  return dbValue('stt.language') || 'auto';
}

// Orden de la cadena STT (CSV de motores, ej. 'parakeet,groq,deepgram'):
// define en qué secuencia se intentan los motores con fallbacks.
// Sin override, respeta el legacy stt.provider (groq/deepgram/browser
// fijan cabeza); provider=local (default) → DEFAULT_STT_ORDER.
export function getSttOrder() {
  const raw = dbValue('stt.order');
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const parsed = parseSttOrder(String(raw));
    if (parsed.length > 0) {
      return parsed;
    }
  }
  const provider = getSttProvider();
  if (provider === 'groq') {
    return ['groq', 'deepgram'];
  }
  if (provider === 'deepgram') {
    return ['deepgram', 'groq']; // Legacy: deepgram caído probaba groq.
  }
  if (provider === 'browser') {
    return [];
  }
  return parseSttOrder(DEFAULT_STT_ORDER);
}

// ¿Hay override explícito de stt.order en DB? (transcribeTurn lo usa
// para decidir legacy-browser vs order.)
export function isSttOrderSet() {
  const raw = dbValue('stt.order');
  return raw !== null && raw !== undefined && String(raw).trim() !== '';
}

export function parseSttOrder(csv) {
  const seen = new Set();
  const out = [];
  for (const token of String(csv || '').split(',')) {
    const engine = token.trim().toLowerCase();
    // Alias legacy: 'local' = los dos motores locales en orden clásico.
    const expanded = engine === 'local' ? ['parakeet', 'whisper'] : [engine];
    for (const e of expanded) {
      if (STT_ENGINES.includes(e) && !seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out;
}

// Umbral de confianza STT (0..1, default 0.55): debajo de min(setting,
// 0.4) con turno corto y key de Deepgram, stt.js reintenta una vez en
// la nube (§2e mínimo).
export function getSttMinConfidence() {
  const raw = dbValue('stt.minConfidence');
  if (raw === null || raw === undefined || raw === '') {
    return 0.55;
  }
  const value = Number(raw);
  return (Number.isFinite(value) && value >= 0 && value <= 1) ? value : 0.55;
}

// ── TTS (voz) ────────────────────────────────────────────────────────────

export function getTtsLanguage() {
  return dbValue('tts.language') || SUPERTONIC_LANGUAGE;
}

export function getTtsEngine() {
  const value = dbValue('tts.engine');
  if (TTS_ENGINE_OPTIONS.includes(value)) {
    return value;
  }
  const fromEnv = String(process.env.TTS_ENGINE || '').trim().toLowerCase();
  return TTS_ENGINE_OPTIONS.includes(fromEnv) ? fromEnv : 'auto';
}

// Orden de los motores LOCALES según tts.engine. Pura (testeable sin red
// ni settings): 'supertonic' invierte el default, el resto mantiene
// Piper → Supertonic.
export function ttsLocalOrder(engine = 'auto') {
  return engine === 'supertonic' ? ['supertonic', 'piper'] : ['piper', 'supertonic'];
}

// Default del tts.order = legacy byte a byte: Deepgram-con-key primero
// (override cloud), luego locales según tts.engine, Edge último. Sin key
// Deepgram se salta → local-first keyless (Piper primero).
export function defaultTtsOrder(engine = getTtsEngine()) {
  return ['deepgram', ...ttsLocalOrder(engine), 'edge'];
}

// Orden de la cascada TTS (CSV de motores, espejo de stt.order): define
// en qué secuencia se intentan y —diferencia con el legacy— SOLO los
// listados se intentan (elegido manda, resto out). Sin override, respeta
// el legacy tts.engine vía defaultTtsOrder.
export function getTtsOrder() {
  const raw = dbValue('tts.order');
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const parsed = parseTtsOrder(String(raw));
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return defaultTtsOrder();
}

// ¿Hay override explícito de tts.order en DB? (el watchdog lo usa para
// decidir elección explícita vs default legacy parakeet+piper.)
export function isTtsOrderSet() {
  const raw = dbValue('tts.order');
  return raw !== null && raw !== undefined && String(raw).trim() !== '';
}

export function parseTtsOrder(csv) {
  const seen = new Set();
  const out = [];
  for (const token of String(csv || '').split(',')) {
    const engine = token.trim().toLowerCase();
    if (TTS_ENGINES.includes(engine) && !seen.has(engine)) {
      seen.add(engine);
      out.push(engine);
    }
  }
  return out;
}

export function getTtsUrl() {
  const explicit = dbValue('tts.url') || null;
  if (explicit) {
    return explicit;
  }
  if (getSplitMode() === 'split' && getSplitVps()) {
    return `${getSplitVps()}:7788`;
  }
  return SUPERTONIC_URL;
}

// E-16: velocidad de habla 0.5..2.0 (default 1.0). Aplica en motores que la
// soportan (Supertonic hoy; resto la ignora).
export function getTtsSpeed() {
  const raw = dbValue('tts.speed');
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return 1.0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 1.0;
  }
  return Math.min(2.0, Math.max(0.5, n));
}

export function getPiperUrl() {
  const explicit = dbValue('tts.piperUrl') || process.env.PIPER_URL || null;
  if (explicit) {
    return explicit;
  }
  if (getSplitMode() === 'split' && getSplitVps()) {
    return `${getSplitVps()}:7791`;
  }
  return 'http://127.0.0.1:7791';
}

export function getParakeetUrl() {
  const explicit = process.env.PARAKEET_URL || null;
  if (explicit) {
    return explicit;
  }
  if (getSplitMode() === 'split' && getSplitVps()) {
    return `${getSplitVps()}:7790`;
  }
  return 'http://127.0.0.1:7790';
}

export function getWhisperUrl() {
  const explicit = process.env.WHISPER_URL || null;
  if (explicit) {
    return explicit;
  }
  if (getSplitMode() === 'split' && getSplitVps()) {
    return `${getSplitVps()}:7789`;
  }
  return WHISPER_URL;
}

// E-20: split local+VPS.
export function getSplitMode() {
  const v = String(dbValue('split.mode') || '').trim().toLowerCase();
  return v === 'split' ? 'split' : 'local';
}

export function getSplitVps() {
  return String(dbValue('split.vps') || process.env.SPLIT_VPS || '').trim().replace(/\/+$/, '');
}

// E-18: canal de notificaciones (telegram|whatsapp|none) + voz + destino.
export function getNotifyChannel() {
  const v = String(dbValue('notify.channel') || '').trim().toLowerCase();
  return ['telegram', 'whatsapp'].includes(v) ? v : 'none';
}

export function getNotifyVoice() {
  const v = String(dbValue('notify.voice') ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

export function getNotifyTo() {
  return String(dbValue('notify.to') || '').trim();
}

// E-17: modo de energía (env EQUIPO_ENERGY_MODE gana si vino del autostart).
export function getEnergyMode() {
  const fromEnv = String(process.env.EQUIPO_ENERGY_MODE || '').trim().toLowerCase();
  if (['always-on', 'gate', 'manual'].includes(fromEnv)) {
    return fromEnv;
  }
  const v = String(dbValue('energy.mode') || '').trim().toLowerCase();
  return ['always-on', 'gate', 'manual'].includes(v) ? v : 'manual';
}

// ── Manos (tools en vivo, two-phase) ─────────────────────────────────────
// Sin UI en v1: las claves se ajustan vía PATCH /api/settings directo o
// defaults. Se exponen en publicSettings/EDITABLE_KEYS para que la API y
// futuros controles las vean sin tocar este módulo.

export function getManosEnabled() {
  const raw = dbValue('manos.enabled');
  if (raw === null || raw === undefined || raw === '') {
    return true;
  }
  const value = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  return true;
}

export function getManosMaxTurns() {
  const raw = dbValue('manos.maxTurns');
  if (raw === null || raw === undefined || raw === '') {
    return 6;
  }
  const value = Number(raw);
  return (Number.isInteger(value) && value >= 1 && value <= 12) ? value : 6;
}

// ── Sala (equipo v1: gate + consulta silenciosa) ─────────────────────────
// Sin UI en v1: flag + timeout vía PATCH /api/settings o defaults.

export function getSalaV1() {
  const raw = dbValue('sala.v1');
  if (raw === null || raw === undefined || raw === '') {
    return false;
  }
  const value = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

export function getSalaTimeoutMs() {
  const raw = dbValue('sala.timeoutMs');
  if (raw === null || raw === undefined || raw === '') {
    return 15000;
  }
  const value = Number(raw);
  return (Number.isFinite(value) && value >= 1000 && value <= 60000) ? value : 15000;
}

// ── Sala v2: discusión ordenada (rondas + síntesis) ────────────────────────
// Flag default OFF: con v2 off el comportamiento es v1 byte a byte.
// SOP: texto editable vía PATCH /api/settings; sala.js lo parsea (knobs) y
// lo inyecta como reglas a los especialistas.

export const DEFAULT_SOP = [
  'S1 una sola voz: solo Pablo habla con Tito; especialistas escriben en sala.',
  'S2 gate antes de sala: default Pablo solo; sala solo con trade-off, multi-oficio u objecion abierta.',
  'S3 encuadre: pregunta + criterio de exito antes de R1; pedido difuso -> 1 pregunta a Tito.',
  'S4 orden fijo: R1 por score desc, R2 inverso; 1 mensaje por voz por ronda; formato APORTE/DISENSO.',
  'S5 SILENCIO es valido; SILENCIO con [TAREA_*] igual crea la tarea.',
  'S6 disenso con propuesta: objetar sin alternativa se descarta.',
  'S7 Pablo decide: sin consenso en 2 rondas, voto de calidad; no vuelve a Tito salvo irreversible.',
  'S8 un dueno por tarea.',
  'S9 irreversibles a Tito: borrar/enviar/gastar/publicar/credenciales -> esperar el si.',
  'S10 topes: max 2 rondas, especialista caido >20s = ausente, se sigue; la sala jamas cuelga el turno.',
  'S11 acta minima: pregunta, decision, duenos, riesgo.',
  'S12 verbosidad de Tito manda (quiet/normal/verbose).',
  'order: score-desc',
  'max_rounds: 2',
  'agent_timeout_ms: 20000',
  'r2: on-disagreement'
].join('\n');

export function getSalaV2() {
  const raw = dbValue('sala.v2');
  if (raw === null || raw === undefined || raw === '') {
    return false;
  }
  const value = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

export function getSalaSop() {
  const raw = dbValue('sala.sop');
  if (raw === null || raw === undefined || raw === '') {
    return DEFAULT_SOP;
  }
  return String(raw);
}

export function getSalaAgentTimeoutMs() {
  const raw = dbValue('sala.agentTimeoutMs');
  if (raw === null || raw === undefined || raw === '') {
    return 20000;
  }
  const value = Number(raw);
  return (Number.isFinite(value) && value >= 1000 && value <= 60000) ? value : 20000;
}

// ── Llamada grupal: réplicas entre agentes (R2 + cierre CEO) ────────────────
// Flag default OFF: con off el turno es byte a byte el de siempre.
export function getSalaGroupchat() {
  const raw = dbValue('sala.groupchat');
  if (raw === null || raw === undefined || raw === '') {
    return false;
  }
  const value = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

// ── Audio (routing PipeWire: salida/entrada) ────────────────────────────
// 'default' = seguir el default del sistema. followDefault=true (default)
// = no tocar nada: los streams siguen al sistema solos.

export function getAudioOutput() {
  return dbValue('audio.output') || 'default';
}

export function getAudioInput() {
  return dbValue('audio.input') || 'default';
}

export function getAudioFollowDefault() {
  const raw = dbValue('audio.followDefault');
  if (raw === null || raw === undefined || raw === '') {
    return true;
  }
  const value = String(raw).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

// ── Lectura/escritura desde la UI ───────────────────────────────────────

const EDITABLE_KEYS = new Set([
  'llm.provider',
  'llm.apiKey',
  'llm.deepseekKey',
  'llm.opencodeKey',
  'llm.groqKey',
  'llm.model',
  'llm.models',
  'llm.failover',
  'llm.strong',
  'llm.fast',
  'channels.telegram.enabled',
  'channels.telegram.botToken',
  'channels.telegram.titoId',
  'channels.telegram.mode',
  'channels.telegram.allow',
  'channels.telegram.autoRespond',
  'channels.whatsapp.enabled',
  'channels.whatsapp.token',
  'channels.whatsapp.phoneId',
  'channels.whatsapp.titoId',
  'channels.whatsapp.mode',
  'channels.whatsapp.allow',
  'stt.provider',
  'stt.order',
  'stt.whisperModel',
  'stt.groqKey',
  'stt.deepgramKey',
  'stt.language',
  'stt.minConfidence',
  'tts.language',
  'tts.engine',
  'tts.order',
  'tts.speed',
  'tts.piperUrl',
  'tts.url',
  'manos.enabled',
  'manos.maxTurns',
  'sala.v1',
  'sala.timeoutMs',
  'sala.v2',
  'sala.sop',
  'sala.agentTimeoutMs',
  'sala.groupchat',
  'audio.output',
  'audio.input',
  'audio.followDefault',
  'energy.mode',
  'notify.channel',
  'notify.voice',
  'notify.to',
  'split.mode',
  'split.vps'
]);

const SECRET_KEYS = new Set(['llm.apiKey', 'llm.deepseekKey', 'llm.opencodeKey', 'llm.groqKey', 'stt.groqKey', 'stt.deepgramKey', 'channels.telegram.botToken', 'channels.whatsapp.token']);

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
      groqKeySet: getLlmKeys('groq').length > 0,
      groqKeyMasked: mask(getLlmKeys('groq')[0] || ''),
      model: getLlmModels()[0],
      modelOptions: LLM_MODEL_OPTIONS[getLlmProvider()] || MINIMAX_MODEL_OPTIONS,
      customModels: dbValue('llm.models') || '',
      failover: dbValue('llm.failover') || '',
      failoverResolved: getFailoverOrder()
    },
    stt: {
      provider: getSttProvider(),
      providerOptions: STT_PROVIDERS,
      order: getSttOrder().join(','),
      orderDefault: DEFAULT_STT_ORDER,
      whisperModel: getWhisperModel(),
      whisperModelOptions: WHISPER_MODEL_OPTIONS,
      groqKeySet: Boolean(getGroqKey()),
      groqKeyMasked: mask(getGroqKey()),
      deepgramKeySet: Boolean(getDeepgramKey()),
      deepgramKeyMasked: mask(getDeepgramKey()),
      language: getSttLanguage(),
      minConfidence: getSttMinConfidence()
    },
    tts: {
      engine: getTtsEngine(),
      engineOptions: TTS_ENGINE_OPTIONS,
      order: getTtsOrder().join(','),
      orderDefault: defaultTtsOrder().join(','),
      language: getTtsLanguage(),
      url: getTtsUrl(),
      speed: getTtsSpeed(),
      piperUrl: getPiperUrl()
    },
    channels: {
      telegram: {
        enabled: String(dbValue('channels.telegram.enabled') || '').toLowerCase() === 'true',
        botTokenSet: Boolean(dbValue('channels.telegram.botToken')),
        botTokenMasked: mask(dbValue('channels.telegram.botToken') || ''),
        titoId: dbValue('channels.telegram.titoId') || '',
        mode: dbValue('channels.telegram.mode') || 'tito-only',
        allow: dbValue('channels.telegram.allow') || '',
        autoRespond: dbValue('channels.telegram.autoRespond') || ''
      },
      whatsapp: {
        enabled: String(dbValue('channels.whatsapp.enabled') || '').toLowerCase() === 'true',
        tokenSet: Boolean(dbValue('channels.whatsapp.token')),
        tokenMasked: mask(dbValue('channels.whatsapp.token') || ''),
        phoneId: dbValue('channels.whatsapp.phoneId') || '',
        titoId: dbValue('channels.whatsapp.titoId') || '',
        mode: dbValue('channels.whatsapp.mode') || 'tito-only',
        allow: dbValue('channels.whatsapp.allow') || ''
      }
    },
    energy: {
      mode: getEnergyMode()
    },
    notify: {
      channel: getNotifyChannel(),
      voice: getNotifyVoice(),
      to: getNotifyTo()
    },
    split: {
      mode: getSplitMode(),
      vps: getSplitVps()
    },
    manos: {
      enabled: getManosEnabled(),
      maxTurns: getManosMaxTurns()
    },
    sala: {
      v1: getSalaV1(),
      timeoutMs: getSalaTimeoutMs(),
      v2: getSalaV2(),
      sop: getSalaSop(),
      agentTimeoutMs: getSalaAgentTimeoutMs(),
      groupchat: getSalaGroupchat()
    },
    audio: {
      output: getAudioOutput(),
      input: getAudioInput(),
      followDefault: getAudioFollowDefault()
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
    // E-14: failover = CSV de proveedores conocidos (se filtran rarezas);
    // models = CSV no vacío (nombres libres, el proveedor valida).
    if (key === 'llm.failover' && value) {
      const clean = value.split(',').map((p) => p.trim().toLowerCase()).filter((p) => LLM_PROVIDERS[p]);
      if (clean.length === 0) {
        continue;
      }
    }
    if (key === 'llm.models' && value && value.split(',').map((m) => m.trim()).filter(Boolean).length === 0) {
      continue;
    }
    // E-15: modes tito-only|allowlist; enabled/autoRespond booleanos.
    if ((key === 'channels.telegram.mode' || key === 'channels.whatsapp.mode') && value && !['tito-only', 'allowlist'].includes(value.toLowerCase())) {
      continue;
    }
    if (['channels.telegram.enabled', 'channels.telegram.autoRespond', 'channels.whatsapp.enabled'].includes(key) && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'stt.provider' && value && !STT_PROVIDERS.includes(value)) {
      continue;
    }
    if (key === 'stt.order' && value && parseSttOrder(value).length === 0) {
      continue;
    }
    if (key === 'stt.whisperModel' && value && !WHISPER_MODEL_OPTIONS.includes(value)) {
      continue;
    }
    if (key === 'tts.engine' && value && !TTS_ENGINE_OPTIONS.includes(value)) {
      continue;
    }
    if (key === 'tts.order' && value && parseTtsOrder(value).length === 0) {
      continue;
    }
    if (key === 'tts.speed' && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0.5 || n > 2.0) {
        continue;
      }
    }
    if (key === 'tts.piperUrl' && value && !/^https?:\/\/.+/.test(value)) {
      continue;
    }
    if (key === 'tts.url' && value && !/^https?:\/\/.+/.test(value)) {
      continue;
    }
    if (key === 'energy.mode' && value && !['always-on', 'gate', 'manual'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'notify.channel' && value && !['telegram', 'whatsapp', 'none'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'notify.voice' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'split.mode' && value && !['local', 'split'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'split.vps' && value && !/^https?:\/\/.+/.test(value)) {
      continue;
    }
    if (key === 'stt.minConfidence' && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        continue;
      }
    }
    // Manos: enabled acepta booleanos en texto; maxTurns entero 1..12.
    if (key === 'manos.enabled' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'manos.maxTurns' && value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        continue;
      }
    }
    // Sala v1: flag booleano en texto; timeout 1000..60000 ms.
    if (key === 'sala.v1' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'sala.timeoutMs' && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1000 || n > 60000) {
        continue;
      }
    }
    // Sala v2: flag booleano; sop texto libre (max 8k); timeout 1000..60000.
    if (key === 'sala.v2' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    if (key === 'sala.sop' && value.length > 8000) {
      continue;
    }
    if (key === 'sala.agentTimeoutMs' && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1000 || n > 60000) {
        continue;
      }
    }
    // Llamada grupal: flag booleano como sala.v1/v2.
    if (key === 'sala.groupchat' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
      continue;
    }
    // Audio: node names de PipeWire (o 'default'/vacío = sistema). Nombres
    // reales: [A-Za-z0-9_.:+-] (ej. bluez_output.0D_45_E7_0E_0B_A8.1).
    if ((key === 'audio.output' || key === 'audio.input') && value && value.toLowerCase() !== 'default') {
      if (value.length > 256 || !/^[A-Za-z0-9_.:+@-]+$/.test(value)) {
        continue;
      }
    }
    if (key === 'audio.followDefault' && value && !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
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

  if (applied.some((key) => ['llm.apiKey', 'llm.deepseekKey', 'llm.opencodeKey', 'llm.groqKey', 'llm.provider'].includes(key))) {
    keyRing.setKeys(getMinimaxKeys());
  }
  return applied;
}
