// Driver track tests (flujo-driver): full autonomous loop with ALWAYS FAKES.
// Zero model, zero disk except tmp. Fake session { programmable
// runAgentJobTurn, announceTeamEvent, roster }, fake fetchUrl.
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

// Configurable turn router: fallaTesterEn = tester turn numbers (1-based)
// that return FAIL; the rest PASS. Dispatch delivery with optional trigger.
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

// ── 1. Full loop ───────────────────────────────────────────────────
test('full loop: plan→dispatch→review(rework)→tester-fails→rework→approves', async () => {
  __resetRegistry();
  const { inserted, store } = fakeStore();
  // ': any' triggers the reviewer frontend checklist (1 review rework).
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
  assert.equal(final.resumen.tests.fallidas, 0); // last round clean

  const tipos = tiposEventos(calls);
  for (const t of ['plan_listo', 'dispatch', 'entrega', 'devolucion', 'aprobado']) {
    assert.ok(tipos.includes(t), `falta anuncio ${t}: ${tipos.join(',')}`);
  }
  assert.ok(tipos.indexOf('plan_listo') < tipos.indexOf('aprobado'));

  // Review rework applied: the delivery was flagged and there was a PEER REVIEW turn.
  const entry = __getEntry(final.id);
  assert.equal(entry.entregas[0].rework, true);
  assert.ok(calls.turns.some((t) => t.text.includes('PEER REVIEW')));
  // Tester rework: 1 redispatch (1 fail) + full re-test.
  assert.ok(entry.entregas.some((e) => e.reworkTester));
  // Learnings recorded.
  assert.ok(inserted.length > 0, 'registrarLearningsDeLaburo debió insertar');
  // Public view: no internal prompts, truncated deliveries.
  assert.ok(final.resumen.entregas[0].resumen.length <= 300);
  assert.ok(!JSON.stringify(final).includes('Sos el TESTER'));
});

// ── 2. Questions short-circuit ───────────────────────────────────────────
test('incomplete brief → questions, zero turns', async () => {
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

// ── 3. FALTA resolved + existing non-duplicated (REAL spawner) ─────────────
// Note: pedirRol asks for base caps and EVERY member covers them, so via
// planificar FALTA:* resolves to existing (zero duplicates, correct per
// protocol). Direct owner without member → fallback executor + note.
test('FALTA:backend existing is not duplicated; owner without member runs fallback', async () => {
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

  // Dependency order: phase 1 (API) before phase 2 (Visual).
  const dispatchTurns = calls.turns.filter((t) => t.text.startsWith('[laburo'));
  assert.equal(dispatchTurns.length, 2);
  assert.ok(dispatchTurns[0].text.includes('fase 1/2'));
  assert.ok(dispatchTurns[1].text.includes('fase 2/2'));
  // Both were run by the only member; the 2nd with announced fallback note.
  assert.ok(dispatchTurns.every((t) => t.agentId === 'a-be'));
  const entry = __getEntry(final.id);
  assert.ok(entry.anuncios.some((a) => a.texto.includes('no tiene runtime en la llamada')),
    `anuncios: ${JSON.stringify(entry.anuncios)}`);
});

// ── 4. Turn timeout → clean failure ───────────────────────────────────
test('turn timeout → clean failure with reason, never hangs', async () => {
  __resetRegistry();
  const { session, calls } = fakeSession({
    onTurn: () => { throw new Error('runAgentJobTurn timeout 120000ms (a-be)'); }
  });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'fallo');
  assert.ok(final.motivo.includes('timeout'));
  assert.ok(tiposEventos(calls).includes('fallo'));
});

// ── 5. Escalation on maxRondas ────────────────────────────────────────────
test('tester always fails → escalation at maxRondas', async () => {
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

// ── 6a. Marked direct mechanicals ──────────────────────────────────────
test('direct mechanicals (url+file) vs turns: origin marked', async () => {
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

// ── 6b. Failing mechanical feeds the loop ──────────────────────────────
test('failed mechanical → rework request (devolucion) → escalation with maxRondas 1', async () => {
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
test('registry: getJob null if missing; listJobs includes runs', async () => {
  __resetRegistry();
  assert.equal(getJob('job-inexistente'), null);
  const { session } = fakeSession({ onTurn: routerLoop() });
  const final = await runJob(session, briefBase({ fases: FASES_1 }), { fetchUrl: fetchUrlFake });
  assert.equal(getJob(final.id).id, final.id);
  assert.ok(listJobs().some((j) => j.id === final.id));
});

// ── 8. Planning turn when the brief brings no phases ───────────────────────
test('without brief.fases → 1 planning turn with JSON', async () => {
  __resetRegistry();
  const { session, calls } = fakeSession({ onTurn: routerLoop() });
  const b = briefBase();
  delete b.fases;
  const final = await runJob(session, b, { fetchUrl: fetchUrlFake });
  assert.equal(final.estado, 'aprobado');
  assert.equal(final.progreso.fasesTotal, 1);
  assert.equal(calls.turns.filter((t) => t.text.includes('Sos el ORQUESTADOR')).length, 1);
});

// ── 9. Illegible planning → fallback phase, does not stall ───────────────────────
test('illegible planning turn → 1-phase fallback', async () => {
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
test('enqueueJob: queued + finishes async without hanging', async () => {
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

// ── 11. Job timeout → clean failure ───────────────────────────────────────
test('job timeout → clean failure', async () => {
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
