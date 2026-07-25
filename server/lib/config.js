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
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.5';
export const MINIMAX_MODELS = uniqueModelList([
  MINIMAX_MODEL,
  'MiniMax-M2.5',
  'MiniMax-M2'
]);
export const MINIMAX_ROUTER_MODELS = uniqueModelList([
  process.env.MINIMAX_ROUTER_MODEL || MINIMAX_MODEL,
  ...MINIMAX_MODELS
]);
export const MINIMAX_LEARNING_MODELS = uniqueModelList([
  process.env.MINIMAX_LEARNING_MODEL || MINIMAX_MODEL,
  ...MINIMAX_MODELS
]);

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

// Backend de agentes: 'auto' usa stream con claves y mock sin claves.
export const AGENT_BACKEND = (process.env.AGENT_BACKEND || 'auto').toLowerCase();

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
