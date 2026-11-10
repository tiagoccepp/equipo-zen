// Track A tests (flujo-orquestador): 7 contracts, plan, rejection→replan,
// feedback loop with cutoff, preguntasFaltantes, research, voice and hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAprobacion,
  assertBrief,
  assertDevolucion,
  assertDispatch,
  assertPeerReview,
  assertPlan,
  assertSpawnRequest,
  assertSpawnResponse,
  isAprobacion,
  isBrief,
  isDevolucion,
  isDispatch,
  isPeerReview,
  isPlan,
  isSpawnRequest,
  isSpawnResponse
} from '../server/lib/team-protocol.js';

import {
  anexarResearch,
  aplicarDevolucion,
  aplicarRechazo,
  crearPlan,
  hacerDispatch,
  ordenEjecucion,
  Orchestrator,
  preguntasFaltantes,
  researchQueries,
  runResearch,
  voicePayload
} from '../server/lib/orchestrator.js';

const BRIEF_OK = {
  objetivo: 'Landing para la panadería con pedido por WhatsApp',
  contexto: 'Panadería de barrio, clientes de 30-60 años, venden por mostrador',
  restricciones: ['presupuesto bajo', 'sin backend propio'],
  criteriosExito: ['carga en <2s', 'botón de WhatsApp visible siempre'],
  formatoEntrega: 'web estática',
  de: 'pablo'
};

const FASES_OK = [
  { titulo: 'Diseño y copy', dueño: 'diseño', doneCriteria: 'mock aprobado + textos finales', dependeDe: [] },
  { titulo: 'Maquetado', dueño: 'frontend', doneCriteria: 'página responsive idéntica al mock', dependeDe: [1] },
  { titulo: 'Publicación', dueño: 'devops', doneCriteria: 'URL pública con HTTPS', dependeDe: [2] }
];

function briefValido() { return { ...BRIEF_OK, restricciones: [...BRIEF_OK.restricciones], criteriosExito: [...BRIEF_OK.criteriosExito] }; }

// ── 1. Brief ────────────────────────────────────────────────────────────
test('valid brief passes', () => {
  assert.equal(isBrief(briefValido()).ok, true);
  assertBrief(briefValido());
});

test('brief without objetivo or criteriosExito fails', () => {
  const r = isBrief({ contexto: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('objetivo'));
  assert.ok(r.errors.join(' ').includes('criteriosExito'));
  assert.throws(() => assertBrief({}), /brief/i);
});

// ── 2. Plan ─────────────────────────────────────────────────────────────
test('valid plan passes', () => {
  const plan = crearPlan(briefValido(), { jobId: 'job-1', fases: FASES_OK });
  assert.equal(plan.fases.length, 3);
  assert.deepEqual(plan.fases.map((f) => f.n), [1, 2, 3]);
  assertPlan(plan);
});

test('plan requires doneCriteria per phase', () => {
  assert.throws(
    () => crearPlan(briefValido(), { fases: [{ titulo: 'X', dueño: 'be', doneCriteria: '' }] }),
    /doneCriteria/
  );
});

test('plan rejects dependeDe to a later or equal phase', () => {
  const r = isPlan({
    jobId: 'j',
    fases: [
      { n: 1, titulo: 'A', dueño: 'x', doneCriteria: 'd', dependeDe: [2] },
      { n: 2, titulo: 'B', dueño: 'x', doneCriteria: 'd' }
    ]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('dependeDe'));
});

test('plan rejects numbering with gaps', () => {
  const r = isPlan({
    jobId: 'j',
    fases: [
      { n: 1, titulo: 'A', dueño: 'x', doneCriteria: 'd' },
      { n: 3, titulo: 'C', dueño: 'x', doneCriteria: 'd' }
    ]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('fase 2'));
});

test('ordenEjecucion respects dependencies', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  assert.deepEqual(ordenEjecucion(plan).map((f) => f.n), [1, 2, 3]);
});

// ── 3. Dispatch ─────────────────────────────────────────────────────────
test('valid dispatch passes', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const d = hacerDispatch(plan, 1, { para: 'frontend' });
  assert.equal(d.fase, 1);
  assert.equal(d.intento, 1);
  assertDispatch(d);
});

test('dispatch to missing phase throws', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  assert.throws(() => hacerDispatch(plan, 9), /Fase 9/);
});

test('invalid dispatch fails', () => {
  assert.equal(isDispatch({}).ok, false);
  assert.throws(() => assertDispatch({ taskId: 'x' }), /dispatch/i);
});

