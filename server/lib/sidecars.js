// Watchdog de sidecars locales STT/TTS (plan §3b, capa 2).
// Cada tick chequea /health de cada sidecar; si uno esperado está DOWN
// 2 ticks seguidos y SIDECAR_AUTOSTART !== '0', lo relanza detached con
// backoff 20s/60s/300s y tope de 5 restarts/hora por sidecar.
// Telemetría: sidecar_down (transición up→down) y sidecar_restart.
//
// Ruta GET /api/sidecars registrada en server/lib/http.js (sirve
// getSidecarStatus de este módulo).
//
// HIGIENE DE RAM (causa raíz STT lento, 09/11): el box tiene 7.5GB RAM al
// 96% con ~12GB en swap. Tras ~4min idle kswapd saca ~680MB del encoder
// Parakeet y el primer decode paga ~5s de page-in (Parakeet caliente hace
// ~0.45s EN y ES). Por eso: (1) warmup y prewarm usan HABLA REAL, nunca
// silencio; (2) este módulo manda un keepalive TRANSCRIBE real a Parakeet
// cada 75s para mantener las páginas residentes; (3) cada tick mira
// /proc/meminfo y avisa 1 vez/hora si el swap usado supera el 80%.
// Si ves `host_swap_pressure` seguido: cerrá Browsers/gateway pesado o
// agregá RAM — ningún keepalive compensa un box sin memoria libre.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { telemetry } from './telemetry.js';
import { getSttOrder, getTtsOrder, isSttOrderSet, isTtsOrderSet } from './settings.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Venvs dedicados (09/11: revivir respaldo local). Supertonic y Whisper
// corren en sus propios venvs bajo ~/.local/share/equipo — NUNCA en el
// python3 del sistema (ahí solo viven parakeet/piper). Paths con homedir,
// sin hardcodear /home/tito.
const EQUIPO_SHARE = path.join(os.homedir(), '.local', 'share', 'equipo');
const SUPERTONIC_BIN = path.join(EQUIPO_SHARE, 'supertonic-venv', 'bin', 'supertonic');
const WHISPER_PYTHON = path.join(EQUIPO_SHARE, 'whisper-venv', 'bin', 'python');

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
    // Respaldo STT local (venv dedicado, lazy: WHISPER_PRELOAD=0). Espeja
    // el `dev:stt` de package.json. El watchdog lo levanta SOLO si está
    // elegido en stt.order (TV2: elegido=up, resto=down).
    name: 'whisper',
    health: process.env.WHISPER_URL
      ? `${process.env.WHISPER_URL}/health`
      : 'http://127.0.0.1:7789/health',
    spawn: {
      cmd: WHISPER_PYTHON,
      args: ['server/stt/whisper_server.py'],
      env: { WHISPER_MODEL: 'tiny', WHISPER_PRELOAD: '0', HF_HUB_OFFLINE: '1' }
    }
  },
  {
    // TTS local Supertonic (venv dedicado). Espeja el `dev:tts` de
    // package.json. El watchdog lo levanta SOLO si está elegido en
    // tts.order (TV2: elegido=up, resto=down).
    name: 'supertonic',
    health: process.env.SUPERTONIC_URL
      ? `${process.env.SUPERTONIC_URL}/v1/health`
      : 'http://127.0.0.1:7788/v1/health',
    spawn: {
      cmd: SUPERTONIC_BIN,
      args: ['serve', '--host', '127.0.0.1', '--port', '7788']
    }
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
// lastSpawnAt, consecutiveSpawns }. opts.elected=false (TV2: motor no
// elegido en stt.order/tts.order) → nunca spawnea. Devuelve { restart, reason }.
export function shouldRestart(spec, state, now = Date.now(), { elected = true } = {}) {
  if (!spec || !spec.spawn) return { restart: false, reason: 'monitor-only' };
  if (elected === false) return { restart: false, reason: 'not-elected' };
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

// ---------------------------------------------------------------------------
// Motores elegibles (TV2): elegido=up, resto=down.
// ---------------------------------------------------------------------------

// Sidecars direccionables por los orders (los cloud —groq/deepgram/edge—
// no tienen proceso local y se ignoran acá).
export const LOCAL_SIDECAR_ENGINES = ['parakeet', 'piper', 'whisper', 'supertonic'];

// ¿Este spec participa como elegido? Solo los 4 locales obedecen la
// elección; un spec NO conocido (tests con fakes, futuros motores) no
// participa y sigue legacy (siempre elegible). Pura.
export function isSpecElected(name, elected) {
  if (!LOCAL_SIDECAR_ENGINES.includes(name)) return true;
  return elected instanceof Set ? elected.has(name) : false;
}

// Elegidos por defecto: locales del stt.order/tts.order seteado; lado sin
// setear aporta su legacy (parakeet/piper). Sin settings: parakeet+piper
// (comportamiento actual — Supertonic corría por concurrently, nunca lo
// levantó el watchdog). No lanza: si settings falla, legacy.
export function defaultElectedSidecars() {
  try {
    const out = new Set();
    if (isSttOrderSet()) {
      for (const e of getSttOrder()) {
        if (LOCAL_SIDECAR_ENGINES.includes(e)) out.add(e);
      }
    } else {
      out.add('parakeet');
    }
    if (isTtsOrderSet()) {
      for (const e of getTtsOrder()) {
        if (LOCAL_SIDECAR_ENGINES.includes(e)) out.add(e);
      }
    } else {
      out.add('piper');
    }
    return out;
  } catch {
    return new Set(['parakeet', 'piper']);
  }
}

// ---------------------------------------------------------------------------
// Calentamiento STT con habla real + keepalive anti-swap (09/11).
// ---------------------------------------------------------------------------

export const KEEPALIVE_INTERVAL_MS = 75000;
export const KEEPALIVE_TIMEOUT_MS = 10000;
export const KEEPALIVE_QUIET_FAILURES = 3; // telemetría solo al 3er fallo seguido
export const SWAP_WARN_PCT = 80;
export const SWAP_WARN_COOLDOWN_MS = 3600 * 1000;

// Fixture bundledo: 0.8s chirp+silencio, 16k mono 16-bit (ver tests/).
// Devuelve base64 del WAV o null si falta/ilegible (nunca lanza).
export function loadWarmupWavBase64(extraPaths = []) {
  const candidates = [
    ...extraPaths,
    path.join(REPO_ROOT, 'tests', 'fixtures', 'parakeet-warmup.wav')
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      // Sanity: header RIFF/WAVE mínimo.
      if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
        return buf.toString('base64');
      }
    } catch {
      // Siguiente candidato.
    }
  }
  return null;
}

