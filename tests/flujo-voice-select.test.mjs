// TV2 — eligible voice engines + selective watchdog.
// STT/TTS selection (order, elected-only, cloud-without-key-skip) and selective
// watchdog (spawn elected-only, kill own-child-non-elected-only,
// parakeet+piper defaults). All with fakes: zero network, zero processes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySettings,
  defaultTtsOrder,
  getTtsOrder,
  initSettings,
  isTtsOrderSet,
  parseTtsOrder,
  publicSettings
} from '../server/lib/settings.js';
import {
  LiveAgentRuntime,
  shouldUseEdgeFallback,
  synthesizeTtsOrdered
} from '../server/lib/agent-runtime.js';
import {
  defaultElectedSidecars,
  isSpecElected,
  shouldRestart,
  startSidecarWatchdog
} from '../server/lib/sidecars.js';

// Mutable store stub (each test file runs in its own process).
const db = new Map();
initSettings(
  {
    getSetting: (k) => (db.has(k) ? db.get(k) : null),
    setSetting: (k, v) => { db.set(k, v); },
    deleteSetting: (k) => { db.delete(k); },
    logChange: () => {}
  },
  { setKeys: () => {} }
);

afterEach(() => {
  db.clear();
});

// ── tts.order: parse + defaults ──────────────────────────────────────────

test('parseTtsOrder: filters unknowns, dedups, tolerates case/spaces', () => {
  assert.deepEqual(parseTtsOrder('piper,supertonic,deepgram,edge'), ['piper', 'supertonic', 'deepgram', 'edge']);
  assert.deepEqual(parseTtsOrder('Piper , PIPER, noexiste, edge'), ['piper', 'edge']);
  assert.deepEqual(parseTtsOrder(''), []);
  assert.deepEqual(parseTtsOrder('???'), []);
});

test('getTtsOrder default = legacy: deepgram → local → edge (local-first keyless)', () => {
  assert.deepEqual(getTtsOrder(), ['deepgram', 'piper', 'supertonic', 'edge']);
  assert.deepEqual(defaultTtsOrder('supertonic'), ['deepgram', 'supertonic', 'piper', 'edge']);
  db.set('tts.engine', 'supertonic');
  assert.deepEqual(getTtsOrder(), ['deepgram', 'supertonic', 'piper', 'edge']);
  assert.equal(isTtsOrderSet(), false);
});

test('getTtsOrder: override wins; invalid falls back to default', () => {
  db.set('tts.order', 'piper');
  assert.deepEqual(getTtsOrder(), ['piper']);
  assert.equal(isTtsOrderSet(), true);
  db.set('tts.order', '???');
  assert.deepEqual(getTtsOrder(), ['deepgram', 'piper', 'supertonic', 'edge']);
});

test('applySettings/publicSettings: tts.order editable, exposed, validated', () => {
  const applied = applySettings({ 'tts.order': 'supertonic,piper' });
  assert.ok(applied.includes('tts.order'));
  assert.equal(publicSettings().tts.order, 'supertonic,piper');
  assert.equal(publicSettings().tts.orderDefault, 'deepgram,piper,supertonic,edge');
  const rejected = applySettings({ 'tts.order': '???' });
  assert.ok(!rejected.includes('tts.order'), 'orden inválido se rechaza');
  assert.equal(publicSettings().tts.order, 'supertonic,piper', 'el anterior queda');
  applySettings({ 'tts.order': '' });
  assert.equal(isTtsOrderSet(), false, 'vacío borra el override');
});

// ── synthesizeTtsOrdered: elected wins, rest out ───────────────────────

const PART = [{ data: 'eA==', mimeType: 'audio/pcm;rate=16000' }];
const boom = async () => { throw new Error('x'); };

function ttsStubs(calls, impls = {}) {
  const runners = {};
  for (const engine of ['piper', 'supertonic', 'deepgram']) {
    const fn = impls[engine] || boom;
    runners[engine] = async () => { calls.push(engine); return fn(); };
  }
  return runners;
}

test('TTS: first to answer wins; the rest are not even tried', async () => {
  const calls = [];
  const { parts, lastError } = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['piper', 'supertonic', 'deepgram'],
    deepgramKey: 'dg-fake',
    runners: ttsStubs(calls, { piper: async () => PART })
  });
  assert.deepEqual(parts, PART);
  assert.equal(lastError, null);
  assert.deepEqual(calls, ['piper']);
});