// ── 4. Spawn-request / response ─────────────────────────────────────────
test('valid spawn-request passes', () => {
  const req = { jobId: 'job-1', rolFaltante: 'video', porQue: 'hace falta edición', capabilities: ['workspace'] };
  assert.equal(isSpawnRequest(req).ok, true);
  assertSpawnRequest(req);
});

test('spawn-request without capabilities fails', () => {
  assert.equal(isSpawnRequest({ jobId: 'j', rolFaltante: 'r', porQue: 'p', capabilities: [] }).ok, false);
});

test('spawn-response accepts agente, existente or motivo', () => {
  assert.equal(isSpawnResponse({ ok: true, agente: { id: 'a', nombre: 'N' } }).ok, true);
  assert.equal(isSpawnResponse({ ok: true, existente: { id: 'b', nombre: 'M' } }).ok, true);
  assert.equal(isSpawnResponse({ ok: false, motivo: 'no hay cupo' }).ok, true);
  assertSpawnResponse({ ok: false, motivo: 'x' });
  assert.equal(isSpawnResponse({ ok: true }).ok, false);
  assert.equal(isSpawnResponse({ ok: false }).ok, false);
});

// ── 5. Peer review ──────────────────────────────────────────────────────
test('valid peer-review passes, empty one fails', () => {
  const pr = { de: 'fe', para: 'be', que: 'cachear', porQue: 'lento', como: 'con ETag' };
  assert.equal(isPeerReview(pr).ok, true);
  assertPeerReview(pr);
  assert.equal(isPeerReview({ de: 'a', para: 'b' }).ok, false);
});

// ── 6. Handoff ───────────────────────────────────────────────────────
test('valid devolucion passes', () => {
  const dev = {
    jobId: 'job-1', ronda: 1,
    items: [{ severidad: 'bug', descripcion: 'el botón no anda', reproduccion: 'click', persona: 'usuario' }]
  };
  assert.equal(isDevolucion(dev).ok, true);
  assertDevolucion(dev);
});

test('devolucion without items or with bad severidad fails', () => {
  assert.equal(isDevolucion({ jobId: 'j', ronda: 1, items: [] }).ok, false);
  assert.equal(isDevolucion({ jobId: 'j', ronda: 1, items: [{ severidad: 'x', descripcion: 'd' }] }).ok, false);
  assert.equal(isDevolucion({ jobId: 'j', ronda: 0, items: [{ severidad: 'bug', descripcion: 'd' }] }).ok, false);
});

// ── 7. Approval ───────────────────────────────────────────────────────
test('valid aprobacion passes', () => {
  const ap = {
    jobId: 'job-1',
    probado: [{ persona: 'usuario', dimensiones: ['visual', 'funcional'] }],
    arreglado: ['botón'],
    limitaciones: ['sin modo offline']
  };
  assert.equal(isAprobacion(ap).ok, true);
  assertAprobacion(ap);
});

test('aprobacion without probado fails', () => {
  assert.equal(isAprobacion({ jobId: 'j', probado: [] }).ok, false);
});

// ── preguntasFaltantes ──────────────────────────────────────────────────
test('preguntasFaltantes: bare brief asks 5, complete asks 0', () => {
  assert.equal(preguntasFaltantes({}).length, 5);
  assert.deepEqual(preguntasFaltantes(briefValido()), []);
  const sinUna = briefValido();
  delete sinUna.formatoEntrega;
  const ps = preguntasFaltantes(sinUna);
  assert.equal(ps.length, 1);
  assert.ok(ps[0].includes('formato'));
});

// ── rejection → replan ────────────────────────────────────────────────────
function jobConPlan() {
  const orq = new Orchestrator();
  const { job } = orq.intake(briefValido());
  job.plan = crearPlan(briefValido(), { jobId: job.id, fases: FASES_OK });
  return { orq, job };
}

test('rejection once with motivo → re-dispatch intento 2', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  d.estado = 'en_curso';
  job.dispatches.set(d.taskId, d);
  const { dispatch: nuevo } = aplicarRechazo(job, d, 'estoy tapado', { nuevoDueño: 'backend' });
  assert.equal(nuevo.intento, 2);
  assert.equal(nuevo.para, 'backend');
  assert.equal(nuevo.estado, 'pendiente');
  assert.equal(d.estado, 'rechazado');
  assert.ok(d.motivoRechazo.includes('tapado'));
});

