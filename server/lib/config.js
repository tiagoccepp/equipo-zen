import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import agentConfig from '../agents.config.json' with { type: 'json' };
import companyTemplates from '../company-templates.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { agentConfig, companyTemplates };
export const rootDir = path.resolve(__dirname, '..', '..');

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';
export const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

// ── MiniMax (razonamiento) ───────────────────────────────────────────────
export const MINIMAX_API_URL = process.env.MINIMAX_API_URL || 'https://api.minimax.io/v1/chat/completions';
// Catálogo completo, del más nuevo al más viejo. Es una sola lista porque hace
// dos trabajos a la vez: lo que ofrece el desplegable de Ajustes y la cadena de
// repuesto cuando un modelo falla. Cuando eran dos listas distintas, elegir M3
// en la UI se guardaba pero al leerlo no figuraba acá y se caía al default.
export const MINIMAX_CATALOG = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'];
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL || MINIMAX_CATALOG[0];
export const MINIMAX_MODELS = uniqueModelList([
  MINIMAX_MODEL,
  ...MINIMAX_CATALOG
]);
// ── Proveedores de razonamiento ──────────────────────────────────────────
//
// Los dos hablan el formato de OpenAI (mismo /chat/completions, mismo Bearer,
// misma forma del parámetro `thinking`), así que el cliente es uno solo y lo
// único que cambia es a dónde apunta, con qué clave y con qué modelos.
export const OPENCODE_API_URL = process.env.OPENCODE_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions';
// Pool de rotación Zen (costo 0, verificado 2026-11-06). beam-free primero:
// es el primario; el resto son repuestos en orden. kimi-* excluido: exige
// temperature=1 y el cliente manda 0.7.
export const OPENCODE_CATALOG = [
  'beam-free',
  'iceman-contributor-free',
  'crouton-alpha-free',
  'deepseek-v4.1-flash',
  'qwen3.8-flash',
  'minimax-m3.1-flash',
  'glm-5.3-flash'
];
export const OPENCODE_MODEL = process.env.OPENCODE_MODEL || OPENCODE_CATALOG[0];
export const OPENCODE_MODELS = uniqueModelList([
  OPENCODE_MODEL,
  ...OPENCODE_CATALOG
]);
export const LLM_PROVIDERS = {
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    url: MINIMAX_API_URL,
    envKey: 'MINIMAX_API_KEY',
    settingKey: 'llm.apiKey',
    defaultModel: MINIMAX_MODEL,
    models: MINIMAX_MODELS,
    // La serie M piensa igual con esto en 'disabled', pero se pide.
    thinking: 'disabled',
    tokenParam: 'max_completion_tokens'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    url: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    settingKey: 'llm.deepseekKey',
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    models: uniqueModelList([
      process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro'
    ]),
    // Ojo: en DeepSeek el pensamiento viene ENCENDIDO por defecto, y el tope
    // de salida se llama max_tokens (max_completion_tokens lo ignora).
    thinking: 'disabled',
    tokenParam: 'max_tokens'
  },
  opencode: {
    id: 'opencode',
    label: 'opencode Zen',
    url: OPENCODE_API_URL,
    envKey: 'OPENCODE_API_KEY',
    settingKey: 'llm.opencodeKey',
    defaultModel: OPENCODE_MODEL,
    models: OPENCODE_MODELS,
    // Zen RECHAZA el parámetro thinking (400 unsupported_parameter,
    // verificado 2026-11-06): con null el cliente lo omite.
    thinking: null,
    tokenParam: 'max_tokens',
    // Zen exige el header x-opencode-session (400 MissingSessionID sin él,
    // verificado 2026-11-06).
    extraHeaders: {
      'User-Agent': 'portfolio-live-smoke/1.0',
      'x-opencode-session': 'equipo-live'
    }
  }
};

const _envProvider = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
export const DEFAULT_LLM_PROVIDER = LLM_PROVIDERS[_envProvider] ? _envProvider : 'minimax';

export function collectProviderKeys(providerId) {
  const provider = LLM_PROVIDERS[providerId];
  if (!provider) {
    return [];
  }
  if (providerId === 'minimax') {
    return collectApiKeys();
  }
  const raw = process.env[provider.envKey] || '';
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

// ── Supertonic (voz local) ───────────────────────────────────────────────
export const SUPERTONIC_URL = process.env.SUPERTONIC_URL || 'http://127.0.0.1:7788';
export const SUPERTONIC_LANGUAGE = process.env.SUPERTONIC_LANGUAGE || 'es';

// ── Tiempos y colas ──────────────────────────────────────────────────────
export const RESPONSE_TIMEOUT_MS = 18000;
export const AGENT_TEXT_TIMEOUT_MS = Number(process.env.AGENT_TEXT_TIMEOUT_MS || 20000);
export const ROUTER_TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS || 6000);
export const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 12000);
export const MAX_CONTEXTUAL_FOLLOWUPS = 1;
export const AUDIO_MIME_TYPE = 'audio/pcm;rate=16000';
export const TELEMETRY_MAX_EVENTS = 800;
export const TELEMETRY_TEXT_LIMIT = 4000;
export const DB_PATH = process.env.DB_PATH || path.join(rootDir, 'server', 'data', 'meetings.db');

// ── Auto-aprendizaje: kill-switches ('0' desactiva) ─────────────────────
export const LEARNING_ENABLED = process.env.LEARNING_ENABLED !== '0';
export const REFLECTION_ENABLED = process.env.REFLECTION_ENABLED !== '0';
export const ROUTER_TUNING_ENABLED = process.env.ROUTER_TUNING_ENABLED !== '0';
export const ROUTER_AUTO_APPLY_VOCAB = process.env.ROUTER_AUTO_APPLY_VOCAB !== '0';

export function collectApiKeys() {
  const fromList = (process.env.MINIMAX_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const single = (process.env.MINIMAX_API_KEY || '').trim();

  return [...new Set(single ? [...fromList, single] : fromList)];
}

export function uniqueModelList(models) {
  return [...new Set((models || []).map((model) => String(model || '').trim()).filter(Boolean))];
}
