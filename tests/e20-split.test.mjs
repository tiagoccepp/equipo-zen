// E-20: split local+VPS — resolución de URLs + watchdog remoto.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sidecarUrl, effectiveSpecs, isLocalhost, SPLIT_PORTS } from '../server/lib/split.js';
import {
  getParakeetUrl,
  getPiperUrl,
  getSplitMode,
  getSplitVps,
  getTtsUrl,
  getWhisperUrl,
  initSettings
} from '../server/lib/settings.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
afterEach(() => {
  db.clear();
  delete process.env.SPLIT_VPS;
  delete process.env.PARAKEET_URL;
  delete process.env.WHISPER_URL;
  delete process.env.PIPER_URL;
});

const dbFn = (k) => (db.has(k) ? db.get(k) : null);

test('e20: split.js puro — puertos, localhost, specs sin spawn', () => {
  assert.deepEqual(SPLIT_PORTS, { parakeet: 7790, piper: 7791, whisper: 7789, supertonic: 7788 });
  assert.equal(isLocalhost('http://127.0.0.1:7790/x'), true);
  assert.equal(isLocalhost('http://localhost:1'), true);
  assert.equal(isLocalhost('https://vps:7790'), false);
  const specs = [{ name: 'piper', spawn: { cmd: 'x' } }];
  assert.equal(effectiveSpecs(specs, () => null)[0].spawn.cmd, 'x', 'local: spawn intacto');
});

test('e20: URLs default localhost; split reescribe; explícito gana', () => {
  assert.equal(getSplitMode(), 'local');
  assert.equal(getParakeetUrl(), 'http://127.0.0.1:7790');
  assert.equal(getWhisperUrl(), 'http://127.0.0.1:7789');
  assert.equal(getPiperUrl(), 'http://127.0.0.1:7791');
  db.set('split.mode', 'split');
  db.set('split.vps', 'https://vps.example.com');
  assert.equal(getSplitMode(), 'split');
  assert.equal(getSplitVps(), 'https://vps.example.com');
  assert.equal(getParakeetUrl(), 'https://vps.example.com:7790');
  assert.equal(getWhisperUrl(), 'https://vps.example.com:7789');
  assert.equal(getPiperUrl(), 'https://vps.example.com:7791');
  assert.equal(getTtsUrl(), 'https://vps.example.com:7788');
  process.env.PIPER_URL = 'http://otro:9999';
  assert.equal(getPiperUrl(), 'http://otro:9999', 'explícito gana al split');
  db.set('tts.url', 'http://otro:7777');
  assert.equal(getTtsUrl(), 'http://otro:7777', 'explícito gana al split');
});

test('e20: sidecarSpecs en split = remoto sin spawn', async () => {
  const { sidecarSpecs } = await import('../server/lib/sidecars.js');
  db.set('split.mode', 'split');
  db.set('split.vps', 'https://vps.example.com');
  const specs = sidecarSpecs();
  assert.equal(specs.length, 4);
  assert.ok(specs.every((s) => s.spawn === null), 'sin spawn en split');
  assert.ok(specs.find((s) => s.name === 'piper').health.includes('vps.example.com:7791'));
  db.clear();
  const local = sidecarSpecs();
  assert.ok(local.every((s) => s.spawn !== null), 'local spawnea');
});

test('e20: sidecarUrl() helper', () => {
  assert.equal(sidecarUrl('piper', 'http://127.0.0.1:7791', dbFn), 'http://127.0.0.1:7791');
  db.set('split.mode', 'split');
  db.set('split.vps', 'https://v.com');
  assert.equal(sidecarUrl('piper', 'http://127.0.0.1:7791', dbFn), 'https://v.com:7791');
  assert.equal(sidecarUrl('piper', 'http://otro:1', dbFn), 'http://otro:1', 'explícito no-local gana');
});
