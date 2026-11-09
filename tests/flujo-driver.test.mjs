// Tests track driver (flujo-driver): loop autónomo completo con FAKES siempre.
// Cero modelo, cero disco salvo tmp. Session fake { runAgentJobTurn
// programable, announceTeamEvent, roster }, fetchUrl fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __getEntry,
  __resetRegistry,
  enqueueJob,
  getJob,
  listJobs,
  runJob
} from '../server/lib/driver.js';
import { __resetSpawnLog, spawnLog } from '../server/lib/spawner.js';

const ROSTER = [
  { id: 'a-be', role: 'backend', name: 'Be' },
  { id: 'a-fe', role: 'frontend', name: 'Fe' },
  { id: 'a-te', role: 'tester', name: 'Te' }
];

function briefBase(extra = {}) {
  return {
    objetivo: 'Página de prueba del driver',
    contexto: 'Laboratorio: job chico para validar el loop',
    restricciones: ['sin deploy real'],
    criteriosExito: ['la página existe', 'el flujo principal anda'],
    formatoEntrega: 'documento de texto',
    producto: { tipo: 'generico', descripcion: 'entregable de prueba' },
    ...extra
  };
}

const FASES_1 = [
  { titulo: 'Construir entregable', dueño: 'backend', doneCriteria: 'entregable completo', dependeDe: [] }
];

function fakeStore() {
  const inserted = [];
  return {
    inserted,
    store: {
      activeLearnings: () => [],
      insertLearning: (l) => {
        inserted.push(l);
        return inserted.length;
      },
      reinforceLearning: () => {}
    }
  };
}

function fakeSession({ roster = ROSTER, onTurn, store = null } = {}) {
  const calls = { turns: [], events: [] };
  const session = {
    roster: roster.map((m) => ({ ...m })),
    store,
    meeting: { id: 'm-test' },
    async runAgentJobTurn(agentId, text, _opts) {
      calls.turns.push({ agentId, text: String(text) });
      return onTurn(agentId, String(text), calls.turns.length);
    },
    announceTeamEvent(evento) {
      calls.events.push(evento);
      return { speaker: 'x', texto: 'y' };
    }
  };
  return { session, calls };
}

const fetchUrlFake = async (q) => `hallazgo web para: ${String(q).slice(0, 60)}`;

// Router de turnos configurable: fallaTesterEn = nros de turno tester (1-based)
// que devuelven FAIL; el resto PASS. Entrega de dispatch con trigger opcional.
function routerLoop({ fallaTesterEn = new Set(), entregaDispatch = 'Entrega: módulo terminado y verificado.' } = {}) {
  let nTester = 0;
  return (agentId, text) => {
    if (text.includes('Sos el TESTER')) {
      nTester += 1;
      if (fallaTesterEn.has(nTester)) {
        return {
          text: 'Probé el flujo y encontré un problema.\nVEREDICTO: FAIL — el botón principal no responde | PASOS: abrir → click en comprar',
          toolCalls: [], ms: 1, turnId: `test-${nTester}`
        };
      }
      return {
        text: 'Verificado con herramientas.\nVEREDICTO: PASS — flujo verificado con evidencia',
        toolCalls: [], ms: 1, turnId: `test-${nTester}`
      };
    }
    if (text.includes('PEER REVIEW')) {
      return { text: 'Re-entrega post-review: tipado corregido, todo explícito.', toolCalls: [], ms: 1, turnId: 'rw-review' };
    }
    if (text.includes('REWORK')) {
      return { text: 'Re-entrega corregida completa: botón arreglado.', toolCalls: [], ms: 1, turnId: 'rw-test' };
    }
    if (text.includes('Sos el ORQUESTADOR')) {
      return {
        text: JSON.stringify([{ titulo: 'Construir', dueño: 'backend', doneCriteria: 'listo' }]),
        toolCalls: [], ms: 1, turnId: 'plan'
      };
    }
    return { text: entregaDispatch, toolCalls: [], ms: 1, turnId: 'd1' };
  };
}

function tiposEventos(calls) {
  return calls.events.map((e) => e.tipo);
}

