// Watchdog de sidecars locales STT/TTS (plan §3b, capa 2).
// Cada tick chequea /health de cada sidecar; si uno esperado está DOWN
// 2 ticks seguidos y SIDECAR_AUTOSTART !== '0', lo relanza detached con
// backoff 20s/60s/300s y tope de 5 restarts/hora por sidecar.
// Telemetría: sidecar_down (transición up→down) y sidecar_restart.
//
// Ruta GET /api/sidecars registrada en server/lib/http.js (sirve
// getSidecarStatus de este módulo).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { telemetry } from './telemetry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// whisper es monitor-only (spawn: null): whisper_server.py importa
// faster_whisper, que NO está en el python3 del sistema (verificado
// 08/11: `import faster_whisper` y `import whisper` fallan) y no existe
// ningún .venv-tts en el repo. Hasta que alguien provea el venv o instale
// faster-whisper, el watchdog lo vigila pero no intenta levantarlo.
export const SIDECARS = [
  {
    name: 'parakeet',
    health: process.env.PARAKEET_URL
      ? `${process.env.PARAKEET_URL}/health`
      : 'http://127.0.0.1:7790/health',
    spawn: { cmd: 'python3', args: ['server/stt/parakeet_server.py'] }
  },
  {
    name: 'piper',
    health: process.env.PIPER_URL
      ? `${process.env.PIPER_URL}/health`
      : 'http://127.0.0.1:7791/health',
    spawn: { cmd: 'python3', args: ['server/tts/piper_server.py'] }
  },
  {
    name: 'whisper',
    health: process.env.WHISPER_URL
      ? `${process.env.WHISPER_URL}/health`
      : 'http://127.0.0.1:7789/health',
    spawn: null
  }
];

export const HEALTH_TIMEOUT_MS = 1500;
export const DOWN_STRIKES = 2;
export const MAX_RESTARTS_PER_HOUR = 5;
const HOUR_MS = 3600 * 1000;
// Espera antes del restart N (consecutivo, sin recuperación en el medio):
// el 1º sale enseguida (ya hubo 2 strikes), después 20s/60s/300s.
const BACKOFF_MS = [0, 20000, 60000, 300000];

// Cuánto esperar antes del restart número n (0-based: n=0 es el primero).
export function backoffFor(n) {
  if (n <= 0) return BACKOFF_MS[0];
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
}

// Normaliza una respuesta de /health a booleano. Acepta fetch Response
// ({ok}) o el JSON ya parseado ({ok:true} / {status:'ok'}).
export function parseHealth(res) {
  if (!res || typeof res !== 'object') return false;
  if (typeof res.ok === 'boolean') return res.ok;
  if (typeof res.status === 'string') return res.status.toLowerCase() === 'ok';
  return false;
}

// Decisión pura de restart. state = { downs, restarts: [timestamps ms],
// lastSpawnAt, consecutiveSpawns }. Devuelve { restart, reason }.
export function shouldRestart(spec, state, now = Date.now()) {
  if (!spec || !spec.spawn) return { restart: false, reason: 'monitor-only' };
  if (process.env.SIDECAR_AUTOSTART === '0') return { restart: false, reason: 'autostart-off' };
  const downs = state?.downs || 0;
  if (downs < DOWN_STRIKES) return { restart: false, reason: 'need-2-strikes' };
  const recent = (state?.restarts || []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= MAX_RESTARTS_PER_HOUR) return { restart: false, reason: 'hourly-cap' };
  const consecutive = state?.consecutiveSpawns || 0;
  const wait = backoffFor(consecutive);
  const lastSpawn = state?.lastSpawnAt || 0;
  if (now - lastSpawn < wait) return { restart: false, reason: 'backoff' };
  return { restart: true, reason: 'down' };
}

async function defaultCheck(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return parseHealth(res);
  } catch {
    return false;
  }
}

// Lanza el sidecar detached (sobrevive al server), cwd = repo.
function defaultSpawnFn(spec) {
  const child = spawn(spec.spawn.cmd, spec.spawn.args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { pid: child.pid ?? null };
}

// Último estado conocido por el watchdog activo (lo sirve /api/sidecars).
let registry = null;

export function getSidecarStatus() {
  if (!registry) {
    return SIDECARS.map((s) => ({
      name: s.name,
      status: 'unknown',
      downs: 0,
      restartsLastHour: 0,
      lastSpawnAt: null,
      autostart: s.spawn !== null && process.env.SIDECAR_AUTOSTART !== '0'
    }));
  }
  const now = Date.now();
  return registry.map(({ spec, state }) => ({
    name: spec.name,
    status: state.status,
    downs: state.downs,
    restartsLastHour: state.restarts.filter((t) => now - t < HOUR_MS).length,
    lastSpawnAt: state.lastSpawnAt ? new Date(state.lastSpawnAt).toISOString() : null,
    autostart: spec.spawn !== null && process.env.SIDECAR_AUTOSTART !== '0'
  }));
}

function emit(onTelemetry, type, payload) {
  if (typeof onTelemetry === 'function') {
    onTelemetry(type, payload);
    return;
  }
  try {
    telemetry.add({ type, payload });
  } catch {
    // Telemetría best-effort: nunca rompe el watchdog.
  }
}

export function startSidecarWatchdog({
  intervalMs = 20000,
  specs = SIDECARS,
  check = defaultCheck,
  spawnFn = defaultSpawnFn,
  onTelemetry = null
} = {}) {
  const entries = specs.map((spec) => ({
    spec,
    state: { status: 'unknown', downs: 0, restarts: [], lastSpawnAt: 0, consecutiveSpawns: 0 }
  }));
  registry = entries;

  async function tick(now = Date.now()) {
    for (const entry of entryList()) {
      const { spec, state } = entry;
      let ok = false;
      try {
        ok = await check(spec.health);
      } catch {
        ok = false;
      }
      if (ok) {
        state.status = 'up';
        state.downs = 0;
        state.consecutiveSpawns = 0;
        continue;
      }
      state.status = 'down';
      state.downs += 1;
      if (state.downs === 1) {
        emit(onTelemetry, 'sidecar_down', { sidecar: spec.name, health: spec.health });
      }
      const decision = shouldRestart(spec, state, now);
      if (!decision.restart) continue;
      try {
        const r = await spawnFn(spec);
        state.restarts.push(now);
        state.restarts = state.restarts.filter((t) => now - t < HOUR_MS);
        state.lastSpawnAt = now;
        state.consecutiveSpawns += 1;
        emit(onTelemetry, 'sidecar_restart', {
          sidecar: spec.name,
          cmd: `${spec.spawn.cmd} ${spec.spawn.args.join(' ')}`,
          pid: r?.pid ?? null,
          downs: state.downs,
          restartsLastHour: state.restarts.length
        });
      } catch (err) {
        emit(onTelemetry, 'sidecar_restart_failed', {
          sidecar: spec.name,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return getSidecarStatus();
  }

  function entryList() {
    // registry puede haber sido reemplazado por otro watchdog (tests);
    // cada instancia tickea sus propias entries.
    return entries;
  }

  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, intervalMs);
  timer.unref?.();

  return {
    tick,
    getStatus: getSidecarStatus,
    stop() {
      clearInterval(timer);
      if (registry === entries) registry = null;
    }
  };
}
