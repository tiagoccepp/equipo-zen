import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOWN_STRIKES,
  MAX_RESTARTS_PER_HOUR,
  SIDECARS,
  backoffFor,
  getSidecarStatus,
  parseHealth,
  shouldRestart,
  startSidecarWatchdog
} from '../server/lib/sidecars.js';

const SPAWNABLE = { name: 'x', health: 'http://x/health', spawn: { cmd: 'python3', args: ['s.py'] } };
const MONITOR = { name: 'w', health: 'http://w/health', spawn: null };

test('backoff: primero inmediato, después 20s/60s/300s con tope', () => {
  assert.equal(backoffFor(0), 0);
  assert.equal(backoffFor(1), 20000);
  assert.equal(backoffFor(2), 60000);
  assert.equal(backoffFor(3), 300000);
  assert.equal(backoffFor(10), 300000);
});

test('parseHealth acepta Response y JSON', () => {
  assert.equal(parseHealth({ ok: true }), true);
  assert.equal(parseHealth({ ok: false }), false);
  assert.equal(parseHealth({ status: 'ok' }), true);
  assert.equal(parseHealth({ status: 'OK' }), true);
  assert.equal(parseHealth({ status: 'degraded' }), false);
  assert.equal(parseHealth(null), false);
  assert.equal(parseHealth('ok'), false);
});

test('shouldRestart exige 2 strikes seguidos', () => {
  assert.equal(shouldRestart(SPAWNABLE, { downs: 0, restarts: [] }).restart, false);
  assert.equal(shouldRestart(SPAWNABLE, { downs: 1, restarts: [] }).restart, false);
  assert.equal(shouldRestart(SPAWNABLE, { downs: DOWN_STRIKES, restarts: [] }).restart, true);
});

test('shouldRestart respeta tope horario (5/hora)', () => {
  const now = Date.now();
  const five = [1, 2, 3, 4, 5].map((m) => now - m * 60 * 1000);
  const r = shouldRestart(SPAWNABLE, { downs: 2, restarts: five });
  assert.equal(r.restart, false);
  assert.equal(r.reason, 'hourly-cap');
  // Viejos (>1h) no cuentan.
  const old = [61, 62, 63, 64, 65].map((m) => now - m * 60 * 1000);
  assert.equal(shouldRestart(SPAWNABLE, { downs: 2, restarts: old }).restart, true);
});

test('shouldRestart respeta backoff entre restarts consecutivos', () => {
  const now = Date.now();
  // 1 restart hace 5s → hay que esperar 20s.
  const r = shouldRestart(SPAWNABLE, {
    downs: 3, restarts: [now - 5000], lastSpawnAt: now - 5000, consecutiveSpawns: 1
  }, now);
  assert.equal(r.restart, false);
  assert.equal(r.reason, 'backoff');
  // Pasado el backoff → sale.
  const r2 = shouldRestart(SPAWNABLE, {
    downs: 3, restarts: [now - 25000], lastSpawnAt: now - 25000, consecutiveSpawns: 1
  }, now);
  assert.equal(r2.restart, true);
});

test('shouldRestart: monitor-only y autostart off nunca spawnean', () => {
  assert.equal(shouldRestart(MONITOR, { downs: 9, restarts: [] }).reason, 'monitor-only');
  process.env.SIDECAR_AUTOSTART = '0';
  try {
    const r = shouldRestart(SPAWNABLE, { downs: 9, restarts: [] });
    assert.equal(r.restart, false);
    assert.equal(r.reason, 'autostart-off');
  } finally {
    delete process.env.SIDECAR_AUTOSTART;
  }
});

test('SIDECARS: los 4 spawneables (whisper+supertonic vía venvs, 09/11)', () => {
  const byName = Object.fromEntries(SIDECARS.map((s) => [s.name, s]));
  assert.ok(byName.parakeet.spawn);
  assert.ok(byName.piper.spawn);
  assert.ok(byName.whisper.spawn);
  assert.ok(byName.supertonic.spawn);
  assert.match(byName.parakeet.health, /7790/);
  assert.match(byName.piper.health, /7791/);
  assert.match(byName.whisper.health, /7789/);
  // Supertonic expone /v1/health (no /health).
  assert.match(byName.supertonic.health, /7788\/v1\/health/);
  // Venvs dedicados, nunca el python3 del sistema.
  assert.match(byName.whisper.spawn.cmd, /whisper-venv/);
  assert.match(byName.supertonic.spawn.cmd, /supertonic-venv/);
  // Whisper: tiny + lazy + offline (ver plan 09/11).
  assert.equal(byName.whisper.spawn.env.WHISPER_MODEL, 'tiny');
  assert.equal(byName.whisper.spawn.env.WHISPER_PRELOAD, '0');
  assert.equal(byName.whisper.spawn.env.HF_HUB_OFFLINE, '1');
  assert.equal(byName.supertonic.spawn.env.HF_HUB_OFFLINE, '1');
});

test('watchdog: 2 downs seguidos disparan 1 spawn (fakes, sin procesos reales)', async () => {
  const events = [];
  const spawns = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [SPAWNABLE],
    check: async () => false,
    spawnFn: async (spec) => { spawns.push(spec.name); return { pid: 4242 }; },
    onTelemetry: (type, payload) => events.push({ type, payload })
  });
  try {
    await wd.tick(Date.now());
    assert.equal(spawns.length, 0, 'con 1 strike no spawnea');
    await wd.tick(Date.now());
    assert.equal(spawns.length, 1, 'con 2 strikes spawnea');
    assert.ok(events.some((e) => e.type === 'sidecar_down'), 'emite sidecar_down');
    assert.ok(events.some((e) => e.type === 'sidecar_restart'), 'emite sidecar_restart');
    // Backoff frena el 3er tick.
    await wd.tick(Date.now());
    assert.equal(spawns.length, 1, 'backoff frena respawn inmediato');
  } finally {
    wd.stop();
  }
});

test('watchdog: recuperación resetea strikes y backoff', async () => {
  let up = false;
  const spawns = [];
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [SPAWNABLE],
    check: async () => up,
    spawnFn: async () => { spawns.push(1); return { pid: 1 }; },
    onTelemetry: () => {}
  });
  try {
    await wd.tick(Date.now());
    up = true;
    await wd.tick(Date.now());
    up = false;
    await wd.tick(Date.now());
    assert.equal(spawns.length, 0, 'tras recuperarse, 1 strike solo no spawnea');
    const status = wd.getStatus();
    assert.equal(status[0].status, 'down');
    assert.equal(status[0].downs, 1);
  } finally {
    wd.stop();
  }
});

test('watchdog: tope horario frena crash-loop', async () => {
  const spawns = [];
  let now = Date.now();
  const wd = startSidecarWatchdog({
    intervalMs: 60000,
    specs: [SPAWNABLE],
    check: async () => false,
    spawnFn: async () => { spawns.push(1); return { pid: 1 }; },
    onTelemetry: () => {}
  });
  try {
    // Avanzar el reloj más allá del backoff en cada tick.
    for (let i = 0; i < 10; i++) {
      now += 400000;
      await wd.tick(now);
    }
    assert.equal(spawns.length, MAX_RESTARTS_PER_HOUR, `tope ${MAX_RESTARTS_PER_HOUR}/hora`);
  } finally {
    wd.stop();
  }
});

test('getSidecarStatus sin watchdog devuelve unknown', () => {
  const status = getSidecarStatus();
  assert.equal(status.length, SIDECARS.length);
  assert.ok(status.every((s) => s.status === 'unknown'));
});
