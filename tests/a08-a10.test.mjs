// A-08 + A-10: budgets (semáforo loops, spawn depth) + tiers complejidad.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetBudgets,
  acquireLoopSlot,
  enterSpawn,
  exitSpawn,
  MAX_PARALLEL_LOOPS,
  MAX_SPAWN_DEPTH,
  parallelLoops
} from '../server/lib/budgets.js';
import { scoreComplexity } from '../server/lib/complexity.js';
import { getFastModel, getStrongModel, initSettings, modelsForTier } from '../server/lib/settings.js';
import { runToolLoop } from '../server/lib/manos.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
afterEach(() => { db.clear(); __resetBudgets(); });

test('a08: semáforo paralelo (3) + abort + release', async () => {
  assert.equal(MAX_PARALLEL_LOOPS, 3);
  const r1 = await acquireLoopSlot({});
  const r2 = await acquireLoopSlot({});
  const r3 = await acquireLoopSlot({});
  assert.equal(parallelLoops(), 3);
  let fourth = false;
  const p4 = acquireLoopSlot({}).then((rel) => { fourth = true; return rel; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fourth, false, 'cuarto espera');
  r1();
  const r4 = await p4;
  assert.equal(fourth, true, 'slot liberado avanza');
  assert.equal(parallelLoops(), 3);
  r2(); r3(); r4();
  assert.equal(parallelLoops(), 0);
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => acquireLoopSlot({ signal: c.signal }), /abortado/);
});

test('a08: runToolLoop concurrentes se turnan (no más de 3 dentro)', async () => {
  let inside = 0;
  let peak = 0;
  const scripts = ['fin sin llamadas'];
  const one = () => runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside -= 1;
      return { text: scripts[0] };
    },
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 2
  });
  await Promise.all([one(), one(), one(), one(), one()]);
  assert.ok(peak <= 3, `pico ${peak} ≤ 3`);
  assert.equal(parallelLoops(), 0, 'slots liberados');
});

test('a08: spawn depth corta recursión', () => {
  assert.equal(MAX_SPAWN_DEPTH, 2);
  assert.equal(enterSpawn(), true);
  assert.equal(enterSpawn(), true);
  assert.equal(enterSpawn(), false, 'tercer nivel bloqueado');
  exitSpawn();
  assert.equal(enterSpawn(), true, 'al salir libera');
  exitSpawn(); exitSpawn();
});

test('a10: complejidad simple/medium/complex', () => {
  assert.equal(scoreComplexity('hola'), 'simple');
  assert.equal(scoreComplexity('gracias!'), 'simple');
  assert.equal(scoreComplexity(''), 'simple');
  assert.equal(scoreComplexity('qué hora es?'), 'simple', 'pregunta corta → fast');
  assert.equal(scoreComplexity('qué hora es y además contame cómo viene la semana?'), 'medium', 'pregunta doble');
  assert.equal(scoreComplexity('Por qué falla el build cuando agrego dependencias nuevas? Analizá el log y compará con ayer.'), 'complex');
  assert.equal(scoreComplexity('```tool:run_cmd\n{"cmd":"x"}\n``` no anda, traceback largo...'), 'medium', 'código+error (strong igual)');
  assert.equal(scoreComplexity('hacé la home y luego revisá los links y después avisame'), 'medium');
});

test('a10: tiers strong/fast + customs', () => {
  db.set('llm.provider', 'opencode');
  const all = modelsForTier('strong');
  assert.ok(all.length > 0);
  assert.equal(getStrongModel(), all[0], 'strong primero');
  const fast = modelsForTier('fast');
  assert.equal(getFastModel(), fast[0], 'fast primero');
  db.set('llm.fast', 'mi-chico');
  assert.equal(getFastModel(), 'mi-chico', 'custom fast');
  assert.equal(modelsForTier('fast')[0], 'mi-chico');
  db.set('llm.strong', 'mi-fuerte');
  assert.equal(modelsForTier('strong')[0], 'mi-fuerte');
});
