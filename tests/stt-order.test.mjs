import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  transcribePartial,
  transcribeWithFallback,
  __resetParakeetHealth
} from '../server/lib/stt.js';
import {
  DEFAULT_STT_ORDER,
  getSttOrder,
  initSettings,
  isSttOrderSet,
  parseSttOrder
} from '../server/lib/settings.js';
import {
  CaptureTranscriberRuntime,
  PARTIAL_CONFIG,
  __setPartialFn
} from '../server/lib/transcriber.js';
import { telemetry } from '../server/lib/telemetry.js';

// Mutable store stub: initSettings lives at module level (each test file
// runs in its own process, does not contaminate others).
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

const ok = (text) => async () => text;
const okConf = (text, confidence) => async () => ({ text, confidence });
const boom = async () => {
  throw new Error('x');
};
const shortWav = 'A'.repeat(4000); // ~3KB → short turn (<10s)

const savedPartial = { ...PARTIAL_CONFIG };
afterEach(() => {
  db.clear();
  __resetParakeetHealth();
  __setPartialFn(null);
  Object.assign(PARTIAL_CONFIG, savedPartial);
  telemetry.reset();
});

function engineStubs(calls, { parakeet = boom, whisper = boom, groq = boom, deepgram = boom } = {}) {
  const wrap = (name, fn) => async (wav) => {
    calls.push(name);
    return fn(wav);
  };
  return {
    parakeetFn: wrap('parakeet', parakeet),
    whisperFn: wrap('whisper', whisper),
    groqFn: wrap('groq', groq),
    deepgramFn: wrap('deepgram', deepgram)
  };
}

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ── parseSttOrder / getSttOrder ────────────────────────────────────────

test('order: default without store is parakeet,groq,deepgram', () => {
  assert.equal(DEFAULT_STT_ORDER, 'parakeet,groq,deepgram');
  assert.deepEqual(getSttOrder(), ['parakeet', 'groq', 'deepgram']);
  assert.equal(isSttOrderSet(), false);
});

test('order: parse filters unknowns, lowercase, dedupes', () => {
  assert.deepEqual(parseSttOrder('Groq, PARakeet, groq, xxx, deepgram'), ['groq', 'parakeet', 'deepgram']);
  assert.deepEqual(parseSttOrder('  , ,'), []);
  assert.deepEqual(parseSttOrder(''), []);
});

test('order: legacy alias local = parakeet+whisper', () => {
  assert.deepEqual(parseSttOrder('local,groq'), ['parakeet', 'whisper', 'groq']);
});

test('order: DB rules when set', () => {
  db.set('stt.order', 'deepgram,groq');
  db.set('stt.provider', 'local');
  assert.equal(isSttOrderSet(), true);
  assert.deepEqual(getSttOrder(), ['deepgram', 'groq']);
});

test('order: without override respects legacy stt.provider', () => {
  db.set('stt.provider', 'groq');
  assert.deepEqual(getSttOrder(), ['groq', 'deepgram']);
  db.set('stt.provider', 'deepgram');
  assert.deepEqual(getSttOrder(), ['deepgram', 'groq']);
  db.set('stt.provider', 'browser');
  assert.deepEqual(getSttOrder(), []);
  db.set('stt.provider', 'local');
  assert.deepEqual(getSttOrder(), ['parakeet', 'groq', 'deepgram']);
});

test('order: invalid override falls to the provider default', () => {
  db.set('stt.order', 'xxx,yyy');
  assert.deepEqual(getSttOrder(), ['parakeet', 'groq', 'deepgram']);
});

// ── transcribeWithFallback with order ───────────────────────────────────

test('order: respects the sequence and stops at the first success', async () => {
  const calls = [];
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', groqKey: 'g', deepgramKey: 'd',
    order: ['groq', 'parakeet', 'deepgram'],
    ...engineStubs(calls, { groq: boom, parakeet: ok('hola pk') })
  });
  assert.deepEqual(r, { text: 'hola pk', source: 'parakeet' });
  assert.deepEqual(calls, ['groq', 'parakeet']);
});

test('order: empty from one engine moves to the next', async () => {
  const calls = [];
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', groqKey: 'g', deepgramKey: 'd',
    order: ['parakeet', 'whisper'],
    ...engineStubs(calls, { parakeet: ok('   '), whisper: okConf('hola ws', 0.9) })
  });
  assert.deepEqual(r, { text: 'hola ws', source: 'whisper' });
  assert.deepEqual(calls, ['parakeet', 'whisper']);
});

test('order: cloud without key is not even tried', async () => {
  const calls = [];
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: 'h', groqKey: '', deepgramKey: '',
    order: ['groq', 'deepgram', 'parakeet'],
    ...engineStubs(calls, { parakeet: ok('hola') })
  });
  assert.deepEqual(r, { text: 'hola', source: 'parakeet' });
  assert.deepEqual(calls, ['parakeet']);
});

test('order: everything fails → hint → throws the first error', async () => {
  const calls = [];
  const args = {
    wavBase64: shortWav, groqKey: 'g', deepgramKey: 'd',
    order: ['parakeet', 'groq', 'deepgram'],
    ...engineStubs(calls)
  };
  const r = await transcribeWithFallback({ ...args, hint: 'hola hint' });
  assert.deepEqual(r, { text: 'hola hint', source: 'client' });
  assert.deepEqual(calls, ['parakeet', 'groq', 'deepgram']);
  calls.length = 0;
  await assert.rejects(() => transcribeWithFallback({ ...args, hint: '' }), /x/);
  assert.deepEqual(calls, ['parakeet', 'groq', 'deepgram']);
});

