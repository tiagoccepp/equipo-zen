// Monitor de conectividad (track TC, 09/11 noche). Observabilidad pura:
// sondea sidecars locales, WS /meeting, APIs cloud con key configurada y
// DNS general. Diseñado para sondeo periódico (30s), NUNCA para el hot
// path del turno — checkConnectivity() es async con timeouts cortos y
// todo inyectable (fetchFn/dnsFn/wsCheck/sidecars/cloud) para tests.
//   checkConnectivity(opts?) → { online, status, checks, ts }
//   checks: [{ name, ok, ms, detail? }]
// NUNCA loguea keys: los details llevan solo nombres, estados HTTP y ms.
// Cloud SIN key configurada no emite check (no es un problema de conexión).

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { WebSocket as WsClient } from 'ws';

import { defaultZenKeyPath, JEV_URL } from './addressing.js';
import { HOST, PORT } from './config.js';
import { getDeepgramKey, getGroqKey, getLlmKeys, getLlmProvider, getLlmProviderConfig } from './settings.js';
import { SIDECARS } from './sidecars.js';

export const CONNECTIVITY_TIMEOUT_MS = 2500;
export const CONNECTIVITY_INTERVAL_MS = 30000;

const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const DEEPGRAM_PROJECTS_URL = 'https://api.deepgram.com/v1/projects';
const BRAVE_ROOT_URL = 'https://api.search.brave.com/';
const TAVILY_ROOT_URL = 'https://api.tavily.com/';
// Groq va tras Cloudflare: sin UA de navegador devuelve 403/1010
// (mismo header que el proveedor groq en config.js).
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const TIMEOUT = Symbol('timeout');

// Carrera con techo. SIN unref: este timer custodia una promesa que
// alguien espera (misma razón que withTimeoutMs en sidecars.js).
function raceTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ms));
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// Error de red → detail corto y honesto (nunca incluye keys: acá no hay).
function shortErr(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code === 'ECONNREFUSED') return 'conn refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns fail';
  const msg = String(err?.message || err || 'fail');
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR' || /aborted|timeout/i.test(msg)) return 'timeout';
  return msg.slice(0, 80);
}

function safeGet(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

// Clasifica un HTTP en ok/no-ok para pings de conectividad.
// Con auth (Bearer enviado): 401/403 = key rechazada (falla, hay que
// saberlo); cualquier otro 4xx = reachable con auth aceptada (los GET
// sobre endpoints POST-only devuelven 404/405/400: esperado).
// Sin auth (host probe, sin gastar ni mandar key): cualquier respuesta = ok.
export function classifyHttp(status, authSent) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return { ok: true };
  if (authSent && (s === 401 || s === 403)) return { ok: false, note: 'key rechazada' };
  if (s === 429) return { ok: true, note: 'rate limit' };
  if (s >= 400 && s < 500) return { ok: true };
  if (s >= 500) return { ok: false, note: 'upstream 5xx' };
  return { ok: false, note: 'sin respuesta' };
}