// ── 1. Loop completo ───────────────────────────────────────────────────
test('loop completo: plan→dispatch→review(rework)→tester-falla→rework→aprueba', async () => {
  __resetRegistry();
  const { inserted, store } = fakeStore();
  // ': any' dispara el checklist frontend del revisor (1 rework de review).
  const { session, calls } = fakeSession({
    store,
    onTurn: routerLoop({
      fallaTesterEn: new Set([1]),
      entregaDispatch: 'Entrega: módulo listo (ver src/x.ts: any en helper temporal).'
    })
  });

  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  assert.equal(final.progreso.ronda, 2);
  assert.equal(final.progreso.fasesTotal, 1);
  assert.equal(final.resumen.tests.turnos, 12); // generico: 3 personas × 4 dims
  assert.equal(final.resumen.tests.mecanicas, 0);
  assert.equal(final.resumen.tests.fallidas, 0); // última ronda limpia

  const tipos = tiposEventos(calls);
  for (const t of ['plan_listo', 'dispatch', 'entrega', 'devolucion', 'aprobado']) {
    assert.ok(tipos.includes(t), `falta anuncio ${t}: ${tipos.join(',')}`);
  }
  assert.ok(tipos.indexOf('plan_listo') < tipos.indexOf('aprobado'));

  // Rework de review aplicado: la entrega quedó marcada y hubo turno PEER REVIEW.
  const entry = __getEntry(final.id);
  assert.equal(entry.entregas[0].rework, true);
  assert.ok(calls.turns.some((t) => t.text.includes('PEER REVIEW')));
  // Rework de tester: 1 redispatch (1 fail) + re-test completo.
  assert.ok(entry.entregas.some((e) => e.reworkTester));
  // Learnings registrados.
  assert.ok(inserted.length > 0, 'registrarLearningsDeLaburo debió insertar');
  // Vista pública: sin prompts internos, entregas truncadas.
  assert.ok(final.resumen.entregas[0].resumen.length <= 300);
  assert.ok(!JSON.stringify(final).includes('Sos el TESTER'));
});

// ── 2. Preguntas short-circuit ───────────────────────────────────────────
test('brief incompleto → preguntas, cero turnos', async () => {
  __resetRegistry();
  let turnos = 0;
  const { session, calls } = fakeSession({ onTurn: () => { turnos += 1; return { text: 'x' }; } });
  const final = await runJob(session, { objetivo: 'algo' }, { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'preguntas');
  assert.ok(final.resumen.preguntas.length >= 4);
  assert.equal(turnos, 0);
  assert.ok(tiposEventos(calls).includes('preguntas'));
  assert.equal(getJob(final.id).estado, 'preguntas');
});

// ── 3. FALTA resuelto + existente no-duplicado (spawner REAL) ─────────────
// Nota: pedirRol pide caps base y TODO miembro las cubre, así que vía
// planificar FALTA:* resuelve a existente (cero duplicados, correcto por
// protocolo). Dueño directo sin miembro → fallback executor + nota.
test('FALTA:backend existente no se duplica; dueño sin miembro lo corre fallback', async () => {
  __resetRegistry();
  __resetSpawnLog();
  const roster = [{ id: 'a-be', role: 'backend', name: 'Be' }];
  const { session, calls } = fakeSession({
    roster,
    onTurn: routerLoop({ entregaDispatch: 'Entrega limpia y completa.' })
  });
  const fases = [
    { titulo: 'API', dueño: 'FALTA:backend', doneCriteria: 'API anda', dependeDe: [] },
    { titulo: 'Visual', dueño: 'diseño', doneCriteria: 'se ve bien', dependeDe: [1] }
  ];
  const final = await runJob(session, briefBase({ fases }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');

  const log = spawnLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].existing, 'backend');
  assert.equal(log[0].created, false);

  // Orden dependencias: fase 1 (API) antes que fase 2 (Visual).
  const dispatchTurns = calls.turns.filter((t) => t.text.startsWith('[laburo'));
  assert.equal(dispatchTurns.length, 2);
  assert.ok(dispatchTurns[0].text.includes('fase 1/2'));
  assert.ok(dispatchTurns[1].text.includes('fase 2/2'));
  // Ambos los corrió el único miembro; el 2º con nota de fallback anunciada.
  assert.ok(dispatchTurns.every((t) => t.agentId === 'a-be'));
  const entry = __getEntry(final.id);
  assert.ok(entry.anuncios.some((a) => a.texto.includes('no tiene runtime en la llamada')),
    `anuncios: ${JSON.stringify(entry.anuncios)}`);
});

// ── 4. Timeout de turno → fallo limpio ───────────────────────────────────
test('timeout de turno → fallo limpio con motivo, nunca cuelga', async () => {
  __resetRegistry();
  const { session, calls } = fakeSession({
    onTurn: () => { throw new Error('runAgentJobTurn timeout 120000ms (a-be)'); }
  });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'fallo');
  assert.ok(final.motivo.includes('timeout'));
  assert.ok(tiposEventos(calls).includes('fallo'));
});

// ── 5. Escalado por maxRondas ────────────────────────────────────────────
test('tester siempre falla → escalado en maxRondas', async () => {
  __resetRegistry();
  const siempreFail = () => ({
    text: 'Roto.\nVEREDICTO: FAIL — todo mal | PASOS: abrir → mirar',
    toolCalls: [], ms: 1, turnId: 't'
  });
  const { session } = fakeSession({
    onTurn: (agentId, text) => (text.includes('Sos el TESTER')
      ? siempreFail()
      : { text: 'Entrega limpia.', toolCalls: [], ms: 1, turnId: 'd' })
  });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake, maxRondas: 2 });
  assert.equal(final.estado, 'escalado');
  assert.ok(final.resumen.escalado.motivo.includes('máx rondas'));
  assert.equal(final.progreso.ronda, 2);
});

