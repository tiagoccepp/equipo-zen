// Tests track A (flujo-orquestador): 7 contratos, plan, rechazo→replan,
// loop devolución con corte, preguntasFaltantes, research, voz y hook.
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
test('brief válido pasa', () => {
  assert.equal(isBrief(briefValido()).ok, true);
  assertBrief(briefValido());
});

test('brief sin objetivo ni criterios no pasa', () => {
  const r = isBrief({ contexto: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('objetivo'));
  assert.ok(r.errors.join(' ').includes('criteriosExito'));
  assert.throws(() => assertBrief({}), /brief/i);
});

// ── 2. Plan ─────────────────────────────────────────────────────────────
test('plan válido pasa', () => {
  const plan = crearPlan(briefValido(), { jobId: 'job-1', fases: FASES_OK });
  assert.equal(plan.fases.length, 3);
  assert.deepEqual(plan.fases.map((f) => f.n), [1, 2, 3]);
  assertPlan(plan);
});

test('plan exige doneCriteria por fase', () => {
  assert.throws(
    () => crearPlan(briefValido(), { fases: [{ titulo: 'X', dueño: 'be', doneCriteria: '' }] }),
    /doneCriteria/
  );
});

test('plan rechaza dependeDe a fase posterior o igual', () => {
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

test('plan rechaza numeración con huecos', () => {
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

test('ordenEjecucion respeta dependencias', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  assert.deepEqual(ordenEjecucion(plan).map((f) => f.n), [1, 2, 3]);
});

// ── 3. Dispatch ─────────────────────────────────────────────────────────
test('dispatch válido pasa', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const d = hacerDispatch(plan, 1, { para: 'frontend' });
  assert.equal(d.fase, 1);
  assert.equal(d.intento, 1);
  assertDispatch(d);
});

test('dispatch a fase inexistente lanza', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  assert.throws(() => hacerDispatch(plan, 9), /Fase 9/);
});

test('dispatch inválido no pasa', () => {
  assert.equal(isDispatch({}).ok, false);
  assert.throws(() => assertDispatch({ taskId: 'x' }), /dispatch/i);
});

// ── 4. Spawn-request / response ─────────────────────────────────────────
test('spawn-request válido pasa', () => {
  const req = { jobId: 'job-1', rolFaltante: 'video', porQue: 'hace falta edición', capabilities: ['workspace'] };
  assert.equal(isSpawnRequest(req).ok, true);
  assertSpawnRequest(req);
});

test('spawn-request sin capabilities no pasa', () => {
  assert.equal(isSpawnRequest({ jobId: 'j', rolFaltante: 'r', porQue: 'p', capabilities: [] }).ok, false);
});

test('spawn-response acepta agente, existente o motivo', () => {
  assert.equal(isSpawnResponse({ ok: true, agente: { id: 'a', nombre: 'N' } }).ok, true);
  assert.equal(isSpawnResponse({ ok: true, existente: { id: 'b', nombre: 'M' } }).ok, true);
  assert.equal(isSpawnResponse({ ok: false, motivo: 'no hay cupo' }).ok, true);
  assertSpawnResponse({ ok: false, motivo: 'x' });
  assert.equal(isSpawnResponse({ ok: true }).ok, false);
  assert.equal(isSpawnResponse({ ok: false }).ok, false);
});

// ── 5. Peer review ──────────────────────────────────────────────────────
test('peer-review válido pasa y vacío no', () => {
  const pr = { de: 'fe', para: 'be', que: 'cachear', porQue: 'lento', como: 'con ETag' };
  assert.equal(isPeerReview(pr).ok, true);
  assertPeerReview(pr);
  assert.equal(isPeerReview({ de: 'a', para: 'b' }).ok, false);
});

// ── 6. Devolución ───────────────────────────────────────────────────────
test('devolución válida pasa', () => {
  const dev = {
    jobId: 'job-1', ronda: 1,
    items: [{ severidad: 'bug', descripcion: 'el botón no anda', reproduccion: 'click', persona: 'usuario' }]
  };
  assert.equal(isDevolucion(dev).ok, true);
  assertDevolucion(dev);
});

test('devolución sin items o severidad mala no pasa', () => {
  assert.equal(isDevolucion({ jobId: 'j', ronda: 1, items: [] }).ok, false);
  assert.equal(isDevolucion({ jobId: 'j', ronda: 1, items: [{ severidad: 'x', descripcion: 'd' }] }).ok, false);
  assert.equal(isDevolucion({ jobId: 'j', ronda: 0, items: [{ severidad: 'bug', descripcion: 'd' }] }).ok, false);
});

// ── 7. Aprobación ───────────────────────────────────────────────────────
test('aprobación válida pasa', () => {
  const ap = {
    jobId: 'job-1',
    probado: [{ persona: 'usuario', dimensiones: ['visual', 'funcional'] }],
    arreglado: ['botón'],
    limitaciones: ['sin modo offline']
  };
  assert.equal(isAprobacion(ap).ok, true);
  assertAprobacion(ap);
});

test('aprobación sin probado no pasa', () => {
  assert.equal(isAprobacion({ jobId: 'j', probado: [] }).ok, false);
});

// ── preguntasFaltantes ──────────────────────────────────────────────────
test('preguntasFaltantes: brief pelado pide 5, completo pide 0', () => {
  assert.equal(preguntasFaltantes({}).length, 5);
  assert.deepEqual(preguntasFaltantes(briefValido()), []);
  const sinUna = briefValido();
  delete sinUna.formatoEntrega;
  const ps = preguntasFaltantes(sinUna);
  assert.equal(ps.length, 1);
  assert.ok(ps[0].includes('formato'));
});

// ── rechazo → replan ────────────────────────────────────────────────────
function jobConPlan() {
  const orq = new Orchestrator();
  const { job } = orq.intake(briefValido());
  job.plan = crearPlan(briefValido(), { jobId: job.id, fases: FASES_OK });
  return { orq, job };
}

test('rechazo 1 vez con motivo → re-dispatch intento 2', () => {
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

test('segundo rechazo igual → RECHAZO_AGOTADO', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  job.dispatches.set(d.taskId, d);
  aplicarRechazo(job, d, 'motivo uno');
  const d2 = hacerDispatch(job.plan, 1, { para: 'frontend', intento: 2 });
  assert.throws(() => aplicarRechazo(job, d2, 'motivo dos'), /RECHAZO_AGOTADO/);
});

test('rechazo sin motivo lanza', () => {
  const { job } = jobConPlan();
  const d = hacerDispatch(job.plan, 1, { para: 'frontend' });
  assert.throws(() => aplicarRechazo(job, d, '  '), /motivo/);
});

// ── loop devolución con corte ───────────────────────────────────────────
test('devolución ronda<max → rework con re-dispatches', () => {
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

test('devolución ronda==max → escalado, sin re-dispatch', () => {
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

test('devolución de otro job lanza', () => {
  const { job } = jobConPlan();
  assert.throws(
    () => aplicarDevolucion(job, { jobId: 'otro', ronda: 1, items: [{ severidad: 'bug', descripcion: 'x' }] }),
    /no corresponde/
  );
});

// ── research ────────────────────────────────────────────────────────────
test('researchQueries deriva hasta 4 queries del objetivo', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const qs = researchQueries(briefValido(), plan);
  assert.ok(qs.length >= 3 && qs.length <= 4);
  assert.ok(qs[0].includes('open source'));
});

test('runResearch con fetch fake junta hallazgos y corta en maxFuentes', async () => {
  const res = await runResearch(['q1', 'q2', 'q3'], {
    fetchUrl: async (q) => `resultado de ${q}`,
    maxFuentes: 2
  });
  assert.equal(res.length, 2);
  assert.ok(res[0].hallazgos[0].resumen.includes('q1'));
});

test('runResearch nunca lanza: fallo queda como error', async () => {
  const res = await runResearch(['q1'], {
    fetchUrl: async () => { throw new Error('red caída'); }
  });
  assert.equal(res.length, 1);
  assert.ok(res[0].error.includes('red caída'));
});

test('runResearch sin fetchUrl avisa y sigue', async () => {
  const res = await runResearch(['q1']);
  assert.equal(res.length, 1);
  assert.equal(res[0].hallazgos.length, 0);
  assert.ok(res[0].nota.includes('sin fetchUrl'));
});

test('anexarResearch deja decisión explícita por hallazgo', () => {
  const plan = crearPlan(briefValido(), { fases: FASES_OK });
  const con = anexarResearch(plan, [{ query: 'q', hallazgos: [{ fuente: 'f', resumen: 'lib X' }] }], ['usar lib X']);
  assert.equal(con.research[0].decision, 'usar lib X');
  const vacio = anexarResearch(plan, []);
  assert.equal(vacio.research[0].decision, 'se construye desde cero');
});

// ── voz ─────────────────────────────────────────────────────────────────
test('voicePayload cubre los 5 eventos con su dueño', () => {
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

test('voicePayload devuelve null con evento desconocido o vacío', () => {
  assert.equal(voicePayload(null), null);
  assert.equal(voicePayload({}), null);
  assert.equal(voicePayload({ tipo: 'fiesta' }), null);
});

// ── Orchestrator end-to-end en memoria ──────────────────────────────────
test('flujo completo: intake → planificar → dispatch → entregar → aprobar', async () => {
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
  // Voces: plan + dispatch + entrega + aprobado.
  assert.deepEqual(voces.map((v) => v.speaker), ['Orquestador', 'Orquestador', 'frontend', 'Pablo']);
});

test('spawn sin cablear marca SIN_DUEÑO en vez de trabar', async () => {
  const orq = new Orchestrator({ fetchUrl: async () => '' });
  const { job } = orq.intake(briefValido());
  await orq.planificar(job.id, [
    { titulo: 'Solo', dueño: 'FALTA:video', doneCriteria: 'x', dependeDe: [] }
  ], { research: false });
  assert.equal(job.plan.fases[0].dueño, 'SIN_DUEÑO:video');
  assert.equal(job.estado, 'planificado');
});

test('announce que lanza no rompe el flujo', () => {
  const orq = new Orchestrator({ announce: () => { throw new Error('llamada caída'); } });
  const { job } = orq.intake(briefValido());
  assert.equal(job.estado, 'brief_ok');
});

// ── hook voz en meeting-session: no-op sin llamada ───────────────────────
test('announceTeamEvent es no-op sin reunión viva', async () => {
  process.env.SESSION_LOG = '0';
  const { MeetingSession } = await import('../server/lib/meeting-session.js');
  const s = Object.create(MeetingSession.prototype);
  s.meeting = null;
  s.socket = null;
  assert.equal(s.announceTeamEvent({ tipo: 'plan_listo', fases: 2 }), null);
});

test('announceTeamEvent emite team_event con llamada viva', async () => {
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
