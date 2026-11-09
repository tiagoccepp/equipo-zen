import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KEEPALIVE_INTERVAL_MS,
  firstNonEmpty,
  loadWarmupWavBase64,
  maybeWarnSwap,
  nextKeepaliveAt,
  parseSwapPressure,
  pcmToWav16kBase64,
  postKeepalive,
  shouldKeepalive,
  shouldWarnSwap,
  startSidecarWatchdog,
  withTimeoutMs
} from '../server/lib/sidecars.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'parakeet-warmup.wav');
const PARAKEET = { name: 'parakeet', health: 'http://127.0.0.1:7790/health', spawn: { cmd: 'python3', args: ['s.py'] } };

// Parsea header WAV → {rate, channels, bits, samples, dataOffset}.
function parseWavHeader(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  return {
    rate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bits: buf.readUInt16LE(34),
    samples: buf.readUInt32LE(40) / 2,
    dataOffset: 44
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('fixture warmup existe y es válido (16k mono, 0.5-1s, no silencio)', () => {
  const buf = readFileSync(FIXTURE);
  const h = parseWavHeader(buf);
  assert.equal(h.rate, 16000);
  assert.equal(h.channels, 1);
  assert.equal(h.bits, 16);
  const secs = h.samples / 16000;
  assert.ok(secs >= 0.5 && secs <= 1.0, `duración ${secs}s fuera de rango`);
  // RMS alto = habla/chirp real, no silencio (el silencio emite ~0 tokens).
  let sum = 0;
  for (let i = 0; i < h.samples; i++) {
    const v = buf.readInt16LE(h.dataOffset + i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / h.samples);
  assert.ok(rms > 0.05, `RMS ${rms}: el fixture parece silencio`);
});

test('loadWarmupWavBase64 devuelve el fixture como base64 válido', () => {
  const b64 = loadWarmupWavBase64();
  assert.ok(typeof b64 === 'string' && b64.length > 1000);
  const buf = Buffer.from(b64, 'base64');
  const h = parseWavHeader(buf);
  assert.equal(h.rate, 16000);
  assert.equal(h.channels, 1);
});

test('firstNonEmpty elige Piper → fixture → silencio', () => {
  assert.equal(firstNonEmpty('piper', 'fixture', 'silencio'), 'piper');
  assert.equal(firstNonEmpty(null, 'fixture', 'silencio'), 'fixture');
  assert.equal(firstNonEmpty('', null, 'silencio'), 'silencio');
  assert.equal(firstNonEmpty(null, '', null), null);
});

test('pcmToWav16kBase64 resamplea PCM Piper a WAV 16k mono', () => {
  // 0.2s de seno 440Hz a 22050Hz, PCM16.
  const rate = 22050;
  const n = Math.floor(rate * 0.2);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20000), i * 2);
  }
  const b64 = pcmToWav16kBase64(pcm.toString('base64'), rate);
  assert.ok(b64);
  const buf = Buffer.from(b64, 'base64');
  const h = parseWavHeader(buf);
  assert.equal(h.rate, 16000);
  assert.equal(h.channels, 1);
  assert.equal(h.bits, 16);
  assert.ok(Math.abs(h.samples - 3200) < 5, `muestras ${h.samples} ≈ 3200`);
});

test('pcmToWav16kBase64 con entrada rota devuelve null', () => {
  assert.equal(pcmToWav16kBase64(null, 22050), null);
  assert.equal(pcmToWav16kBase64('eA==', 0), null);
  assert.equal(pcmToWav16kBase64('eA==', 'lala'), null);
  assert.equal(pcmToWav16kBase64('eA==', 22050), null); // 1 byte: PCM impar
});

test('withTimeoutMs: rápido vale, lento/rechazo cae a fallback', async () => {
  assert.equal(await withTimeoutMs(Promise.resolve('ok'), 500, 'fb'), 'ok');
  assert.equal(await withTimeoutMs(Promise.reject(new Error('x')), 500, 'fb'), 'fb');
  const t0 = Date.now();
  const v = await withTimeoutMs(new Promise(() => {}), 50, 'fb');
  assert.equal(v, 'fb');
  assert.ok(Date.now() - t0 < 2000, 'el timeout no bloquea');
});

