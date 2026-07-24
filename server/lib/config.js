import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import agentConfig from '../agents.config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { agentConfig };
export const rootDir = path.resolve(__dirname, '..', '..');

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';
// Defaults verificados contra models.list (jul 2026); el registry avisa al
// arrancar si algún ID configurado dejó de existir.
export const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
export const TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.5-flash';
export const AGENT_TEXT_MODEL = process.env.GEMINI_AGENT_TEXT_MODEL || process.env.GEMINI_FAST_TEXT_MODEL || 'gemini-2.5-flash';
export const ROUTER_MODEL = process.env.GEMINI_ROUTER_MODEL || 'gemini-2.5-flash';
export const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
export const AGENT_TEXT_MODELS = uniqueModelList([
  AGENT_TEXT_MODEL,
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash'
]);
export const ROUTER_MODELS = uniqueModelList([
  ROUTER_MODEL,
  AGENT_TEXT_MODEL,
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash'
]);
export const TTS_MODELS = uniqueModelList([
  TTS_MODEL,
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-tts-preview'
]);
export const RESPONSE_TIMEOUT_MS = 18000;
export const AGENT_TEXT_TIMEOUT_MS = Number(process.env.GEMINI_AGENT_TEXT_TIMEOUT_MS || 8500);
export const ROUTER_TIMEOUT_MS = Number(process.env.GEMINI_ROUTER_TIMEOUT_MS || 4500);
export const TTS_TIMEOUT_MS = Number(process.env.GEMINI_TTS_TIMEOUT_MS || 12000);
export const MAX_CONTEXTUAL_FOLLOWUPS = 1;
export const AUDIO_MIME_TYPE = 'audio/pcm;rate=16000';
export const LIVE_TRANSCRIPT_FINALIZE_MS = 180;
export const FALLBACK_TRANSCRIBE_DELAY_MS = 120;
export const MAX_INLINE_TRANSCRIBE_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_MAX_EVENTS = 800;
export const TELEMETRY_TEXT_LIMIT = 4000;
export const DB_PATH = process.env.DB_PATH || path.join(rootDir, 'server', 'data', 'meetings.db');

// Tiempo real: backend de agentes ('auto' prueba live→stream→mock).
export const AGENT_BACKEND = (process.env.AGENT_BACKEND || 'auto').toLowerCase();
export const AGENT_LIVE_MODEL = process.env.GEMINI_AGENT_LIVE_MODEL || MODEL;
export const LIVE_MAX_SESSIONS_PER_KEY = Number(process.env.LIVE_MAX_SESSIONS_PER_KEY || 2);
export const LIVE_IDLE_CLOSE_MS = Number(process.env.LIVE_IDLE_CLOSE_MS || 5 * 60 * 1000);
export const SPEECH_LANGUAGE_CODE = process.env.SPEECH_LANGUAGE_CODE || 'es-ES';

export const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

export function collectApiKeys() {
  const fromList = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const numbered = Array.from({ length: 6 }, (_, index) => process.env[`GEMINI_API_KEY_${index + 1}`])
    .map((key) => key?.trim())
    .filter(Boolean);

  const fallback = [process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY]
    .map((key) => key?.trim())
    .filter(Boolean);

  const explicit = [...new Set([...fromList, ...numbered])];
  if (explicit.length > 0) {
    return explicit;
  }

  return [...new Set(fallback)];
}

export function uniqueModelList(models) {
  return [...new Set((models || []).map((model) => String(model || '').trim()).filter(Boolean))];
}

// Auto-aprendizaje: kill-switches ('0' desactiva) y modelo del observador.
export const LEARNING_ENABLED = process.env.LEARNING_ENABLED !== '0';
export const REFLECTION_ENABLED = process.env.REFLECTION_ENABLED !== '0';
export const ROUTER_TUNING_ENABLED = process.env.ROUTER_TUNING_ENABLED !== '0';
export const ROUTER_AUTO_APPLY_VOCAB = process.env.ROUTER_AUTO_APPLY_VOCAB !== '0';
export const LEARNING_MODELS = uniqueModelList([
  process.env.GEMINI_LEARNING_MODEL || 'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
]);
