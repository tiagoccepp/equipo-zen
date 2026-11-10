// TC — Connectivity monitor: all-fake, 0 real network.
// Sidecars ok/down, cloud with/without key, timeout, DNS fail, WS fail, 401,
// snapshot/loop (does not start in tests) + endpoint with injected snapshot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTIVITY_INTERVAL_MS,
  __resetConnectivity,
  buildCloudTargets,
  checkConnectivity,
  classifyHttp,
  defaultDnsHost,
  defaultWsUrl,
  ensureConnectivityLoop,
  getConnectivitySnapshot,
  isConnectivityTestEnv,
  refreshConnectivitySnapshot,
  setConnectivitySnapshot
} from '../server/lib/connectivity.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
let savedNodeEnv;
let savedVitest;

before(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedVitest = process.env.VITEST;
  process.env.NODE_ENV = 'test';
  delete process.env.VITEST;
});

after(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitest;
  __resetConnectivity();
});

// ── Fakes ────────────────────────────────────────────────────────────────

const resOk = (status = 200) => ({ ok: status >= 200 && status < 300, status });
const fetchOk = async () => resOk(200);
const fetchByUrl = (routes) => async (url) => {
  const entry = routes[String(url)];
  if (entry instanceof Error) throw entry;
  if (typeof entry === 'number') return resOk(entry);
  return resOk(200);
};
const fetchHang = () => new Promise(() => {}); // hangs: the ceiling rescues it
const connRefused = () => {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:7791');
  err.code = 'ECONNREFUSED';
  return err;
};
const dnsFail = () => {
  const err = new Error('getaddrinfo EAI_AGAIN api.groq.com');
  err.code = 'EAI_AGAIN';
  return err;
};

const FAKE_SIDECARS = [
  { name: 'parakeet', health: 'http://127.0.0.1:7790/health' },
  { name: 'piper', health: 'http://127.0.0.1:7791/health' }
];
const FAKE_CLOUD = [
  { name: 'cloud:deepgram', url: 'https://api.deepgram.com/v1/projects', headers: {}, authSent: true }
];
const wsOk = async () => ({ ok: true });
const dnsOk = async () => ({ ok: true, detail: '1.2.3.4' });

function baseOpts(over = {}) {
  return {
    fetchFn: fetchOk,
    dnsFn: dnsOk,
    dnsHost: 'api.fake.test',
    wsCheck: wsOk,
    wsUrl: 'ws://127.0.0.1:1/meeting',
    sidecars: FAKE_SIDECARS,
    cloud: FAKE_CLOUD,
    timeoutMs: 500,
    ...over
  };
}

// ── checkConnectivity ────────────────────────────────────────────────────

test('all ok → online with named checks and ts', async () => {
  const r = await checkConnectivity(baseOpts());
  assert.equal(r.online, true);
  assert.equal(r.status, 'online');
  assert.equal(typeof r.ts, 'number');
  const names = r.checks.map((c) => c.name);
  assert.deepEqual(names, [
    'sidecar:parakeet',
    'sidecar:piper',
    'ws:/meeting',
    'dns:api.fake.test',
    'cloud:deepgram'
  ]);
  for (const c of r.checks) {
    assert.equal(c.ok, true, `${c.name} ok`);
    assert.equal(typeof c.ms, 'number');
    assert.ok(c.ms >= 0 && c.ms < 500, `${c.name} ms=${c.ms}`);
  }
});

test('real defaults: repo sidecars + ws/dns hosts (fake fetch/ws/dns)', async () => {
  const r = await checkConnectivity({
    fetchFn: fetchOk,
    wsCheck: wsOk,
    dnsFn: dnsOk,
    cloud: [],
    timeoutMs: 500
  });
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('sidecar:parakeet'));
  assert.ok(names.includes('sidecar:piper'));
  assert.ok(names.includes('sidecar:whisper'));
  assert.ok(names.includes('sidecar:supertonic'));
  assert.ok(names.includes('ws:/meeting'));
  assert.ok(names.some((n) => n.startsWith('dns:')), `dns presente: ${names}`);
  assert.equal(r.online, true);
  assert.equal(typeof defaultWsUrl(), 'string');
  assert.equal(typeof defaultDnsHost(), 'string');
});

