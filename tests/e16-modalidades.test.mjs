// E-16: secciones TTS/STT — speed, piperUrl, validación, paridad.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getPiperUrl, getTtsSpeed, initSettings, publicSettings } from '../server/lib/settings.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
afterEach(() => { db.clear(); });

test('e16: speed default/clamp/inválido + piperUrl', () => {
  assert.equal(getTtsSpeed(), 1.0, 'default');
  db.set('tts.speed', '1.5');
  assert.equal(getTtsSpeed(), 1.5);
  db.set('tts.speed', '9');
  assert.equal(getTtsSpeed(), 2.0, 'tope');
  db.set('tts.speed', '0.1');
  assert.equal(getTtsSpeed(), 0.5, 'piso');
  db.set('tts.speed', 'basura');
  assert.equal(getTtsSpeed(), 1.0, 'inválido → default');
  assert.ok(getPiperUrl().includes('7791'), 'default sidecar');
  db.set('tts.piperUrl', 'http://vps:7791');
  assert.equal(getPiperUrl(), 'http://vps:7791', 'seteable (VPS-ready)');
});

test('e16: publicSettings expone secciones separadas completas', () => {
  db.set('tts.speed', '1.2');
  const s = publicSettings();
  assert.ok(s.llm && s.stt && s.tts && s.channels, 'secciones separadas');
  assert.equal(s.tts.speed, 1.2);
  assert.ok('piperUrl' in s.tts);
  assert.ok('order' in s.stt && 'minConfidence' in s.stt, 'STT rico (paridad)');
  assert.ok('failover' in s.llm && 'customModels' in s.llm, 'LLM E-14 presente');
});

test('e16: supertonic manda speed cuando != default', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => {
      // WAV mínimo: RIFF....WAVEfmt ....data + 2 bytes.
      const b = Buffer.alloc(48, 0);
      b.write('RIFF', 0); b.writeUInt32LE(40, 4); b.write('WAVE', 8);
      b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt32LE(16000, 24);
      b.write('data', 36); b.writeUInt32LE(4, 40);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
  });
  try {
    const { synthesize } = await import('../server/lib/supertonic.js');
    // Interceptar body: re-mockear para capturar.
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(JSON.parse(init.body));
      const b = Buffer.alloc(48, 0);
      b.write('RIFF', 0); b.writeUInt32LE(40, 4); b.write('WAVE', 8);
      b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt32LE(16000, 24);
      b.write('data', 36); b.writeUInt32LE(4, 40);
      return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    };
    await synthesize('hola', 'M1', { speed: 1.5 });
    assert.equal(seen[0].speed, 1.5, 'speed viaja');
    await synthesize('hola', 'M1', {});
    assert.ok(!('speed' in seen[1]), 'sin speed no viaja');
  } finally {
    globalThis.fetch = realFetch;
  }
});
