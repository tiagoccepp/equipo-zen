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
  }
};

export const DEFAULT_LLM_PROVIDER = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'minimax';

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
