// M-12: doble métrica de latencia — helper puro + cableado estático.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTurnLatency } from '../server/lib/agent-runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('m12: snapshot null sin marcas; primera marca gana', () => {
  let nowMs = 1000;
  const lat = createTurnLatency(1000, () => nowMs);
  assert.deepEqual(lat.snapshot(), { ttfsMs: null, ttfrMs: null });
  nowMs = 1300;
  lat.markSound();
  nowMs = 1500;
  lat.markSound();
  assert.equal(lat.snapshot().ttfsMs, 300, 'primera marca');
  nowMs = 2100;
  lat.markUseful();
  assert.deepEqual(lat.snapshot(), { ttfsMs: 300, ttfrMs: 1100 });
});

test('m12: sonido y útil independientes; útil puede ir primero', () => {
  let nowMs = 0;
  const lat = createTurnLatency(0, () => nowMs);
  nowMs = 500;
  lat.markUseful();
  assert.deepEqual(lat.snapshot(), { ttfsMs: null, ttfrMs: 500 });
});

test('m12: cableado — marcas en anuncio/audio/habla + evento', () => {
  const rt = readFileSync(join(ROOT, 'server/lib/agent-runtime.js'), 'utf8');
  assert.ok(rt.includes('createTurnLatency(turnT0)'), 'instancia por turno');
  assert.ok(rt.includes('turnLatency.markSound()'), 'marca sonido');
  assert.ok(rt.includes('turnLatency.markUseful()'), 'marca útil');
  assert.ok(rt.includes("type: 'agent_turn_latency'"), 'evento latencia');
  assert.ok(rt.includes('latency: turnLatency.snapshot()'), 'snapshot en returns');
  const ms = readFileSync(join(ROOT, 'server/lib/meeting-session.js'), 'utf8');
  assert.ok(ms.includes('response.latency'), 'turn_complete lleva latencia');
});
