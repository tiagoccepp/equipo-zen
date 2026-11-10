// Connectivity monitor (track TC, 09/11 evening). Pure observability:
// probes local sidecars, WS /meeting, cloud APIs with configured key and
// general DNS. Built for periodic polling (30s), NEVER for the turn hot
// path — checkConnectivity() is async with short timeouts and
// everything injectable (fetchFn/dnsFn/wsCheck/sidecars/cloud) for tests.
//   checkConnectivity(opts?) → { online, status, checks, ts }
//   checks: [{ name, ok, ms, detail? }]
// NEVER logs keys: details carry only names, HTTP statuses and ms.
// Cloud WITHOUT a configured key emits no check (not a connection problem).

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
// Groq sits behind Cloudflare: without a browser UA it returns 403/1010
// (same header as the groq provider in config.js).
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const TIMEOUT = Symbol('timeout');

// Race with a cap. NO unref: this timer guards a promise someone
// awaits (same reason as withTimeoutMs in sidecars.js).
function raceTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ms));
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// Network error → short honest detail (never includes keys: none here).
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

// Classifies an HTTP status into ok/not-ok for connectivity pings.
// With auth (Bearer sent): 401/403 = rejected key (failure, must be
// known); any other 4xx = reachable with accepted auth (GETs
// against POST-only endpoints return 404/405/400: expected).
// Without auth (host probe, neither spending nor sending the key): any response = ok.
export function classifyHttp(status, authSent) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return { ok: true };
  if (authSent && (s === 401 || s === 403)) return { ok: false, note: 'key rechazada' };
  if (s === 429) return { ok: true, note: 'rate limit' };
  if (s >= 400 && s < 500) return { ok: true };
  if (s >= 500) return { ok: false, note: 'upstream 5xx' };
  return { ok: false, note: 'sin respuesta' };
}

// Is there a Zen/Jev key on disk? Existence only, content never leaves.
function hasZenKeyFile() {
  try {
    return readFileSync(defaultZenKeyPath(), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

// Cloud targets ONLY for configured keys. Each undefined override =
// real detection (env/settings/disk); passing ''/false = force absent
// (tests). Never probes with dummy keys: no key, no target.
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
  // Groq covers STT and LLM with the same endpoint: a single effective key
  // (stt.groqKey/GROQ_API_KEY or the groq llm provider's), a single check.
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
  // Host probes WITHOUT auth: test DNS+TCP+TLS without spending or sending the key.
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
    // No valid URL: stable fallback host.
  }
  return 'api.groq.com';
}

// Real WS probe: handshake against local /meeting and immediate close.
// Creates an ephemeral server-side MeetingSession (same as a client
// connecting and hanging up instantly; initMeeting only runs on hello).
// Injectable via opts.wsCheck (tests use a fake, 0 real network).
export function defaultWsCheck(url, timeoutMs) {
  const target = url || defaultWsUrl();
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.close(); } catch { /* already closed */ }
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

// Real DNS probe: cheap resolve of the host the LLM uses.
export async function defaultDnsFn(host) {
  const result = await lookup(host || defaultDnsHost());
  return { ok: true, detail: result?.address ? String(result.address) : undefined };
}

// One check: never throws, never hangs longer than timeoutMs.
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
    // Local health: only 2xx counts (a 404 here is a broken sidecar, not reachable).
    return { ok: res?.ok === true, detail: `http ${Number(res?.status) || 0}` };
  };
}

// Full poll. All parallel (Promise.all), timeoutMs cap per check.
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

// ── In-memory snapshot + lazy interval (30s, not in tests) ───────────────
// The endpoint serves the snapshot; the interval refreshes it in background. All
// best-effort: a failed poll leaves the previous snapshot intact.

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

// Tests only.
export function __resetConnectivity() {
  if (timer) clearInterval(timer);
  timer = null;
  snapshot = null;
  inflight = null;
}