test('nextKeepaliveAt/shouldKeepalive: agenda pura cada 75s', () => {
  assert.equal(KEEPALIVE_INTERVAL_MS, 75000);
  assert.equal(nextKeepaliveAt(1000, 5000), 76000);
  // Sin último disparo, toca enseguida.
  assert.equal(shouldKeepalive(5000, 0), true);
  assert.equal(shouldKeepalive(5000, null), true);
  assert.equal(shouldKeepalive(1000 + 74999, 1000), false);
  assert.equal(shouldKeepalive(1000 + 75000, 1000), true);
  assert.equal(shouldKeepalive(1000 + 20000, 1000), false, 'el tick de 20s no dispara');
});

test('postKeepalive POSTea el fixture y nunca lanza', async () => {
  const calls = [];
  const r = await postKeepalive('http://x/v1/transcribe', 'RkFLRQ==', {
    fetchFn: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; }
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://x/v1/transcribe');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.audio_base64, 'RkFLRQ==');
  // fetch roto → {ok:false}, sin throw.
  const r2 = await postKeepalive('http://x/v1/transcribe', 'RkFLRQ==', {
    fetchFn: async () => { throw new Error('down'); }
  });
  assert.equal(r2.ok, false);
  const r3 = await postKeepalive('http://x/v1/transcribe', null, { fetchFn: async () => ({ ok: true }) });
  assert.equal(r3.ok, false);
});

test('watchdog: keepalive SOLO a parakeet cada 75s (no cada tick)', async () => {
  const calls = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [
      PARAKEET,
      { name: 'piper', health: 'http://127.0.0.1:7791/health', spawn: { cmd: 'python3', args: ['p.py'] } }
    ],
    check: async () => true,
    spawnFn: async () => ({ pid: 1 }),
    onTelemetry: () => {},
    keepalive: { fetchFn: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; }, audioBase64: 'RkFLRQ==' },
    swapWarn: false
  });
  try {
    const t0 = Date.now();
    await wd.tick(t0);
    await flush();
    assert.equal(calls.length, 1, 'primer tick dispara (nunca se hizo)');
    assert.match(calls[0].url, /7790\/v1\/transcribe/, 'va a parakeet, no a piper');
    await wd.tick(t0 + 20000);
    await flush();
    assert.equal(calls.length, 1, 'a los 20s no re-dispara');
    await wd.tick(t0 + 74000);
    await flush();
    assert.equal(calls.length, 1, 'a los 74s todavía no');
    await wd.tick(t0 + 75000);
    await flush();
    assert.equal(calls.length, 2, 'a los 75s re-dispara');
  } finally {
    wd.stop();
  }
});

test('watchdog: sin parakeet en specs no hay keepalive', async () => {
  let n = 0;
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [{ name: 'piper', health: 'http://x/health', spawn: { cmd: 'a', args: [] } }],
    check: async () => true,
    spawnFn: async () => ({ pid: 1 }),
    onTelemetry: () => {},
    keepalive: { fetchFn: async () => { n++; return { ok: true }; }, audioBase64: 'RkFLRQ==' },
    swapWarn: false
  });
  try {
    await wd.tick(Date.now());
    await flush();
    assert.equal(n, 0);
  } finally {
    wd.stop();
  }
});

test('watchdog: keepalive silencioso salvo 3 fallos seguidos', async () => {
  const events = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [PARAKEET],
    check: async () => true,
    spawnFn: async () => ({ pid: 1 }),
    onTelemetry: (type, payload) => events.push({ type, payload }),
    keepalive: { fetchFn: async () => { throw new Error('down'); }, audioBase64: 'RkFLRQ==' },
    swapWarn: false
  });
  try {
    const t0 = Date.now();
    await wd.tick(t0);
    await flush();
    await wd.tick(t0 + 75000);
    await flush();
    assert.ok(!events.some((e) => e.type === 'parakeet_keepalive_failing'), 'con 2 fallos sigue silencioso');
    await wd.tick(t0 + 150000);
    await flush();
    assert.ok(events.some((e) => e.type === 'parakeet_keepalive_failing'), 'al 3er fallo avisa');
    assert.equal(wd.getKeepalive().failures, 3);
  } finally {
    wd.stop();
  }
});