test('second rejection anyway → RECHAZO_AGOTADO', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  job.dispatches.set(d.taskId, d);
  aplicarRechazo(job, d, 'motivo uno');
  const d2 = hacerDispatch(job.plan, 1, { para: 'frontend', intento: 2 });
  assert.throws(() => aplicarRechazo(job, d2, 'motivo dos'), /RECHAZO_AGOTADO/);
});

test('rejection without motivo throws', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  assert.throws(() => aplicarRechazo(job, d, '  '), /motivo/);
});

// ── feedback loop with cutoff ───────────────────────────────────────────
test('devolucion ronda<max → rework with re-dispatches', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  job.dispatches.set(d.taskId, d);
  const r = aplicarDevolucion(job, {
    jobId: job.id, taskId: d.taskId, ronda: 1,
    items: [
      { severidad: 'bug', descripcion: 'falla X', persona: 'usuario' },
      { severidad: 'mejora', descripcion: 'sumar Y', persona: 'comprador' }
    ]
  }, { maxRondas: 3 });
  assert.equal(r.estado, 'rework');
  assert.equal(r.ronda, 2);
  assert.equal(r.redispatches.length, 2);
  assert.ok(r.redispatches[0].tarea.startsWith('[bug]'));
  assert.equal(r.redispatches[0].para, 'frontend');
});

test('devolucion ronda==max → escalado, no re-dispatch', () => {
  const { job } = jobConPlan();
  const r = aplicarDevolucion(job, {
    jobId: job.id, ronda: 3,
    items: [{ severidad: 'bug', descripcion: 'sigue roto' }]
  }, { maxRondas: 3 });
  assert.equal(r.estado, 'escalado');
  assert.equal(r.redispatches.length, 0);
  assert.equal(job.estado, 'escalado');
  assert.ok(job.escalado.motivo.includes('máx rondas'));
});

test('devolucion from another job throws', () => {
  const { job } = jobConPlan();
  assert.throws(
    () => aplicarDevolucion(job, { jobId: 'otro', ronda: 1, items: [{ severidad: 'bug', descripcion: 'x' }] }),
    /no corresponde/
  );
});

// ── research ────────────────────────────────────────────────────────────
test('researchQueries derives up to 4 queries from objetivo', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const qs = researchQueries(briefValido(), plan);
  assert.ok(qs.length >= 3 && qs.length <= 4);
  assert.ok(qs[0].includes('open source'));
});

test('runResearch with fake fetch gathers hallazgos and caps at maxFuentes', async () => {
  const res = await runResearch(['q1', 'q2', 'q3'], {
    fetchUrl: async (q) => `resultado de ${q}`,
    maxFuentes: 2
  });
  assert.equal(res.length, 2);
  assert.ok(res[0].hallazgos[0].resumen.includes('q1'));
});

test('runResearch never throws: failure stays as error', async () => {
  const res = await runResearch(['q1'], {
    fetchUrl: async () => { throw new Error('red caída'); }
  });
  assert.equal(res.length, 1);
  assert.ok(res[0].error.includes('red caída'));
});

test('runResearch without fetchUrl warns and continues', async () => {
  const res = await runResearch(['q1']);
  assert.equal(res.length, 1);
  assert.equal(res[0].hallazgos.length, 0);
  assert.ok(res[0].nota.includes('sin fetchUrl'));
});

test('anexarResearch leaves an explicit decision per hallazgo', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const con = anexarResearch(plan, [{ query: 'q', hallazgos: [{ fuente: 'f', resumen: 'lib X' }] }], ['usar lib X']);
  assert.equal(con.research[0].decision, 'usar lib X');
  const vacio = anexarResearch(plan, []);
  assert.equal(vacio.research[0].decision, 'se construye desde cero');
});

// ── voice ─────────────────────────────────────────────────────────────────
test('voicePayload covers the 5 events with their owner', () => {
  const plan = voicePayload({ tipo: 'plan_listo', fases: 3, resumen: 'a→b' });
  assert.equal(plan.speaker, 'Orquestador');
  assert.ok(plan.texto.includes('3 fases'));

  const disp = voicePayload({ tipo: 'dispatch', para: 'frontend', tarea: 'maquetar', doneCriteria: 'igual al mock' });
  assert.equal(disp.speaker, 'Orquestador');
  assert.ok(disp.texto.includes('frontend'));

  const ent = voicePayload({ tipo: 'entrega', de: 'Camila', resumen: 'mock listo' });
  assert.equal(ent.speaker, 'Camila');

  const dev = voicePayload({ tipo: 'devolucion', items: 2, persona: 'comprador', resumen: 'falta precio', ronda: 1 });
  assert.equal(dev.speaker, 'Tester');
  assert.ok(dev.texto.includes('comprador'));

  const apr = voicePayload({ tipo: 'aprobado', resumen: 'todo verde', limitaciones: 'sin offline' });
  assert.equal(apr.speaker, 'Pablo');
  assert.ok(apr.texto.includes('sin offline'));
});

