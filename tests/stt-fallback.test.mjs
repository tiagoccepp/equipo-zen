import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CONFIDENCE_RETRY_MAX_SECS,
  LOW_CONFIDENCE_RETRY_MAX,
  PARAKEET_TIMEOUT_MS,
  __resetParakeetHealth,
  buildWavBase64FromPcmChunks,
  isParakeetAvailable,
  postTranscribe,
  transcribeLocal,
  transcribeWithFallback,
  wavSecondsEstimate
} from '../server/lib/stt.js';
import { getSttMinConfidence } from '../server/lib/settings.js';
import { telemetry } from '../server/lib/telemetry.js';

// Stubs STT: cada test levanta sus sidecars falsos en 127.0.0.1 con puerto
// efímero. Nada toca red real ni necesita keys ni sidecars de verdad.
function stubSidecar({ healthStatus = 200, onTranscribe = null, transcribeDelayMs = 0 } = {}) {
  const hits = { health: 0, transcribe: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      hits.health++;
      res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: healthStatus === 200 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/transcribe') {
      hits.transcribe++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const reply = onTranscribe ? onTranscribe(JSON.parse(raw || '{}')) : { text: 'hola stub' };
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply));
        }, transcribeDelayMs);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() });
    });
  });
}

// WAV corto (~0.1s de silencio): elegible para reintento por confianza.
function shortWav() {
  return buildWavBase64FromPcmChunks([Buffer.alloc(3200).toString('base64')]);
}

// WAV largo (~11s): NO elegible para reintento por confianza.
function longWav() {
  return Buffer.alloc(44 + 32000 * 11).toString('base64');
}

const ok = (text) => async () => text;
const okConf = (text, confidence) => async () => ({ text, confidence });
const boom = async () => {
  throw new Error('x');
};

afterEach(() => {
  __resetParakeetHealth();
});

// ── Constantes y settings ──────────────────────────────────────────────

test('stt: PARAKEET_TIMEOUT_MS=8s y retry solo bajo 0.4 + turno <10s', () => {
  assert.equal(PARAKEET_TIMEOUT_MS, 8000);
  assert.equal(LOW_CONFIDENCE_RETRY_MAX, 0.4);
  assert.equal(CONFIDENCE_RETRY_MAX_SECS, 10);
});

test('stt: stt.minConfidence default 0.55 sin store', () => {
  assert.equal(getSttMinConfidence(), 0.55);
});

test('stt: wavSecondsEstimate mide corto vs largo', () => {
  assert.ok(wavSecondsEstimate(shortWav()) < 10);
  assert.ok(wavSecondsEstimate(longWav()) >= 10);
  assert.equal(wavSecondsEstimate(''), 0);
});

// ── Healthcheck ────────────────────────────────────────────────────────

test('stt: health OK → true y NO se cachea (cada llamada pega)', async () => {
  const pk = await stubSidecar();
  try {
    assert.equal(await isParakeetAvailable(pk.url), true);
    assert.equal(await isParakeetAvailable(pk.url), true);
    assert.equal(pk.hits.health, 2);
  } finally {
    pk.close();
  }
});

test('stt: health DOWN → false y SE cachea 15s (2ª llamada no pega)', async () => {
  const pk = await stubSidecar({ healthStatus: 500 });
  try {
    assert.equal(await isParakeetAvailable(pk.url), false);
    assert.equal(await isParakeetAvailable(pk.url), false);
    assert.equal(pk.hits.health, 1);
  } finally {
    pk.close();
  }
});

test('stt: puerto cerrado → false (caído, no cuelga)', async () => {
  assert.equal(await isParakeetAvailable('http://127.0.0.1:1'), false);
});

// ── postTranscribe ─────────────────────────────────────────────────────

test('stt: postTranscribe devuelve { text, confidence }', async () => {
  const ws = await stubSidecar({ onTranscribe: () => ({ text: '  hola  ', confidence: 0.87 }) });
  try {
    const res = await postTranscribe(ws.url, 'AAA', { withModel: true });
    assert.deepEqual(res, { text: 'hola', confidence: 0.87 });
  } finally {
    ws.close();
  }
});