test('TTS elected-only: 1-engine order, rest out even if they fail', async () => {
  const calls = [];
  const { parts } = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['supertonic'],
    runners: ttsStubs(calls, { supertonic: async () => PART })
  });
  assert.deepEqual(parts, PART);
  assert.deepEqual(calls, ['supertonic']);
});

test('TTS: deepgram without key is not even tried; with key it is', async () => {
  const calls = [];
  const r1 = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['deepgram', 'piper'],
    deepgramKey: '',
    runners: ttsStubs(calls, { piper: async () => PART })
  });
  assert.deepEqual(r1.parts, PART);
  assert.deepEqual(calls, ['piper'], 'sin key: skip silencioso');
  calls.length = 0;
  const r2 = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['deepgram', 'piper'],
    deepgramKey: 'dg-fake',
    runners: ttsStubs(calls, { deepgram: async () => PART, piper: async () => PART })
  });
  assert.deepEqual(r2.parts, PART);
  assert.deepEqual(calls, ['deepgram'], 'con key: primero');
});

test('TTS: edge skipped in parts (resolves in speakSentence); empty/error moves to next', async () => {
  const calls = [];
  const { parts, lastError } = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['edge', 'piper', 'supertonic'],
    runners: ttsStubs(calls, { piper: async () => [], supertonic: async () => PART })
  });
  assert.deepEqual(parts, PART);
  assert.equal(lastError, null);
  assert.deepEqual(calls, ['piper', 'supertonic']);
  // Local error → next + lastError; failed deepgram is silent.
  const calls2 = [];
  const r2 = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1',
    order: ['deepgram', 'piper'],
    deepgramKey: 'dg-fake',
    runners: ttsStubs(calls2, { piper: async () => PART })
  });
  assert.deepEqual(r2.parts, PART);
  assert.equal(r2.lastError, null, 'deepgram fallado no ensucia lastError (legacy)');
  const r3 = await synthesizeTtsOrdered({
    text: 'hola', voice: 'M1', order: ['piper'], runners: ttsStubs([])
  });
  assert.deepEqual(r3.parts, []);
  assert.ok(r3.lastError instanceof Error, 'todo fallado → parts [] + lastError');
});

test('shouldUseEdgeFallback: default yes; order without edge no', () => {
  assert.equal(shouldUseEdgeFallback(), true);
  assert.equal(shouldUseEdgeFallback(['piper']), false);
  assert.equal(shouldUseEdgeFallback(['piper', 'edge']), true);
});

// ── generateAudioParts: delegation with fake fetch (zero network) ─────────────

const AGENTE = { id: 't', name: 'T', voice: 'M1' };