test('voicePayload returns null with unknown or empty event', () => {
  assert.equal(voicePayload(null), null);
  assert.equal(voicePayload({}), null);
  assert.equal(voicePayload({ tipo: 'fiesta' }), null);
});

// ── Orchestrator end-to-end in memory ──────────────────────────────────
test('full flow: intake → planificar → dispatch → entregar → aprobar', async () => {
  const voces = [];
  const orq = new Orchestrator({
    announce: (p) => voces.push(p),
    fetchUrl: async () => 'lib útil',
    requestSpawn: async (req) => ({ ok: true, agente: { id: 'vid-1', nombre: 'Video', titulo: 'Editor' } })
  });

  const incompleto = orq.intake({ objetivo: 'x' });
  assert.equal(incompleto.estado, 'preguntas');
  assert.ok(incompleto.preguntas.length > 0);

  const { job } = orq.intake(briefValido());
  assert.equal(job.estado, 'brief_ok');

  await orq.planificar(job.id, [
    ...FASES_OK,
    { titulo: 'Video demo', dueño: 'FALTA:video', doneCriteria: 'mp4 de 30s', dependeDe: [3] }
  ]);
  assert.equal(job.plan.fases.length, 4);
  assert.equal(job.plan.fases[3].dueño, 'Video');
  assert.ok(job.plan.research.length > 0);

  const d = orq.dispatchFase(job.id, 1, { para: 'frontend' });
  assert.equal(d.estado, 'en_curso');
  orq.entregar(job.id, d.taskId, 'maquetado listo');
  assert.equal(d.estado, 'entregado');

  orq.aprobar(job.id, {
    jobId: job.id,
    probado: [{ persona: 'usuario', dimensiones: ['visual'] }],
    arreglado: [],
    limitaciones: []
  });
  assert.equal(orq.estado(job.id).estado, 'aprobado');
  // Voices: plan + dispatch + entrega + aprobado.
  assert.deepEqual(voces.map((v) => v.speaker), ['Orquestador', 'Orquestador', 'frontend', 'Pablo']);
});

test('unwired spawn marks SIN_DUEÑO instead of blocking', async () => {
  const orq = new Orchestrator({ fetchUrl: async () => '' });
  const { job } = orq.intake(briefValido());
  await orq.planificar(job.id, [
    { titulo: 'Solo', dueño: 'FALTA:video', doneCriteria: 'x', dependeDe: [] }
  ], { research: false });
  assert.equal(job.plan.fases[0].dueño, 'SIN_DUEÑO:video');
  assert.equal(job.estado, 'planificado');
});

test('throwing announce does not break the flow', () => {
  const orq = new Orchestrator({ announce: () => { throw new Error('llamada caída'); } });
  const { job } = orq.intake(briefValido());
  assert.equal(job.estado, 'brief_ok');
});

// ── voice hook in meeting-session: no-op without a call ───────────────────────
test('announceTeamEvent is a no-op without a live meeting', async () => {
  process.env.SESSION_LOG = '0';
  const { MeetingSession } = await import('../server/lib/meeting-session.js');
  const s = Object.create(MeetingSession.prototype);
  s.meeting = null;
  s.socket = null;
  assert.equal(s.announceTeamEvent({ tipo: 'plan_listo', fases: 2 }), null);
});

test('announceTeamEvent emits team_event with a live call', async () => {
  process.env.SESSION_LOG = '0';
  const { MeetingSession } = await import('../server/lib/meeting-session.js');
  const sent = [];
  const tele = [];
  const s = Object.create(MeetingSession.prototype);
  s.meeting = { id: 'm1' };
  s.socket = { readyState: 1 };
  s.voiceEnabled = false;
  s.send = (p) => sent.push(p);
  s.logTelemetry = (t, p) => tele.push([t, p]);
  const payload = s.announceTeamEvent({ tipo: 'aprobado', resumen: 'todo verde' });
  assert.equal(payload.speaker, 'Pablo');
  assert.equal(sent[0].type, 'team_event');
  assert.equal(sent[0].speaker, 'Pablo');
  assert.equal(tele[0][0], 'team_event');
});