// Carrera con techo: si promise no resuelve en ms, vale fallback.
// Nunca rechaza por timeout (el boot/prewarm jamás se bloquea).
export function withTimeoutMs(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    // Sin unref: este timer custodia una promesa que alguien espera;
    // con unref el loop se vacía y el await muere (visto en tests 09/11).
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

// PCM16 base64 (como lo devuelve Piper) → WAV 16k mono base64 con
// resample lineal. rate = sampleRate del PCM (del mimeType). Pura,
// devuelve null si la entrada no sirve.
export function pcmToWav16kBase64(pcmB64, rate) {
  try {
    const from = Number(rate);
    if (!pcmB64 || !Number.isFinite(from) || from <= 0) return null;
    const pcm = Buffer.from(String(pcmB64), 'base64');
    if (pcm.length < 2 || pcm.length % 2 !== 0) return null;
    const nIn = pcm.length / 2;
    const nOut = Math.max(1, Math.round((nIn * 16000) / from));
    const out = Buffer.alloc(nOut * 2);
    for (let i = 0; i < nOut; i++) {
      const pos = (i * (nIn - 1)) / Math.max(1, nOut - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(nIn - 1, i0 + 1);
      const frac = pos - i0;
      const v = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + out.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(out.length, 40);
    return Buffer.concat([header, out]).toString('base64');
  } catch {
    return null;
  }
}

// Primer candidato no vacío (para elegir audio de prewarm: Piper → fixture).
export function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

// Agenda pura del keepalive: próximo disparo tras lastAt.
export function nextKeepaliveAt(lastAt, now = Date.now(), intervalMs = KEEPALIVE_INTERVAL_MS) {
  const last = Number(lastAt);
  const base = Number.isFinite(last) && last > 0 ? last : now;
  return base + intervalMs;
}

// ¿Toca keepalive ahora? Pura (testeable sin timers).
export function shouldKeepalive(now, lastAt, intervalMs = KEEPALIVE_INTERVAL_MS) {
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return true; // nunca se hizo: toca
  return now - last >= intervalMs;
}

// Un disparo del keepalive: POST del fixture a /v1/transcribe. Resuelve
// {ok, ms}; nunca lanza. fetchFn inyectable para tests.
export async function postKeepalive(transcribeUrl, audioBase64, {
  fetchFn = fetch,
  timeoutMs = KEEPALIVE_TIMEOUT_MS
} = {}) {
  const started = Date.now();
  try {
    if (!audioBase64) return { ok: false, ms: 0, reason: 'no-audio' };
    const res = await fetchFn(transcribeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_base64: audioBase64, language: 'es' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: !!res?.ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started, reason: 'fetch-fail' };
  }
}

// Parsea /proc/meminfo → {totalKb, freeKb, usedPct} del swap. Pura.
// Devuelve null si no hay swap o el texto no sirve.
export function parseSwapPressure(meminfoText) {
  try {
    const total = /^SwapTotal:\s+(\d+)/m.exec(String(meminfoText || ''));
    const free = /^SwapFree:\s+(\d+)/m.exec(String(meminfoText || ''));
    if (!total || !free) return null;
    const totalKb = Number(total[1]);
    const freeKb = Number(free[1]);
    if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
    return { totalKb, freeKb, usedPct: ((totalKb - freeKb) / totalKb) * 100 };
  } catch {
    return null;
  }
}

// ¿Avisamos por swap? Pura: supera umbral y pasó el cooldown desde lastWarn.
export function shouldWarnSwap(usedPct, now, lastWarnedAt, threshold = SWAP_WARN_PCT, cooldownMs = SWAP_WARN_COOLDOWN_MS) {
  if (!Number.isFinite(usedPct) || usedPct < threshold) return false;
  const last = Number(lastWarnedAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= cooldownMs;
}

// Lee meminfo y decide aviso (dep. inyectables para tests).
// Devuelve {warned, usedPct, warnedAt} — warnedAt ya actualizado.
export function maybeWarnSwap({ now = Date.now(), lastWarnedAt = 0, readMeminfo = null } = {}) {
  let text = null;
  try {
    text = typeof readMeminfo === 'function'
      ? readMeminfo()
      : readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return { warned: false, usedPct: null, warnedAt: lastWarnedAt };
  }
  const parsed = parseSwapPressure(text);
  if (!parsed) return { warned: false, usedPct: null, warnedAt: lastWarnedAt };
  if (!shouldWarnSwap(parsed.usedPct, now, lastWarnedAt)) {
    return { warned: false, usedPct: parsed.usedPct, warnedAt: lastWarnedAt };
  }
  return { warned: true, usedPct: parsed.usedPct, warnedAt: now };
}

async function defaultCheck(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return parseHealth(res);
  } catch {
    return false;
  }
}

// Lanza el sidecar detached (sobrevive al server), cwd = repo. Si el spec
// trae `env`, se mergea sobre process.env (para venvs y flags offline).
function defaultSpawnFn(spec) {
  const child = spawn(spec.spawn.cmd, spec.spawn.args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(spec.spawn.env || {}) }
  });
  child.unref();
  return { pid: child.pid ?? null };
}

// Mata UN hijo propio del watchdog (handle que devolvió spawnFn). Nunca
// toca PIDs ajenos: si el handle no trae pid o el proceso ya murió,
// devuelve false sin lanzar. PROHIBIDO pkill por nombre/patrón broad.
function defaultKillFn(handle) {
  try {
    const pid = handle?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (err) {
    // ESRCH = ya murió: estado deseado alcanzado, cuenta como stop.
    return err?.code === 'ESRCH';
  }
}

// Último estado conocido por el watchdog activo (lo sirve /api/sidecars).
let registry = null;
// Últimos elegidos vistos por el watchdog activo (para el campo elected
// del status; null = sin watchdog, se computa al vuelo).
let lastElected = null;

function electedSetNow() {
  if (lastElected instanceof Set) return lastElected;
  try {
    return defaultElectedSidecars();
  } catch {
    return new Set();
  }
}

export function getSidecarStatus() {
  const elected = electedSetNow();
  if (!registry) {
    return SIDECARS.map((s) => ({
      name: s.name,
      status: 'unknown',
      downs: 0,
      restartsLastHour: 0,
      lastSpawnAt: null,
      elected: isSpecElected(s.name, elected),
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
    elected: isSpecElected(spec.name, elected),
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

// Baja UN hijo propio no-elegido (best-effort, nunca lanza). Solo se
// llama con handles que trackeamos en `children` — jamás PIDs ajenos.
function stopOwnChild(spec, handle, killFn, onTelemetry) {
  let stopped = false;
  try {
    stopped = killFn(handle, spec) !== false;
  } catch {
    stopped = false;
  }
  emit(onTelemetry, stopped ? 'sidecar_stop' : 'sidecar_stop_failed', {
    sidecar: spec.name,
    pid: handle?.pid ?? null
  });
}

export function startSidecarWatchdog({
  intervalMs = 20000,
  specs = SIDECARS,
  check = defaultCheck,
  spawnFn = defaultSpawnFn,
  // TV2 selectivo: getElected devuelve los nombres elegidos (default =
  // settings stt.order/tts.order); killFn mata UN hijo propio (default =
  // SIGTERM al pid del handle). Inyectables para tests.
  getElected = defaultElectedSidecars,
  killFn = defaultKillFn,
  onTelemetry = null,
  // Keepalive anti-swap SOLO a Parakeet: TRANSCRIBE real cada 75s con el
  // fixture chico (fire-and-forget, timeout 10s). `false` lo apaga (tests
  // o boxes sin Parakeet); objeto pisa intervalos/fetch para tests.
  keepalive = true,
  // Aviso de swap 1 vez/hora si supera 80%. `false` lo apaga.
  swapWarn = true
} = {}) {
  const entries = specs.map((spec) => ({
    spec,
    state: { status: 'unknown', downs: 0, restarts: [], lastSpawnAt: 0, consecutiveSpawns: 0 }
  }));
  registry = entries;
  // Hijos propios vivos por nombre (handles de spawnFn). SOLO estos se
  // pueden matar; jamás un PID que el watchdog no spawneó.
  const children = new Map();

  const kaOpts = keepalive === false ? null
    : { intervalMs: KEEPALIVE_INTERVAL_MS, timeoutMs: KEEPALIVE_TIMEOUT_MS, ...(keepalive === true ? {} : keepalive) };
  const parakeetSpec = kaOpts ? specs.find((s) => s.name === 'parakeet') : null;
  const kaState = {
    lastAt: 0,
    failures: 0,
    audio: kaOpts ? (kaOpts.audioBase64 ?? loadWarmupWavBase64()) : null,
    url: kaOpts?.transcribeUrl
      ?? (parakeetSpec ? String(parakeetSpec.health).replace(/\/health\s*$/, '/v1/transcribe') : null)
  };
  let lastSwapWarnAt = 0;
  const swapOpts = swapWarn === false ? null
    : { ...(swapWarn === true ? {} : swapWarn) };

  async function tick(now = Date.now()) {
    // Elegidos de este tick. Si getElected falla: fail-open (todos
    // elegidos = comportamiento pre-TV2, y sobre todo NUNCA matar).
    let elected;
    try {
      elected = new Set(getElected());
    } catch {
      elected = new Set(specs.map((s) => s.name));
    }
    lastElected = elected;
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
        // No-elegido pero levantado: si es hijo propio se baja (elegido=
        // up, resto=down); si NO lo spawneamos nosotros, ni se toca.
        if (!isSpecElected(spec.name, elected) && children.has(spec.name)) {
          stopOwnChild(spec, children.get(spec.name), killFn, onTelemetry);
          children.delete(spec.name);
        }
        continue;
      }
      state.status = 'down';
      state.downs += 1;
      if (state.downs === 1) {
        emit(onTelemetry, 'sidecar_down', { sidecar: spec.name, health: spec.health });
      }
      // No-elegido: nunca spawnea; si queda un hijo propio (ej. se
      // deseligió mientras arrancaba), se baja y listo.
      if (!isSpecElected(spec.name, elected)) {
        if (children.has(spec.name)) {
          stopOwnChild(spec, children.get(spec.name), killFn, onTelemetry);
          children.delete(spec.name);
        }
        continue;
      }
      const decision = shouldRestart(spec, state, now, { elected: true });
      if (!decision.restart) continue;
      try {
        const r = await spawnFn(spec);
        if (r && Number.isInteger(r.pid)) children.set(spec.name, r);
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
    // Keepalive anti-swap: solo Parakeet elegido, solo cada 75s (el tick
    // de 20s es muy seguido), fire-and-forget. Cero telemetría salvo 3
    // fallos seguidos: el keepalive sano tiene que ser invisible. Si
    // Parakeet no está elegido, no se le habla (está down a propósito).
    if (kaOpts && parakeetSpec && kaState.audio && kaState.url
        && isSpecElected('parakeet', elected)
        && shouldKeepalive(now, kaState.lastAt, kaOpts.intervalMs)) {
      kaState.lastAt = now; // se marca antes: nunca se apila
      void postKeepalive(kaState.url, kaState.audio, {
        fetchFn: kaOpts.fetchFn || fetch,
        timeoutMs: kaOpts.timeoutMs
      }).then((r) => {
        if (r?.ok) {
          kaState.failures = 0;
          return;
        }
        kaState.failures += 1;
        if (kaState.failures === KEEPALIVE_QUIET_FAILURES) {
          emit(onTelemetry, 'parakeet_keepalive_failing', {
            sidecar: 'parakeet',
            failures: kaState.failures,
            url: kaState.url
          });
        }
      }).catch(() => {});
    }
    // Higiene de RAM: aviso barato 1 vez/hora si el swap supera el 80%.
    if (swapOpts) {
      try {
        const r = maybeWarnSwap({ now, lastWarnedAt: lastSwapWarnAt, readMeminfo: swapOpts.readMeminfo });
        lastSwapWarnAt = r.warnedAt;
        if (r.warned) {
          emit(onTelemetry, 'host_swap_pressure', { usedPct: Math.round(r.usedPct) });
          console.warn(`[sidecars] swap al ${Math.round(r.usedPct)}%: cerrá peso o agregá RAM (aviso 1 vez/hora)`);
        }
      } catch {
        // Best-effort: el watchdog no muere por meminfo.
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
    // Estado del keepalive (para tests y /api/sidecars futuro).
    getKeepalive: () => ({ lastAt: kaState.lastAt, failures: kaState.failures }),
    stop() {
      clearInterval(timer);
      if (registry === entries) {
        registry = null;
        lastElected = null;
      }
    }
  };
}