test('stt: postTranscribe sin confidence → null (ej. Parakeet greedy)', async () => {
  const pk = await stubSidecar({ onTranscribe: () => ({ text: 'hola' }) });
  try {
    const res = await postTranscribe(pk.url, 'AAA');
    assert.deepEqual(res, { text: 'hola', confidence: null });
  } finally {
    pk.close();
  }
});

test('stt: postTranscribe respeta timeoutMs (stub lento aborta)', async () => {
  const slow = await stubSidecar({ onTranscribe: () => ({ text: 'tarde' }), transcribeDelayMs: 1500 });
  try {
    await assert.rejects(() => postTranscribe(slow.url, 'AAA', { timeoutMs: 150 }));
  } finally {
    slow.close();
  }
});

// ── transcribeLocal: parakeet → whisper ────────────────────────────────

test('stt: local parakeet ok → no toca whisper', async () => {
  const pk = await stubSidecar({ onTranscribe: () => ({ text: 'de parakeet' }) });
  const ws = await stubSidecar({ onTranscribe: () => ({ text: 'de whisper' }) });
  try {
    const res = await transcribeLocal(shortWav(), { parakeetUrl: pk.url, whisperUrl: ws.url });
    assert.equal(res.text, 'de parakeet');
    assert.equal(ws.hits.transcribe, 0);
  } finally {
    pk.close();
    ws.close();
  }
});

test('stt: local parakeet caído (health down) → salta directo a whisper', async () => {
  const pk = await stubSidecar({ healthStatus: 500, onTranscribe: () => ({ text: 'de parakeet' }) });
  const ws = await stubSidecar({ onTranscribe: () => ({ text: 'de whisper', confidence: 0.9 }) });
  try {
    const res = await transcribeLocal(shortWav(), { parakeetUrl: pk.url, whisperUrl: ws.url });
    assert.equal(res.text, 'de whisper');
    assert.equal(pk.hits.transcribe, 0);
  } finally {
    pk.close();
    ws.close();
  }
});

test('stt: local parakeet lento → timeout inyectable degrada a whisper', async () => {
  const pk = await stubSidecar({ onTranscribe: () => ({ text: 'de parakeet' }), transcribeDelayMs: 1500 });
  const ws = await stubSidecar({ onTranscribe: () => ({ text: 'de whisper' }) });
  try {
    const started = Date.now();
    const res = await transcribeLocal(shortWav(), { parakeetUrl: pk.url, whisperUrl: ws.url, parakeetTimeoutMs: 150 });
    assert.equal(res.text, 'de whisper');
    assert.ok(Date.now() - started < 1400, 'degradó sin esperar al lento');
  } finally {
    pk.close();
    ws.close();
  }
});

test('stt: local parakeet vacío → cae a whisper', async () => {
  const pk = await stubSidecar({ onTranscribe: () => ({ text: '   ' }) });
  const ws = await stubSidecar({ onTranscribe: () => ({ text: 'de whisper' }) });
  try {
    const res = await transcribeLocal(shortWav(), { parakeetUrl: pk.url, whisperUrl: ws.url });
    assert.equal(res.text, 'de whisper');
  } finally {
    pk.close();
    ws.close();
  }
});

// ── Orden completo: local → groq → deepgram → hint ─────────────────────

test('stt: orden local ok (alta confianza) → groq/deepgram ni se llaman', async () => {
  let groq = 0;
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: 'hint', provider: 'local',
    groqKey: 'gsk-x', deepgramKey: 'dg-x',
    localFn: okConf('hola local', 0.95),
    groqFn: async () => { groq++; return 'g'; },
    deepgramFn: async () => { dg++; return { text: 'd', confidence: 0.9 }; }
  });
  assert.deepEqual(r, { text: 'hola local', source: 'local' });
  assert.equal(groq, 0);
  assert.equal(dg, 0);
});

test('stt: orden local falla → groq → deepgram → hint → lanza', async () => {
  const calls = [];
  const localFn = async () => { calls.push('local'); throw new Error('local down'); };
  const groqFn = async () => { calls.push('groq'); throw new Error('groq down'); };
  const deepgramFn = async () => { calls.push('dg'); throw new Error('dg down'); };

  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: 'hola hint', provider: 'local',
    groqKey: 'gsk-x', deepgramKey: 'dg-x', localFn, groqFn, deepgramFn
  });
  assert.deepEqual(r, { text: 'hola hint', source: 'client' });
  assert.deepEqual(calls, ['local', 'groq', 'dg']);

  calls.length = 0;
  await assert.rejects(() => transcribeWithFallback({
    wavBase64: shortWav(), hint: '', provider: 'local',
    groqKey: 'gsk-x', deepgramKey: 'dg-x', localFn, groqFn, deepgramFn
  }));
  assert.deepEqual(calls, ['local', 'groq', 'dg']);
});

