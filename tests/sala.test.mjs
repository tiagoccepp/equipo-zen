// Tests Team v1: gate shouldConsult + consult + maybeConsultSala.
// Modelo 100% fake: ningún test toca red ni keys reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TEAM_NOTE_PREFIX, consult, shouldConsult } from '../server/lib/sala.js';
import { maybeConsultSala } from '../server/lib/turn-pipeline.js';
import { getSalaTimeoutMs, getSalaV1 } from '../server/lib/settings.js';

// ── Gate: 8 casos ─────────────────────────────────────────────────────

test('gate: pedido corto simple → false (flujo normal)', () => {
  assert.equal(shouldConsult('abrí el archivo readme'), false);
});

test('gate: pedido largo >200 chars → true', () => {
  const largo = 'necesito que revises el proyecto entero y me digas qué anda mal, '.repeat(5);
  assert.ok(largo.length > 200);
  assert.equal(shouldConsult(largo), true);
});

test('gate: keyword trade-off → true', () => {
  assert.equal(shouldConsult('rápido vs bien, ¿qué trade-off hacemos?'), true);
});

test('gate: keyword compará/conviene/analizá/pros-contras → true', () => {
  assert.equal(shouldConsult('compará estas dos opciones'), true);
  assert.equal(shouldConsult('¿qué conviene usar acá?'), true);
  assert.equal(shouldConsult('analizá este error'), true);
  assert.equal(shouldConsult('dame pros y contras'), true);
});

test('gate: segunda opinión → true', () => {
  assert.equal(shouldConsult('quiero una segunda opinión del equipo'), true);
});

test('gate: route multi-dominio (≥2 targets, ≥2 dominios) → true', () => {
  const route = {
    targets: [
      { agentId: 'a1', matchedDomains: ['codigo'] },
      { agentId: 'a2', matchedDomains: ['stock'] }
    ]
  };
  assert.equal(shouldConsult('ok', route), true);
});

test('gate: saludo o cierre nunca abren sala aunque haya keyword', () => {
  assert.equal(shouldConsult('compará esto', { greeting: true, targets: [] }), false);
  assert.equal(shouldConsult('conviene cerrar', { closing: true, targets: [] }), false);
});

test('gate: texto vacío → false', () => {
  assert.equal(shouldConsult(''), false);
  assert.equal(shouldConsult(null), false);
});

// ── consult ───────────────────────────────────────────────────────────

function fakeModel(texto) {
  return async () => ({ text: texto, model: 'fake' });
}

test('consult: flag off → null + sala_skip sin llamar al modelo', async () => {
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

test('consult: ok → NOTE con prefijo + sala_note', async () => {
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

test('consult: timeout → null + sala_skip (flujo normal)', async () => {
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

test('consult: fallo de modelo → null + sala_skip (nunca lanza)', async () => {
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

test('consult: gate negativo con flag on → null sin llamar al modelo', async () => {
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

// ── maybeConsultSala (punto de gate en turn-pipeline) ───────────────────

test('maybeConsultSala: flag off → null (cero cambios)', async () => {
  const out = await maybeConsultSala({
    text: 'compará A vs B en detalle',
    deps: { flagOn: false, completeChat: fakeModel('nunca') }
  });
  assert.equal(out, null);
});

test('maybeConsultSala: flag on + gate positivo → inyecta NOTE', async () => {
  const out = await maybeConsultSala({
    text: '¿qué conviene: deploy hoy o esperar al lunes?',
    deps: { flagOn: true, timeoutMs: 2000, completeChat: fakeModel('Esperar: el deploy del viernes falló 2 veces.') }
  });
  assert.ok(out.startsWith(TEAM_NOTE_PREFIX));
});

test('maybeConsultSala: nunca lanza aunque deps explote', async () => {
  const out = await maybeConsultSala({
    text: 'compará todo',
    deps: { flagOn: true, completeChat: null }
  });
  assert.equal(out, null);
});

// ── settings sala.* ───────────────────────────────────────────────────
// NOTA: settings sin init (store null) → defaults. Estos asserts cubren
// el default; con store real los getters leen sala.v1 / sala.timeoutMs.

test('settings: defaults sala.v1=false, sala.timeoutMs=15000', () => {
  assert.equal(getSalaV1(), false);
  assert.equal(getSalaTimeoutMs(), 15000);
});

// PIPELINE_MANUAL (para ship): el pipeline vivo (meeting-session /
// agent-runtime) todavía NO llama a maybeConsultSala — el cableado es
// integración posterior (agent-runtime es de otro track). Verificación
// manual al integrar: 1) flag off → turno idéntico; 2) flag on + pedido
// simple → sin NOTE; 3) flag on + "compará/conviene" → NOTE en contexto
// y Pablo responde sin mencionar al equipo; 4) timeout → turno normal.