test('order: [] → direct hint or throws', async () => {
  const r = await transcribeWithFallback({ wavBase64: shortWav, hint: 'h', order: [] });
  assert.deepEqual(r, { text: 'h', source: 'client' });
  await assert.rejects(() => transcribeWithFallback({ wavBase64: shortWav, hint: '', order: [] }));
});

test('order: unknown engines are ignored', async () => {
  const calls = [];
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', groqKey: 'g',
    order: ['xxx', 'groq'],
    ...engineStubs(calls, { groq: ok('hola g') })
  });
  assert.deepEqual(r, { text: 'hola g', source: 'groq' });
  assert.deepEqual(calls, ['groq']);
});

test('order: low-confidence retry with deepgram outside the order', async () => {
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', groqKey: '', deepgramKey: 'd',
    order: ['parakeet'],
    parakeetFn: okConf('dudoso', 0.2),
    deepgramFn: async () => { dg++; return { text: 'claro', confidence: 0.98 }; }
  });
  assert.deepEqual(r, { text: 'claro', source: 'deepgram' });
  assert.equal(dg, 1);
});

test('order: retry does NOT duplicate deepgram if already in the order', async () => {
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', groqKey: '', deepgramKey: 'd',
    order: ['parakeet', 'deepgram'],
    parakeetFn: okConf('dudoso', 0.2),
    deepgramFn: async () => { dg++; return { text: 'claro', confidence: 0.98 }; }
  });
  assert.deepEqual(r, { text: 'claro', source: 'deepgram' });
  assert.equal(dg, 1);
});

test('order: without order uses legacy provider (compat)', async () => {
  const r = await transcribeWithFallback({
    wavBase64: shortWav, hint: '', provider: 'local', groqKey: '',
    localFn: ok('hola legacy'), groqFn: boom
  });
  assert.deepEqual(r, { text: 'hola legacy', source: 'local' });
});

// ── transcribePartial ──────────────────────────────────────────────────

test('partial: never throws (closed ports → "")', async () => {
  const r = await transcribePartial(shortWav, {
    parakeetUrl: 'http://127.0.0.1:1',
    whisperUrl: 'http://127.0.0.1:2'
  });
  assert.equal(r, '');
  __resetParakeetHealth();
  const w = await transcribePartial(shortWav, {
    engine: 'whisper',
    whisperUrl: 'http://127.0.0.1:2'
  });
  assert.equal(w, '');
});

// ── Partials in CaptureTranscriberRuntime ──────────────────────────────

function makeRuntime() {
  const emitted = [];
  const rt = new CaptureTranscriberRuntime({
    emit: (m) => { emitted.push(m); },
    onTranscript: () => {}
  });
  return { rt, emitted };
}

function bigChunk(bytes = 20000) {
  return Buffer.alloc(bytes).toString('base64');
}

test('partial: by accumulated bytes emits user_audio_transcript_delta', async () => {
  const { rt, emitted } = makeRuntime();
  __setPartialFn(async () => 'hola mundo parcial');
  PARTIAL_CONFIG.minBytes = 10000;
  PARTIAL_CONFIG.minIntervalMs = 0;
  await rt.sendAudio(bigChunk());
  await flush();
  const deltas = emitted.filter((m) => m.type === 'user_audio_transcript_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].text, 'hola mundo parcial');
});

test('partial: single-flight (one decode at a time)', async () => {
  const { rt, emitted } = makeRuntime();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  __setPartialFn(async () => { calls++; await gate; return 'hola single'; });
  PARTIAL_CONFIG.minBytes = 1000;
  PARTIAL_CONFIG.minIntervalMs = 0;
  await rt.sendAudio(bigChunk());
  await rt.sendAudio(bigChunk());
  await rt.sendAudio(bigChunk());
  await flush(20);
  assert.equal(calls, 1);
  release();
  await flush();
  const deltas = emitted.filter((m) => m.type === 'user_audio_transcript_delta');
  assert.equal(deltas.length, 1);
});

test('partial: respects minimum interval', async () => {
  const { rt, emitted } = makeRuntime();
  let calls = 0;
  __setPartialFn(async () => { calls++; return 't'; });
  PARTIAL_CONFIG.minBytes = 1000;
  PARTIAL_CONFIG.minIntervalMs = 60000;
  await rt.sendAudio(bigChunk());
  await flush();
  await rt.sendAudio(bigChunk());
  await flush();
  assert.equal(calls, 1);
});

test('partial: junk and errors neither emit nor break', async () => {
  const { rt, emitted } = makeRuntime();
  PARTIAL_CONFIG.minBytes = 1000;
  PARTIAL_CONFIG.minIntervalMs = 0;
  __setPartialFn(async () => 'thank you');
  await rt.sendAudio(bigChunk());
  await flush();
  __setPartialFn(boom);
  await rt.sendAudio(bigChunk());
  await flush();
  assert.deepEqual(emitted.filter((m) => m.type === 'user_audio_transcript_delta'), []);
});

test('partial: finalize is not contaminated by partials', async () => {
  const { rt, emitted } = makeRuntime();
  __setPartialFn(async () => 'hola parcial');
  PARTIAL_CONFIG.minBytes = 1000;
  PARTIAL_CONFIG.minIntervalMs = 0;
  await rt.sendAudio(bigChunk());
  await flush();
  rt.finalize('hola final distinto', 'parakeet');
  const finals = emitted.filter((m) => m.type === 'user_audio_turn_final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'hola final distinto');
  assert.equal(finals[0].source, 'parakeet');
});