// ¿Hay key de Zen/Jev en disco? Solo existencia, el contenido no sale.
function hasZenKeyFile() {
  try {
    return readFileSync(defaultZenKeyPath(), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

// Targets cloud SOLO para keys configuradas. Cada override undefined =
// detectar real (env/settings/disco); pasar ''/false = forzar ausente
// (tests). Jamás testea con keys dummy: sin key no hay target.
export function buildCloudTargets({
  llmProvider,
  llmKey,
  llmUrl,
  llmExtraHeaders,
  groqKey,
  deepgramKey,
  hasZenKey,
  braveKey,
  tavilyKey
} = {}) {
  const provider = llmProvider ?? safeGet(getLlmProvider, 'minimax');
  const config = llmUrl ? null : safeGet(getLlmProviderConfig, null);
  const url = llmUrl ?? config?.url ?? null;
  const activeKeys = llmKey !== undefined ? [llmKey] : (safeGet(getLlmKeys, []) || []);
  const K = String(activeKeys[0] || '');
  const extra = llmExtraHeaders ?? config?.extraHeaders ?? {};
  const G = groqKey !== undefined ? String(groqKey || '') : String(safeGet(getGroqKey, '') || '');
  const DG = deepgramKey !== undefined ? String(deepgramKey || '') : String(safeGet(getDeepgramKey, '') || '');
  const zen = hasZenKey !== undefined ? hasZenKey === true : hasZenKeyFile();
  const B = braveKey !== undefined ? String(braveKey || '') : String(process.env.BRAVE_API_KEY || '');
  const T = tavilyKey !== undefined ? String(tavilyKey || '') : String(process.env.TAVILY_API_KEY || '');

  const targets = [];
  if (DG) {
    targets.push({
      name: 'cloud:deepgram',
      url: DEEPGRAM_PROJECTS_URL,
      headers: { Authorization: `Bearer ${DG}` },
      authSent: true
    });
  }
  // Groq cubre STT y LLM con el mismo endpoint: una sola key efectiva
  // (stt.groqKey/GROQ_API_KEY o la del proveedor llm groq), un solo check.
  const groqEffective = G || (provider === 'groq' ? K : '');
  if (groqEffective) {
    targets.push({
      name: 'cloud:groq',
      url: GROQ_MODELS_URL,
      headers: { Authorization: `Bearer ${groqEffective}`, 'User-Agent': BROWSER_UA },
      authSent: true
    });
  }
  if (K && provider !== 'groq' && url) {
    targets.push({
      name: `cloud:llm-${provider}`,
      url,
      headers: { Authorization: `Bearer ${K}`, ...extra },
      authSent: true
    });
  }
  // Host probes SIN auth: prueban DNS+TCP+TLS sin gastar ni mandar la key.
  if (zen) {
    targets.push({ name: 'cloud:zen', url: JEV_URL, headers: {}, authSent: false, extraDetail: 'key presente' });
  }
  if (B) {
    targets.push({ name: 'cloud:brave', url: BRAVE_ROOT_URL, headers: {}, authSent: false, extraDetail: 'key presente' });
  }
  if (T) {
    targets.push({ name: 'cloud:tavily', url: TAVILY_ROOT_URL, headers: {}, authSent: false, extraDetail: 'key presente' });
  }
  return targets;
}

export function defaultWsUrl() {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `ws://${host}:${PORT}/meeting`;
}

export function defaultDnsHost() {
  try {
    const url = getLlmProviderConfig()?.url;
    const host = new URL(url).hostname;
    if (host) return host;
  } catch {
    // Sin URL válida: host estable de fallback.
  }
  return 'api.groq.com';
}

// Probe real de WS: handshake contra /meeting local y cierre inmediato.
// Crea una MeetingSession efímera del lado servidor (igual que un cliente
// que conecta y cuelga al instante; initMeeting solo corre con hello).
// Inyectable vía opts.wsCheck (tests usan fake, 0 red real).
export function defaultWsCheck(url, timeoutMs) {
  const target = url || defaultWsUrl();
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.close(); } catch { /* ya cerrado */ }
      resolve(detail ? { ok, detail } : { ok });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), Math.max(1, timeoutMs));
    try {
      sock = new WsClient(target, { handshakeTimeout: timeoutMs });
    } catch (err) {
      finish(false, shortErr(err));
      return;
    }
    sock.on('open', () => finish(true));
    sock.on('error', (err) => finish(false, shortErr(err)));
  });
}

// Probe real de DNS: resolve barato del host que el LLM usa.
export async function defaultDnsFn(host) {
  const result = await lookup(host || defaultDnsHost());
  return { ok: true, detail: result?.address ? String(result.address) : undefined };
}

// Un check: nunca lanza, nunca cuelga más de timeoutMs.
async function runCheck(name, fn, timeoutMs) {
  const started = Date.now();
  try {
    const result = await raceTimeout(Promise.resolve().then(fn), timeoutMs);
    if (result === TIMEOUT) {
      return { name, ok: false, ms: Date.now() - started, detail: 'timeout' };
    }
    const out = { name, ok: result?.ok === true, ms: Date.now() - started };
    if (result?.detail) out.detail = String(result.detail).slice(0, 120);
    return out;
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, detail: shortErr(err) };
  }
}

