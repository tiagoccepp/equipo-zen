// Team v1 tests: gate shouldConsult + consult + maybeConsultSala.
// 100% fake model: no test touches network or real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEAM_NOTE_PREFIX, consult, shouldConsult } from '../server/lib/sala.js';
import { maybeConsultSala } from '../server/lib/turn-pipeline.js';
import { getSalaTimeoutMs, getSalaV1 } from '../server/lib/settings.js';

// ── Gate: 8 cases ─────────────────────────────────────────────────────

test('gate: short simple request → false (normal flow)', () => {
  assert.equal(shouldConsult('abrí el archivo readme'), false);
});

test('gate: long request >200 chars → true', () => {
  const largo = 'necesito que revises el proyecto entero y me digas qué anda mal, '.repeat(5);
  assert.ok(largo.length > 200);
  assert.equal(shouldConsult(largo), true);
});

test('gate: trade-off keyword → true', () => {
  assert.equal(shouldConsult('rápido vs bien, ¿qué trade-off hacemos?'), true);
});

test('gate: compará/conviene/analizá/pros-contras keyword → true', () => {
  assert.equal(shouldConsult('compará estas dos opciones'), true);
  assert.equal(shouldConsult('¿qué conviene usar acá?'), true);
  assert.equal(shouldConsult('analizá este error'), true);
  assert.equal(shouldConsult('dame pros y contras'), true);
});

test('gate: second-opinion keyword → true', () => {
  assert.equal(shouldConsult('quiero una segunda opinión del equipo'), true);
});

test('gate: multi-domain route (≥2 targets, ≥2 domains) → true', () => {
  const route = {
    targets: [
      { agentId: 'a1', matchedDomains: ['codigo'] },
      { agentId: 'a2', matchedDomains: ['stock'] }
    ]
  };
  assert.equal(shouldConsult('ok', route), true);
});

test('gate: greeting or close never open a room even with a keyword', () => {
  assert.equal(shouldConsult('compará esto', { greeting: true, targets: [] }), false);
  assert.equal(shouldConsult('conviene cerrar', { closing: true, targets: [] }), false);
});

test('gate: empty text → false', () => {
  assert.equal(shouldConsult(''), false);
  assert.equal(shouldConsult(null), false);
});

// ── consult ───────────────────────────────────────────────────────────

function fakeModel(texto) {
  return async () => ({ text: texto, model: 'fake' });
}

test('consult: flag off → null + sala_skip without calling the model', async () => {
  let llamadas = 0;
  const telemetria = [];
  const out = await consult({
    text: 'compará A vs B, ¿qué conviene?',
    deps: {
      flagOn: false,
      completeChat: async () => { llamadas += 1; return { text: 'x' }; },
      onTelemetry: (ev, data) => telemetria.push([ev, data])
    }
  });
  assert.equal(out, null);
  assert.equal(llamadas, 0);
  assert.equal(telemetria[0][0], 'sala_skip');
  assert.equal(telemetria[0][1].reason, 'flag_off');
});

test('consult: ok → NOTE with prefix + sala_note', async () => {
  const telemetria = [];
  const out = await consult({
    text: 'compará hosting A vs B',
    deps: {
      flagOn: true,
      timeoutMs: 5000,
      completeChat: fakeModel('A es más barato; B tiene mejor uptime.'),
      onTelemetry: (ev, data) => telemetria.push([ev, data])
    }
  });
  assert.ok(out.startsWith(TEAM_NOTE_PREFIX));
  assert.ok(out.includes('uptime'));
  assert.equal(telemetria[0][0], 'sala_note');
});

test('consult: timeout → null + sala_skip (normal flow)', async () => {
  const telemetria = [];
  const out = await consult({
    text: 'analizá pros y contras de migrar todo ya mismo por favor',
    deps: {
      flagOn: true,
      timeoutMs: 30,
      completeChat: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { text: 'tarde' };
      },
      onTelemetry: (ev) => telemetria.push(ev)
    }
  });
  assert.equal(out, null);
  assert.equal(telemetria[0], 'sala_skip');
});

test('consult: model failure → null + sala_skip (never throws)', async () => {
  const telemetria = [];
  const out = await consult({
    text: '¿qué conviene: A o B?',
    deps: {
      flagOn: true,
      timeoutMs: 2000,
      completeChat: async () => { throw new Error('401 boom'); },
      onTelemetry: (ev) => telemetria.push(ev)
    }
  });
  assert.equal(out, null);
  assert.equal(telemetria[0], 'sala_skip');
});

test('consult: negative gate with flag on → null without calling the model', async () => {
  let llamadas = 0;
  const out = await consult({
    text: 'abrí readme',
    deps: {
      flagOn: true,
      completeChat: async () => { llamadas += 1; return { text: 'x' }; }
    }
  });
  assert.equal(out, null);
  assert.equal(llamadas, 0);
});

// ── maybeConsultSala (gate point in turn-pipeline) ───────────────────

test('maybeConsultSala: flag off → null (zero changes)', async () => {
  const out = await maybeConsultSala({
    text: 'compará A vs B en detalle',
    deps: { flagOn: false, completeChat: fakeModel('nunca') }
  });
  assert.equal(out, null);
});

test('maybeConsultSala: flag on + positive gate → injects NOTE', async () => {
  const out = await maybeConsultSala({
    text: '¿qué conviene: deploy hoy o esperar al lunes?',
    deps: { flagOn: true, timeoutMs: 2000, completeChat: fakeModel('Esperar: el deploy del viernes falló 2 veces.') }
  });
  assert.ok(out.startsWith(TEAM_NOTE_PREFIX));
});

test('maybeConsultSala: never throws even if deps explodes', async () => {
  const out = await maybeConsultSala({
    text: 'compará todo',
    deps: { flagOn: true, completeChat: null }
  });
  assert.equal(out, null);
});

// ── settings sala.* ───────────────────────────────────────────────────
// NOTE: settings without init (null store) → defaults. These asserts cover
// the default; with a real store the getters read sala.v1 / sala.timeoutMs.

test('settings: defaults sala.v1=false, sala.timeoutMs=15000', () => {
  assert.equal(getSalaV1(), false);
  assert.equal(getSalaTimeoutMs(), 15000);
});

// PIPELINE_MANUAL (for ship): the live pipeline (meeting-session /
// agent-runtime) does NOT call maybeConsultSala yet — wiring it is a
// later integration (agent-runtime belongs to another track). Manual check
// when integrating: 1) flag off → identical turn; 2) flag on + simple
// request → no NOTE; 3) flag on + "compará/conviene" → NOTE in context
// and Pablo answers without mentioning the team; 4) timeout → normal turn.