test('down sidecar (conn refused) → degraded + honest detail', async () => {
  const r = await checkConnectivity(baseOpts({
    fetchFn: fetchByUrl({ 'http://127.0.0.1:7791/health': connRefused() })
  }));
  assert.equal(r.online, false);
  assert.equal(r.status, 'degraded');
  const piper = r.checks.find((c) => c.name === 'sidecar:piper');
  assert.equal(piper.ok, false);
  assert.equal(piper.detail, 'conn refused');
  assert.equal(r.checks.find((c) => c.name === 'sidecar:parakeet').ok, true);
});

test('sidecar with http 500 → ok=false (local health requires 2xx)', async () => {
  const r = await checkConnectivity(baseOpts({
    fetchFn: fetchByUrl({ 'http://127.0.0.1:7790/health': 500 })
  }));
  const pk = r.checks.find((c) => c.name === 'sidecar:parakeet');
  assert.equal(pk.ok, false);
  assert.match(pk.detail, /http 500/);
});

test('timeout everywhere → offline, nothing hangs', async () => {
  const started = Date.now();
  const r = await checkConnectivity(baseOpts({
    fetchFn: fetchHang,
    dnsFn: () => fetchHang(),
    wsCheck: () => fetchHang(),
    timeoutMs: 40
  }));
  assert.ok(Date.now() - started < 5000, 'techo por check, no suma lineal');
  assert.equal(r.online, false);
  assert.equal(r.status, 'offline');
  assert.ok(r.checks.length > 0);
  for (const c of r.checks) {
    assert.equal(c.ok, false);
    assert.equal(c.detail, 'timeout', c.name);
  }
});

test('dns fail → degraded with dns fail detail', async () => {
  const r = await checkConnectivity(baseOpts({
    dnsFn: async () => { throw dnsFail(); }
  }));
  assert.equal(r.status, 'degraded');
  const dns = r.checks.find((c) => c.name.startsWith('dns:'));
  assert.equal(dns.ok, false);
  assert.equal(dns.detail, 'dns fail');
});

test('ws fail → degraded with probe detail', async () => {
  const r = await checkConnectivity(baseOpts({
    wsCheck: async () => ({ ok: false, detail: 'conn refused' })
  }));
  assert.equal(r.status, 'degraded');
  const ws = r.checks.find((c) => c.name === 'ws:/meeting');
  assert.equal(ws.ok, false);
  assert.equal(ws.detail, 'conn refused');
});

test('ws that throws → ok=false, does not take down the rest', async () => {
  const r = await checkConnectivity(baseOpts({
    wsCheck: async () => { throw new Error('boom'); }
  }));
  assert.equal(r.checks.find((c) => c.name === 'ws:/meeting').ok, false);
  assert.equal(r.checks.find((c) => c.name === 'sidecar:parakeet').ok, true);
});

test('cloud 401 → ok=false (rejected key) and NO key in the result', async () => {
  const MARKER = 'SECRETO-XYZ-123';
  const r = await checkConnectivity(baseOpts({
    cloud: [{
      name: 'cloud:deepgram',
      url: 'https://api.deepgram.com/v1/projects',
      headers: { Authorization: `Bearer ${MARKER}` },
      authSent: true
    }],
    fetchFn: fetchByUrl({ 'https://api.deepgram.com/v1/projects': 401 })
  }));
  const dg = r.checks.find((c) => c.name === 'cloud:deepgram');
  assert.equal(dg.ok, false);
  assert.match(dg.detail, /http 401/);
  assert.match(dg.detail, /key rechazada/);
  assert.ok(!JSON.stringify(r).includes(MARKER), 'la key no sale en el resultado');
  assert.equal(r.status, 'degraded');
});

test('cloud GET on POST-only (405) with auth → ok=true reachable', async () => {
  const r = await checkConnectivity(baseOpts({
    cloud: [{ name: 'cloud:llm-minimax', url: 'https://x.test/chat', headers: {}, authSent: true }],
    fetchFn: fetchByUrl({ 'https://x.test/chat': 405 })
  }));
  const llm = r.checks.find((c) => c.name === 'cloud:llm-minimax');
  assert.equal(llm.ok, true);
  assert.match(llm.detail, /http 405/);
});

test('classifyHttp: status matrix', () => {
  assert.deepEqual(classifyHttp(200, true), { ok: true });
  assert.deepEqual(classifyHttp(401, true), { ok: false, note: 'key rechazada' });
  assert.deepEqual(classifyHttp(403, true), { ok: false, note: 'key rechazada' });
  assert.deepEqual(classifyHttp(401, false), { ok: true }); // host probe: responds = ok
  assert.deepEqual(classifyHttp(404, true), { ok: true });
  assert.deepEqual(classifyHttp(429, true), { ok: true, note: 'rate limit' });
  assert.deepEqual(classifyHttp(500, true), { ok: false, note: 'upstream 5xx' });
  assert.deepEqual(classifyHttp(0, true), { ok: false, note: 'sin respuesta' });
});