// ── 6a. Mecánicos directos marcados ──────────────────────────────────────
test('mecánicos directos (url+archivo) vs turnos: origen marcado', async () => {
  __resetRegistry();
  const dir = mkdtempSync(join(tmpdir(), 'driver-'));
  const path = join(dir, 'entrega.txt');
  writeFileSync(path, 'hola');
  const { session } = fakeSession({ onTurn: routerLoop() });
  const final = await runJob(session, briefBase({
    fases: FASES_1,
    producto: { tipo: 'generico', descripcion: 'x', url: 'https://ok.test/', path }
  }), { fetchUrl: async () => 'contenido de la página' });

  assert.equal(final.estado, 'aprobado');
  assert.equal(final.resumen.tests.mecanicas, 2);
  assert.equal(final.resumen.tests.turnos, 12);
  assert.equal(final.resumen.tests.celdas, 14);
  const entry = __getEntry(final.id);
  const r1 = entry.testResultados[0].resultados;
  assert.equal(r1.filter((r) => r.origen === 'mecanico').length, 2);
  assert.equal(r1.filter((r) => r.origen === 'turno').length, 12);
});

// ── 6b. Mecánico que falla alimenta el loop ──────────────────────────────
test('mecánico fallido → devolución → escalado con maxRondas 1', async () => {
  __resetRegistry();
  const { session } = fakeSession({ onTurn: routerLoop() });
  const final = await runJob(session, briefBase({
    fases: FASES_1,
    producto: { tipo: 'generico', descripcion: 'x', path: '/tmp/driver-test-noexiste-xyz-123' }
  }), { fetchUrl: fetchUrlFake, maxRondas: 1 });
  assert.equal(final.estado, 'escalado');
  assert.ok(final.resumen.tests.fallidas >= 1);
  const entry = __getEntry(final.id);
  const mec = entry.testResultados[0].resultados.find((r) => r.origen === 'mecanico');
  assert.equal(mec.estado, 'fail');
});

// ── 7. Registry ──────────────────────────────────────────────────────────
test('registry: getJob null si no existe; listJobs incluye corridos', async () => {
  __resetRegistry();
  assert.equal(getJob('job-inexistente'), null);
  const { session } = fakeSession({ onTurn: routerLoop() });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(getJob(final.id).id, final.id);
  assert.ok(listJobs().some((j) => j.id === final.id));
});

// ── 8. Planning turn cuando el brief no trae fases ───────────────────────
test('sin brief.fases → 1 planning turn con JSON', async () => {
  __resetRegistry();
  const { session, calls } = fakeSession({ onTurn: routerLoop() });
  const b = briefBase();
  delete b.fases;
  const final = await runJob(session, b, { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  assert.equal(final.progreso.fasesTotal, 1);
  assert.equal(calls.turns.filter((t) => t.text.includes('Sos el ORQUESTADOR')).length, 1);
});

// ── 9. Planning ilegible → fase fallback, no frena ───────────────────────
test('planning turn ilegible → fallback 1 fase', async () => {
  __resetRegistry();
  const { session } = fakeSession({
    onTurn: (agentId, text) => {
      if (text.includes('Sos el ORQUESTADOR')) return { text: 'no sé, hacé lo que puedas!!!', toolCalls: [], ms: 1, turnId: 'p' };
      return routerLoop()(agentId, text);
    }
  });
  const b = briefBase();
  delete b.fases;
  const final = await runJob(session, b, { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  assert.equal(final.progreso.fasesTotal, 1);
});

// ── 10. enqueueJob async ─────────────────────────────────────────────────
test('enqueueJob: encolado + termina async sin colgar', async () => {
  __resetRegistry();
  const { session } = fakeSession({ onTurn: routerLoop() });
  const { jobId, estado } = enqueueJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(estado, 'encolado');
  const t0 = Date.now();
  let job = getJob(jobId);
  while (!['aprobado', 'fallo', 'escalado'].includes(job.estado) && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 25));
    job = getJob(jobId);
  }
  assert.equal(job.estado, 'aprobado');
});

// ── 11. Job timeout → fallo limpio ───────────────────────────────────────
test('job timeout → fallo limpio', async () => {
  __resetRegistry();
  const { session } = fakeSession({
    onTurn: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { text: 'tarde', toolCalls: [], ms: 200, turnId: 'slow' };
    }
  });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake, timeoutMs: 60 });
  assert.equal(final.estado, 'fallo');
  assert.ok(final.motivo.includes('timeout'));
});