// Minimal valid WAV for wavToPcm (RIFF + fmt + data with 2 samples).
function fakePiperWav() {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(40, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(4, 40);
  return Buffer.concat([header, Buffer.from([1, 0, 2, 0])]);
}

test('generateAudioParts: piper order → only Piper speaks (fake fetch)', async () => {
  db.set('tts.order', 'piper');
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    const wav = fakePiperWav();
    // Real ArrayBuffer (not pooled Buffer): wavToPcm does new DataView().
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    return { ok: true, arrayBuffer: async () => ab };
  });
  try {
    const rt = new LiveAgentRuntime(AGENTE, { hasKeys: () => true }, { recentContext: () => '' }, null);
    const parts = await rt.generateAudioParts('hola', () => {}, null);
    assert.equal(parts.length, 1);
    assert.match(parts[0].mimeType, /rate=22050/);
    assert.equal(urls.length, 1, 'un solo intento');
    assert.match(urls[0], /7791\/v1\/tts/, 'Piper primero y único');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('generateAudioParts: edge/no-key-deepgram order → zero fetches (not even tried)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('fetch inesperado: motor no-elegido intentado'); });
  try {
    const rt = new LiveAgentRuntime(AGENTE, { hasKeys: () => true }, { recentContext: () => '' }, null);
    db.set('tts.order', 'edge');
    assert.deepEqual(await rt.generateAudioParts('hola', () => {}, null), []);
    db.set('tts.order', 'deepgram'); // no key in the store stub
    assert.deepEqual(await rt.generateAudioParts('hola', () => {}, null), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('generateAudioParts keyless default: Piper first (local-first)', async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    const wav = fakePiperWav();
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    return { ok: true, arrayBuffer: async () => ab };
  });
  try {
    const rt = new LiveAgentRuntime(AGENTE, { hasKeys: () => true }, { recentContext: () => '' }, null);
    const parts = await rt.generateAudioParts('hola', () => {}, null);
    assert.equal(parts.length, 1);
    assert.match(urls[0], /7791/, 'sin keys: Piper primero (deepgram skipeado)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Selective watchdog ───────────────────────────────────────────────────

const spec = (name) => ({ name, health: `http://${name}/health`, spawn: { cmd: 'x', args: [name] } });

test('isSpecElected: non-local specs always eligible (legacy fail-open)', () => {
  assert.equal(isSpecElected('x', new Set()), true);
  assert.equal(isSpecElected('parakeet', new Set()), false);
  assert.equal(isSpecElected('parakeet', new Set(['parakeet'])), true);
});

test('shouldRestart: non-elected never spawns (reason not-elected)', () => {
  const r = shouldRestart(spec('whisper'), { downs: 9, restarts: [] }, Date.now(), { elected: false });
  assert.equal(r.restart, false);
  assert.equal(r.reason, 'not-elected');
  const r2 = shouldRestart(spec('whisper'), { downs: 9, restarts: [] });
  assert.equal(r2.restart, true, 'default elected=true (compat)');
});

test('watchdog: spawn elected ONLY; down non-elected does not spawn', async () => {
  const spawns = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [spec('parakeet'), spec('whisper')],
    check: async () => false,
    getElected: () => ['parakeet'],
    spawnFn: async (s) => { spawns.push(s.name); return { pid: 1000 + spawns.length }; },
    onTelemetry: () => {}
  });
  try {
    await wd.tick(Date.now());
    await wd.tick(Date.now());
    assert.deepEqual(spawns, ['parakeet']);
    const status = wd.getStatus();
    assert.equal(status.find((s) => s.name === 'parakeet').elected, true);
    assert.equal(status.find((s) => s.name === 'whisper').elected, false);
  } finally {
    wd.stop();
  }
});

test('watchdog: kill own-child-non-elected ONLY; foreign one untouched', async () => {
  let elected = ['parakeet'];
  const health = { parakeet: false, whisper: true }; // whisper UP ajeno
  const kills = [];
  const events = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [spec('parakeet'), spec('whisper')],
    check: async (url) => health[String(url).includes('parakeet') ? 'parakeet' : 'whisper'],
    getElected: () => elected,
    spawnFn: async (s) => ({ pid: s.name === 'parakeet' ? 4242 : 9999 }),
    killFn: (handle, s) => { kills.push({ name: s.name, pid: handle.pid }); return true; },
    onTelemetry: (type, payload) => events.push({ type, payload })
  });
  try {
    await wd.tick(Date.now());
    await wd.tick(Date.now()); // parakeet elegido+down → spawn (pid 4242)
    assert.equal(kills.length, 0);
    // Tito deselects parakeet: whisper stays UP foreign (not own child).
    elected = [];
    await wd.tick(Date.now());
    assert.deepEqual(kills, [{ name: 'parakeet', pid: 4242 }], 'solo el hijo propio');
    assert.ok(events.some((e) => e.type === 'sidecar_stop'), 'emite sidecar_stop');
    assert.ok(!kills.some((k) => k.name === 'whisper'), 'whisper ajeno UP: ni se toca');
  } finally {
    wd.stop();
  }
});

test('watchdog: broken getElected → fail-open (spawns, never kills)', async () => {
  const spawns = [];
  const kills = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [spec('parakeet')],
    check: async () => false,
    getElected: () => { throw new Error('db rota'); },
    spawnFn: async (s) => { spawns.push(s.name); return { pid: 1 }; },
    killFn: () => { kills.push(1); return true; },
    onTelemetry: () => {}
  });
  try {
    await wd.tick(Date.now());
    await wd.tick(Date.now());
    assert.deepEqual(spawns, ['parakeet'], 'fail-open = pre-TV2');
    assert.equal(kills.length, 0);
  } finally {
    wd.stop();
  }
});

test('defaultElectedSidecars: no settings parakeet+piper; set ones win', () => {
  assert.deepEqual([...defaultElectedSidecars()].sort(), ['parakeet', 'piper']);
  // Real Tito case: cloud-first stt.order with parakeet + unset tts.
  db.set('stt.order', 'deepgram,parakeet,groq');
  assert.deepEqual([...defaultElectedSidecars()].sort(), ['parakeet', 'piper']);
  // Tito picks supertonic: piper out, supertonic in.
  db.set('tts.order', 'supertonic');
  assert.deepEqual([...defaultElectedSidecars()].sort(), ['parakeet', 'supertonic']);
  // STT cloud-only: parakeet out.
  db.set('stt.order', 'deepgram,groq');
  assert.deepEqual([...defaultElectedSidecars()].sort(), ['supertonic']);
});