// ── buildCloudTargets: only with key ──────────────────────────────────────

const NO_KEYS = {
  llmProvider: 'minimax',
  llmKey: '',
  llmUrl: 'https://api.minimax.io/v1/chat/completions',
  groqKey: '',
  deepgramKey: '',
  hasZenKey: false,
  braveKey: '',
  tavilyKey: ''
};

test('without keys → zero targets (never tests with dummies)', () => {
  assert.deepEqual(buildCloudTargets(NO_KEYS), []);
});

test('with keys → targets with auth; probes without auth send no Bearer', () => {
  const targets = buildCloudTargets({
    ...NO_KEYS,
    llmKey: 'K1',
    groqKey: 'K2',
    deepgramKey: 'K3',
    hasZenKey: true,
    braveKey: 'K4',
    tavilyKey: 'K5'
  });
  const byName = Object.fromEntries(targets.map((t) => [t.name, t]));
  assert.equal(targets.length, 6, JSON.stringify(targets.map((t) => t.name)));
  assert.match(byName['cloud:deepgram'].headers.Authorization, /^Bearer /);
  assert.match(byName['cloud:groq'].headers.Authorization, /^Bearer /);
  assert.ok(byName['cloud:groq'].headers['User-Agent'], 'UA anti-Cloudflare');
  assert.match(byName['cloud:llm-minimax'].headers.Authorization, /^Bearer /);
  for (const n of ['cloud:zen', 'cloud:brave', 'cloud:tavily']) {
    assert.equal(byName[n].headers.Authorization, undefined, `${n} sin Bearer`);
    assert.equal(byName[n].authSent, false);
    assert.equal(byName[n].extraDetail, 'key presente');
  }
});

test('groq provider uses a single effective key, without duplicating checks', () => {
  const targets = buildCloudTargets({ ...NO_KEYS, llmProvider: 'groq', llmKey: 'K9' });
  assert.deepEqual(targets.map((t) => t.name), ['cloud:groq']);
  assert.match(targets[0].headers.Authorization, /^Bearer K9$/);
});

// ── Snapshot + loop ──────────────────────────────────────────────────────

test('test env detected: the loop does not start', () => {
  assert.equal(isConnectivityTestEnv(), true);
  assert.equal(ensureConnectivityLoop(), null);
  assert.equal(CONNECTIVITY_INTERVAL_MS, 30000);
});

test('snapshot roundtrip + refresh with fakes', async () => {
  __resetConnectivity();
  assert.equal(getConnectivitySnapshot(), null);
  const seed = { online: true, status: 'online', checks: [], ts: Date.now() };
  setConnectivitySnapshot(seed);
  assert.equal(getConnectivitySnapshot(), seed);
  const fresh = await refreshConnectivitySnapshot(baseOpts());
  assert.equal(fresh.online, true);
  assert.equal(getConnectivitySnapshot(), fresh);
  __resetConnectivity();
  assert.equal(getConnectivitySnapshot(), null);
});

// ── Additive endpoint ─────────────────────────────────────────────────────

test('GET /api/connectivity serves injected snapshot, 0 network', async () => {
  const { createApp } = await import('../server/lib/http.js');
  const seed = {
    online: false,
    status: 'degraded',
    checks: [{ name: 'sidecar:piper', ok: false, ms: 3, detail: 'conn refused' }],
    ts: Date.now()
  };
  setConnectivitySnapshot(seed);
  const app = createApp({ store: {} });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connectivity`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), seed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    __resetConnectivity();
  }
});

// ── Track guardrails ─────────────────────────────────────────────────

test('source: no banned imports or logs', () => {
  const src = readFileSync(join(HERE, '..', 'server', 'lib', 'connectivity.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (const banned of ['turn-pipeline', 'agent-runtime', 'manos-', 'skills', 'spawn', 'console.log']) {
    assert.ok(!code.includes(banned), `connectivity.js no debe usar ${banned}`);
  }
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), [
    './addressing.js',
    './config.js',
    './settings.js',
    './sidecars.js',
    'node:dns/promises',
    'node:fs',
    'ws'
  ]);
});