test('stt: orden sin keys → local → hint (salta nubes)', async () => {
  let groq = 0;
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: 'hola hint', provider: 'local',
    groqKey: '', deepgramKey: '',
    localFn: boom,
    groqFn: async () => { groq++; return 'g'; },
    deepgramFn: async () => { dg++; return { text: 'd', confidence: 1 }; }
  });
  assert.deepEqual(r, { text: 'hola hint', source: 'client' });
  assert.equal(groq, 0);
  assert.equal(dg, 0);
});

// ── Reintento por baja confianza (§2e) ──────────────────────────────────

test('stt: retry confianza 0.2 + turno corto + key → deepgram, source deepgram', async () => {
  telemetry.reset();
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: '', provider: 'local',
    groqKey: '', deepgramKey: 'dg-x',
    localFn: okConf('dudoso', 0.2),
    groqFn: boom,
    deepgramFn: async () => { dg++; return { text: 'claro', confidence: 0.98 }; }
  });
  assert.deepEqual(r, { text: 'claro', source: 'deepgram' });
  assert.equal(dg, 1);
  const retries = telemetry.list(50).filter((e) => e.type === 'stt_retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].payload.retried, true);
});

test('stt: retry NO dispara sin key de deepgram', async () => {
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: '', provider: 'local',
    groqKey: '', deepgramKey: '',
    localFn: okConf('dudoso', 0.1),
    groqFn: boom,
    deepgramFn: async () => { dg++; return { text: 'x', confidence: 1 }; }
  });
  assert.deepEqual(r, { text: 'dudoso', source: 'local' });
  assert.equal(dg, 0);
});

test('stt: retry NO dispara con turno largo (11s)', async () => {
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: longWav(), hint: '', provider: 'local',
    groqKey: '', deepgramKey: 'dg-x',
    localFn: okConf('dudoso largo', 0.1),
    groqFn: boom,
    deepgramFn: async () => { dg++; return { text: 'x', confidence: 1 }; }
  });
  assert.deepEqual(r, { text: 'dudoso largo', source: 'local' });
  assert.equal(dg, 0);
});

test('stt: retry NO dispara con confianza alta ni sin confianza', async () => {
  let dg = 0;
  const dgFn = async () => { dg++; return { text: 'x', confidence: 1 }; };
  const base = { wavBase64: shortWav(), hint: '', provider: 'local', groqKey: '', deepgramKey: 'dg-x', groqFn: boom, deepgramFn: dgFn };
  const r1 = await transcribeWithFallback({ ...base, localFn: okConf('seguro', 0.9) });
  assert.deepEqual(r1, { text: 'seguro', source: 'local' });
  const r2 = await transcribeWithFallback({ ...base, localFn: ok('sin confianza') });
  assert.deepEqual(r2, { text: 'sin confianza', source: 'local' });
  assert.equal(dg, 0);
});

test('stt: retry que falla → vale el texto local original', async () => {
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: '', provider: 'local',
    groqKey: '', deepgramKey: 'dg-x',
    localFn: okConf('dudoso', 0.25),
    groqFn: boom,
    deepgramFn: boom
  });
  assert.deepEqual(r, { text: 'dudoso', source: 'local' });
});

test('stt: retry respeta minConfidence bajo (0.3): 0.35 no reintenta', async () => {
  let dg = 0;
  const r = await transcribeWithFallback({
    wavBase64: shortWav(), hint: '', provider: 'local',
    groqKey: '', deepgramKey: 'dg-x', minConfidence: 0.3,
    localFn: okConf('medio', 0.35),
    groqFn: boom,
    deepgramFn: async () => { dg++; return { text: 'x', confidence: 1 }; }
  });
  assert.deepEqual(r, { text: 'medio', source: 'local' });
  assert.equal(dg, 0);
});