function probeHttp(target, fetchFn, timeoutMs) {
  return async () => {
    const res = await fetchFn(target.url, {
      method: 'GET',
      headers: target.headers || {},
      signal: AbortSignal.timeout(timeoutMs)
    });
    const status = Number(res?.status) || 0;
    const verdict = classifyHttp(status, target.authSent === true);
    let detail = `http ${status}`;
    if (verdict.note) detail += ` (${verdict.note})`;
    if (target.extraDetail) detail += `, ${target.extraDetail}`;
    return { ok: verdict.ok, detail };
  };
}

function probeSidecar(spec, fetchFn, timeoutMs) {
  return async () => {
    const res = await fetchFn(spec.health, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Health local: solo 2xx vale (un 404 acá es sidecar roto, no reachable).
    return { ok: res?.ok === true, detail: `http ${Number(res?.status) || 0}` };
  };
}

// Sondeo completo. Todo paralelo (Promise.all), techo timeoutMs por check.
// opts: { fetchFn, dnsFn, dnsHost, wsCheck, wsUrl, sidecars, cloud, timeoutMs }.
export async function checkConnectivity({
  fetchFn = fetch,
  dnsFn = null,
  dnsHost = null,
  wsCheck = null,
  wsUrl = null,
  sidecars = null,
  cloud = undefined,
  timeoutMs = CONNECTIVITY_TIMEOUT_MS
} = {}) {
  const jobs = [];
  const specs = Array.isArray(sidecars) ? sidecars : SIDECARS;
  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string' || !spec.name || !spec.health) continue;
    jobs.push(runCheck(`sidecar:${spec.name}`, probeSidecar(spec, fetchFn, timeoutMs), timeoutMs));
  }
  const wsProbe = typeof wsCheck === 'function'
    ? () => wsCheck(wsUrl || defaultWsUrl(), timeoutMs)
    : () => defaultWsCheck(wsUrl || defaultWsUrl(), timeoutMs);
  jobs.push(runCheck('ws:/meeting', wsProbe, timeoutMs));
  const host = dnsHost || defaultDnsHost();
  const dnsProbe = typeof dnsFn === 'function' ? () => dnsFn(host) : () => defaultDnsFn(host);
  jobs.push(runCheck(`dns:${host}`, dnsProbe, timeoutMs));
  const targets = cloud !== undefined ? cloud : buildCloudTargets();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || typeof target.name !== 'string' || !target.name || !target.url) continue;
    jobs.push(runCheck(target.name, probeHttp(target, fetchFn, timeoutMs), timeoutMs));
  }
  const checks = await Promise.all(jobs);
  const online = checks.length > 0 && checks.every((c) => c.ok);
  const status = online ? 'online' : (checks.some((c) => c.ok) ? 'degraded' : 'offline');
  return { online, status, checks, ts: Date.now() };
}

// ── Snapshot en memoria + intervalo lazy (30s, no en tests) ──────────────
// El endpoint sirve el snapshot; el intervalo lo refresca en fondo. Todo
// best-effort: un sondeo fallido deja el snapshot anterior intacto.

let snapshot = null;
let timer = null;
let inflight = null;

export function isConnectivityTestEnv() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function getConnectivitySnapshot() {
  return snapshot;
}

export function setConnectivitySnapshot(value) {
  snapshot = value || null;
  return snapshot;
}

export function refreshConnectivitySnapshot(opts = {}) {
  if (inflight) return inflight;
  inflight = checkConnectivity(opts)
    .then((fresh) => { snapshot = fresh; return snapshot; })
    .catch(() => snapshot)
    .finally(() => { inflight = null; });
  return inflight;
}

export function ensureConnectivityLoop(opts = {}) {
  if (timer || isConnectivityTestEnv()) return timer;
  timer = setInterval(() => {
    void refreshConnectivitySnapshot(opts).catch(() => {});
  }, CONNECTIVITY_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// Solo tests.
export function __resetConnectivity() {
  if (timer) clearInterval(timer);
  timer = null;
  snapshot = null;
  inflight = null;
}
