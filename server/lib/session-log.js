import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { rootDir } from './config.js';

// Diario de la empresa: qué le pediste, qué contestaron, qué se rompió.
//
// La telemetría en RAM sirve para el panel en vivo pero se pierde al
// reiniciar. Esto es durable y legible a mano: un JSONL por día en
// server/data/logs/, pensado para abrirlo después de que algo falle y
// reconstruir exactamente qué pasó (tu mensaje textual incluido).

const LOG_DIR = process.env.SESSION_LOG_DIR
  ? path.resolve(process.env.SESSION_LOG_DIR)
  : path.join(rootDir, 'server', 'data', 'logs');
const MAX_FILE_BYTES = Number(process.env.LOG_MAX_BYTES || 25 * 1024 * 1024);
const MAX_TEXT = 8000;

// Nunca escribir secretos al disco, venga de donde venga.
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_.-]{24,}|Bearer\s+\S{12,})/g;

let queue = Promise.resolve();
let currentFile = null;
let currentDay = null;
let enabled = process.env.SESSION_LOG !== '0';

function redact(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const clipped = value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…[recortado ${value.length} chars]` : value;
  return clipped.replace(SECRET_PATTERN, '[secreto oculto]');
}

function redactDeep(value, depth = 0) {
  if (depth > 4 || value == null) {
    return value;
  }
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => redactDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|secret|password/i.test(key)) {
        out[key] = item ? '[secreto oculto]' : item;
      } else {
        out[key] = redactDeep(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function resolveFile() {
  const day = dayStamp();
  if (currentFile && currentDay === day) {
    // Rotar si el día se hizo enorme (una sesión larga de trabajo escribe mucho).
    const size = await stat(currentFile).then((s) => s.size).catch(() => 0);
    if (size < MAX_FILE_BYTES) {
      return currentFile;
    }
  }
  await mkdir(LOG_DIR, { recursive: true });
  currentDay = day;
  let candidate = path.join(LOG_DIR, `${day}.jsonl`);
  for (let part = 2; part < 100; part += 1) {
    const size = await stat(candidate).then((s) => s.size).catch(() => 0);
    if (size < MAX_FILE_BYTES) {
      break;
    }
    candidate = path.join(LOG_DIR, `${day}.${part}.jsonl`);
  }
  currentFile = candidate;
  return currentFile;
}

// Escritura encolada: nunca bloquea el turno ni tira una excepción hacia
// arriba (un log roto no puede tumbar una conversación).
export function logEvent(kind, payload = {}) {
  if (!enabled || !kind) {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    kind,
    ...redactDeep(payload)
  };
  queue = queue
    .then(async () => {
      const file = await resolveFile();
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
    })
    .catch(() => {
      // Si el disco falla, se pierde el log, no la reunión.
    });
}

// Espera a que se vacíe la cola (tests y apagado ordenado).
export function flushLog() {
  return queue;
}

export function setLogEnabled(value) {
  enabled = Boolean(value);
}

export function logDirectory() {
  return LOG_DIR;
}

export async function listLogDays() {
  const files = await readdir(LOG_DIR).catch(() => []);
  return files
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse();
}

// Lectura para el endpoint HTTP: las últimas N entradas del día pedido,
// opcionalmente filtradas por tipo o por texto.
export async function readLog({ day = dayStamp(), limit = 200, kind = null, search = null } = {}) {
  const files = (await listLogDays()).filter((name) => name.startsWith(day));
  const entries = [];
  for (const name of files) {
    const raw = await readFile(path.join(LOG_DIR, name), 'utf-8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Línea corrupta (apagón a mitad de escritura): se ignora.
      }
    }
  }
  let filtered = entries;
  if (kind) {
    const kinds = new Set(String(kind).split(',').map((item) => item.trim()));
    filtered = filtered.filter((entry) => kinds.has(entry.kind));
  }
  if (search) {
    const needle = String(search).toLowerCase();
    filtered = filtered.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
  }
  return filtered.slice(-Math.max(1, Math.min(Number(limit) || 200, 2000)));
}
