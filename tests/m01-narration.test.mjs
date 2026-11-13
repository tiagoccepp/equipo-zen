// M-01: doble canal update+filler — timing explícito con reloj falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNarrationGate, UPDATE_MIN_INTERVAL_MS, FILLER_MIN_INTERVAL_MS } from '../server/lib/narration.js';

function gate() {
  let nowMs = 100000;
  const g = createNarrationGate({ now: () => nowMs });
  return { g, advance: (ms) => { nowMs += ms; } };
}

test('m01: update pasa primero, throttlea 4s, dedupea', () => {
  assert.equal(UPDATE_MIN_INTERVAL_MS, 4000);
  const { g, advance } = gate();
  assert.equal(g.update('  Trabajando en X  '), 'Trabajando en X', 'trim');
  assert.equal(g.update('Trabajando en X'), null, 'dedupe exacto');
  assert.equal(g.update('Otro texto'), null, 'throttle 4s');
  advance(3999);
  assert.equal(g.update('Otro texto'), null);
  advance(1);
  assert.equal(g.update('Otro texto'), 'Otro texto');
  assert.equal(g.update(''), null, 'vacío no sale');
  assert.equal(g.update('   '), null);
});

test('m01: update recorta a 200ch', () => {
  const { g } = gate();
  const out = g.update('z'.repeat(500));
  assert.equal(out.length, 200);
});

test('m01: filler throttlea 8s y respeta habla reciente', () => {
  assert.equal(FILLER_MIN_INTERVAL_MS, 8000);
  const { g, advance } = gate();
  assert.equal(g.filler(), true, 'primero sale');
  assert.equal(g.filler(), false, 'throttle');
  advance(8000);
  g.markSpeech();
  assert.equal(g.filler(), false, 'no pisa voz reciente');
  advance(3000);
  assert.equal(g.filler(), true, 'tras silencio sí');
});

test('m01: instancias independientes por turno', () => {
  const a = gate();
  const b = gate();
  a.g.update('X');
  assert.equal(b.g.update('X'), 'X', 'otro turno, otro gate');
});