test('watchdog: keepalive OK resetea racha de fallos', async () => {
  let fail = true;
  const events = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [PARAKEET],
    check: async () => true,
    spawnFn: async () => ({ pid: 1 }),
    onTelemetry: (type, payload) => events.push({ type, payload }),
    keepalive: {
      fetchFn: async () => {
        if (fail) throw new Error('down');
        return { ok: true };
      },
      audioBase64: 'RkFLRQ=='
    },
    swapWarn: false
  });
  try {
    const t0 = Date.now();
    await wd.tick(t0);
    await flush();
    await wd.tick(t0 + 75000);
    await flush();
    fail = false;
    await wd.tick(t0 + 150000);
    await flush();
    assert.equal(wd.getKeepalive().failures, 0);
    assert.ok(!events.some((e) => e.type === 'parakeet_keepalive_failing'));
  } finally {
    wd.stop();
  }
});

test('parseSwapPressure/shouldWarnSwap: puras con umbral 80% y cooldown 1h', () => {
  const mem = 'MemTotal:        7720956 kB\nSwapTotal:      16088308 kB\nSwapFree:        1608830 kB\n';
  const p = parseSwapPressure(mem);
  assert.equal(p.totalKb, 16088308);
  assert.ok(Math.abs(p.usedPct - 90) < 0.01);
  assert.equal(parseSwapPressure('sin swap'), null);
  assert.equal(parseSwapPressure('SwapTotal:       0 kB\nSwapFree:       0 kB\n'), null);
  const now = 10000000;
  assert.equal(shouldWarnSwap(90, now, 0), true);
  assert.equal(shouldWarnSwap(79, now, 0), false);
  assert.equal(shouldWarnSwap(90, now, now - 3599999), false, 'cooldown 1h');
  assert.equal(shouldWarnSwap(90, now, now - 3600000), true);
});

test('maybeWarnSwap avisa 1 vez/hora con lector inyectado', () => {
  const high = () => 'SwapTotal:      1000 kB\nSwapFree:        100 kB\n';
  const r1 = maybeWarnSwap({ now: 1000000, lastWarnedAt: 0, readMeminfo: high });
  assert.equal(r1.warned, true);
  assert.equal(r1.warnedAt, 1000000);
  const r2 = maybeWarnSwap({ now: 1000000 + 60000, lastWarnedAt: r1.warnedAt, readMeminfo: high });
  assert.equal(r2.warned, false, 'dentro de la hora no repite');
  const r3 = maybeWarnSwap({ now: 1000000 + 3600000, lastWarnedAt: r1.warnedAt, readMeminfo: high });
  assert.equal(r3.warned, true);
  const low = () => 'SwapTotal:      1000 kB\nSwapFree:        900 kB\n';
  assert.equal(maybeWarnSwap({ now: 1, readMeminfo: low }).warned, false);
});

test('watchdog: emite host_swap_pressure 1 vez/hora si swap >80%', async () => {
  const events = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [PARAKEET],
    check: async () => true,
    spawnFn: async () => ({ pid: 1 }),
    onTelemetry: (type, payload) => events.push({ type, payload }),
    keepalive: false,
    swapWarn: { readMeminfo: () => 'SwapTotal:      1000 kB\nSwapFree:        100 kB\n' }
  });
  try {
    const t0 = Date.now();
    await wd.tick(t0);
    await wd.tick(t0 + 20000);
    const warns = events.filter((e) => e.type === 'host_swap_pressure');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].payload.usedPct, 90);
    await wd.tick(t0 + 3600000 + 1);
    assert.equal(events.filter((e) => e.type === 'host_swap_pressure').length, 2);
  } finally {
    wd.stop();
  }
});

test('prewarm no bloquea: Piper colgado cae al fixture con techo', async () => {
  // Replica la selección de audio de prewarmLocalModels con mocks: Piper
  // que nunca resuelve + techo 50ms → fixture, rápido.
  const fixture = loadWarmupWavBase64();
  assert.ok(fixture);
  const hanging = new Promise(() => {});
  const t0 = Date.now();
  const piperWav = await withTimeoutMs(hanging.then(() => 'piper-wav'), 50, null);
  const chosen = firstNonEmpty(piperWav, fixture);
  assert.equal(chosen, fixture, 'Piper DOWN → fixture local');
  assert.ok(Date.now() - t0 < 2000, 'el prewarm no espera al Piper colgado');
  // Piper sano gana.
  assert.equal(firstNonEmpty('piper-wav', fixture), 'piper-wav');
});
