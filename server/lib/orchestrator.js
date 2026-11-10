// ── Orchestrator: brief → plan → research → dispatch → tracking → replan ──
// Track A. The Orchestrator plans meticulously, researches pre-built FIRST,
// hands out to specialists, requests roles from the Spawner by protocol and
// re-dispatches on Tester returns (loop with max rounds).
//
// Isolation: imports ONLY team-protocol.js (+ nanoid). The Spawner, web
// fetch, voice and store arrive as INJECTED DEPS in the constructor:
// never direct imports (the Spawner is track B, the call is main).
//
// State: memory (Map per jobId). Each dispatch can be mirrored into the
// existing tasks table when main passes `store` (see flujo-orquestador-plan.md:
// NO new table — tasks/goals/task_comments already model tracking).

import { nanoid } from 'nanoid';

import {
  assertBrief,
  assertDevolucion,
  assertDispatch,
  assertPlan,
  assertSpawnRequest
} from './team-protocol.js';

export const MAX_RONDAS_DEFAULT = 3;
export const MAX_FUENTES_DEFAULT = 3;

// ── Intake: questions when info is missing (Pablo-interface asks, never invents) ──

export function preguntasFaltantes(brief) {
  const preguntas = [];
  const b = brief && typeof brief === 'object' ? brief : {};
  const vacio = (v) => typeof v !== 'string' || v.trim().length === 0;

  if (vacio(b.objetivo)) {
    preguntas.push('¿Cuál es el objetivo concreto del laburo? (una frase: qué hay que entregar)');
  }
  if (vacio(b.contexto)) {
    preguntas.push('¿En qué contexto se usa? (para quién es, dónde vive, qué lo rodea)');
  }
  if (!Array.isArray(b.restricciones) || b.restricciones.length === 0) {
    preguntas.push('¿Hay restricciones? (plazos, presupuesto, stack, cosas que NO se pueden hacer)');
  }
  if (!Array.isArray(b.criteriosExito) || b.criteriosExito.length === 0) {
    preguntas.push('¿Cómo sabemos que quedó bien? (criterios de éxito medibles)');
  }
  if (vacio(b.formatoEntrega)) {
    preguntas.push('¿En qué formato se entrega? (web, documento, repo, mensaje…)');
  }
  return preguntas;
}

// ── Plan ────────────────────────────────────────────────────────────────

// Phases are proposed by the Orchestrator LLM (prompt, wired by main) or
// by main by hand; here they are ordered, numbered and VALIDATED (plan contract).
export function crearPlan(brief, { jobId = null, fases = [] } = {}) {
  assertBrief(brief);
  const plan = {
    jobId: jobId || `job-${nanoid(6)}`,
    fases: fases.map((f, i) => ({
      n: i + 1,
      titulo: String(f.titulo || '').trim(),
      dueño: String(f.dueño || f.dueno || '').trim(),
      doneCriteria: String(f.doneCriteria || '').trim(),
      dependeDe: Array.isArray(f.dependeDe) ? [...f.dependeDe] : []
    })),
    research: []
  };
  return assertPlan(plan);
}

// Execution order: verifies the DAG (dependeDe only to earlier ones is already
// guaranteed by the contract; this still walks it in safe order).
export function ordenEjecucion(plan) {
  assertPlan(plan);
  const porN = new Map(plan.fases.map((f) => [f.n, f]));
  const visitadas = new Set();
  const orden = [];
  const visitar = (fase) => {
    if (visitadas.has(fase.n)) return;
    visitadas.add(fase.n);
    for (const dep of fase.dependeDe || []) {
      const previa = porN.get(dep);
      if (previa) visitar(previa);
    }
    orden.push(fase);
  };
  for (const fase of [...plan.fases].sort((a, b) => a.n - b.n)) visitar(fase);
  return orden;
}

// ── Research: pre-built first (open source, libs, designs) ─────────────

const STOPWORDS = new Set([
  'una', 'uno', 'para', 'con', 'que', 'los', 'las', 'del', 'por', 'una',
  'the', 'and', 'for', 'with', 'quiero', 'hacer', 'esto', 'esta', 'este'
]);

// Queries derived from the objetivo + phase titles. Pure (testable).
export function researchQueries(brief, plan = null) {
  assertBrief(brief);
  const palabras = String(brief.objetivo || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
  const nucleo = palabras.join(' ') || String(brief.objetivo).slice(0, 80);
  const queries = [
    `${nucleo} open source`,
    `${nucleo} librería template`,
    `${nucleo} ejemplo diseño`
  ];
  if (plan?.fases?.length) {
    const primera = plan.fases[0].titulo || '';
    if (primera) queries.push(`${primera} open source template`);
  }
  return [...new Set(queries)].slice(0, 4);
}

// Runs queries with INJECTED fetchUrl (main passes manos fetch_url or
// web_search). Never throws: each failure lands as a { error } finding.
export async function runResearch(queries, { fetchUrl = null, maxFuentes = MAX_FUENTES_DEFAULT } = {}) {
  const lista = (Array.isArray(queries) ? queries : []).slice(0, 4);
  const resultados = [];
  for (const query of lista) {
    if (typeof fetchUrl !== 'function') {
      resultados.push({ query, hallazgos: [], nota: 'sin fetchUrl inyectado: research pendiente (lo hace el Orquestador con herramientas)' });
      continue;
    }
    try {
      const raw = await fetchUrl(query);
      const texto = String(raw || '').slice(0, 2000);
      resultados.push({ query, hallazgos: texto ? [{ fuente: query, resumen: texto.slice(0, 500) }] : [] });
    } catch (error) {
      resultados.push({ query, hallazgos: [], error: String(error?.message || error).slice(0, 200) });
    }
    if (resultados.reduce((n, r) => n + r.hallazgos.length, 0) >= maxFuentes) break;
  }
  return resultados;
}

// Appends research to the plan: which pre-built is used and why (or none usable).
export function anexarResearch(plan, resultados, decisiones = []) {
  assertPlan(plan);
  const research = [];
  for (const r of resultados || []) {
    for (const h of r.hallazgos || []) {
      research.push({
        hallazgo: String(h.resumen || h.fuente || '').slice(0, 300),
        fuente: String(h.fuente || r.query || '').slice(0, 200),
        decision: 'evaluar'
      });
    }
  }
  decisiones.forEach((d, i) => {
    if (research[i] && d) research[i].decision = String(d).slice(0, 300);
  });
  if (research.length === 0) {
    research.push({ hallazgo: 'sin pre-hecho usable encontrado', fuente: '', decision: 'se construye desde cero' });
  }
  return assertPlan({ ...plan, research });
}

// ── Dispatch + reject-once + replan ───────────────────────────────────

export function hacerDispatch(plan, faseN, { para = null, intento = 1, deadlineRelativo = null, coordinarCon = [] } = {}) {
  assertPlan(plan);
  const fase = plan.fases.find((f) => f.n === faseN);
  if (!fase) throw new Error(`Fase ${faseN} no existe en el plan ${plan.jobId}`);
  return assertDispatch({
    taskId: `t-${nanoid(6)}`,
    jobId: plan.jobId,
    fase: faseN,
    para: para || fase.dueño,
    tarea: fase.titulo,
    doneCriteria: fase.doneCriteria,
    deadlineRelativo: deadlineRelativo || undefined,
    coordinarCon,
    intento,
    estado: 'pendiente'
  });
}

// Rejection key: same dueño + same tarea (normalized).
export function claveRechazo(dispatch) {
  return `${String(dispatch.para).toLowerCase()}::${String(dispatch.tarea).toLowerCase().trim()}`;
}

// Reject-once with motivo → re-plan (changes dueño or redefines) → dispatch
// intento+1. Second rejection of the same key → throws RECHAZO_AGOTADO.
export function aplicarRechazo(job, dispatch, motivo, { nuevoDueño = null, nuevaTarea = null } = {}) {
  if (!motivo || !String(motivo).trim()) throw new Error('El rechazo requiere motivo');
  const clave = claveRechazo(dispatch);
  const veces = (job.rechazos.get(clave) || 0) + 1;
  if (veces > 1) {
    const err = new Error(`RECHAZO_AGOTADO: ${dispatch.para} ya rechazó "${dispatch.tarea}" una vez; el re-dispatch es firme`);
    err.code = 'RECHAZO_AGOTADO';
    throw err;
  }
  job.rechazos.set(clave, veces);
  dispatch.estado = 'rechazado';
  dispatch.motivoRechazo = String(motivo).slice(0, 500);

  const fase = job.plan.fases.find((f) => f.n === dispatch.fase);
  if (nuevoDueño && fase) {
    fase.dueño = String(nuevoDueño);
  }
  const nuevo = assertDispatch({
    ...dispatch,
    taskId: `t-${nanoid(6)}`,
    para: nuevoDueño || dispatch.para,
    tarea: nuevaTarea || dispatch.tarea,
    intento: (dispatch.intento || 1) + 1,
    estado: 'pendiente'
  });
  delete nuevo.motivoRechazo;
  job.dispatches.set(nuevo.taskId, nuevo);
  return { plan: job.plan, dispatch: nuevo, dispatchRechazado: dispatch };
}

// ── Tester return → re-dispatch (loop with max rounds) ────────────

export function aplicarDevolucion(job, devolucion, { maxRondas = MAX_RONDAS_DEFAULT } = {}) {
  assertDevolucion(devolucion);
  if (devolucion.jobId !== job.id) throw new Error(`Devolución de ${devolucion.jobId} no corresponde al job ${job.id}`);
  const ronda = Number(devolucion.ronda) || 1;

  if (ronda >= maxRondas) {
    job.estado = 'escalado';
    job.escalado = {
      ronda,
      motivo: `máx rondas (${maxRondas}) alcanzado con ${devolucion.items.length} item(s) pendiente(s): decide Pablo/Tito`,
      items: devolucion.items
    };
    return { estado: 'escalado', escalado: job.escalado, redispatches: [] };
  }

  job.ronda = ronda + 1;
  job.estado = 'rework';
  const redispatches = [];
  for (const item of devolucion.items) {
    const original = devolucion.taskId ? job.dispatches.get(devolucion.taskId) : null;
    const red = assertDispatch({
      taskId: `t-${nanoid(6)}`,
      jobId: job.id,
      fase: original?.fase || 1,
      para: original?.para || 'orquestador',
      tarea: `[${item.severidad}] ${item.descripcion}`.slice(0, 500),
      doneCriteria: original?.doneCriteria || 'corregir lo observado y re-entregar',
      coordinarCon: [],
      intento: (original?.intento || 1) + 1,
      estado: 'pendiente'
    });
    red.origen = { taskId: original?.taskId || null, ronda, persona: item.persona || null };
    job.dispatches.set(red.taskId, red);
    redispatches.push(red);
  }
  return { estado: 'rework', ronda: job.ronda, redispatches };
}

// ── Group-call voice: each event produces the owner's turn ────────────────────
// Events: plan_listo, dispatch, entrega, devolucion, aprobado.
// Returns { speaker, texto } or null when the event has no voice.

export const VOCES_EVENTO = {
  plan_listo: 'Orquestador',
  dispatch: 'Orquestador',
  entrega: 'especialista',
  devolucion: 'Tester',
  aprobado: 'Pablo'
};

export function voicePayload(evento) {
  if (!evento || typeof evento !== 'object') return null;
  const tipo = evento.tipo;
  if (!VOCES_EVENTO[tipo]) return null;

  switch (tipo) {
    case 'plan_listo': {
      const n = Number(evento.fases) || 0;
      return {
        speaker: VOCES_EVENTO.plan_listo,
        texto: `Plan listo: ${n} fase${n === 1 ? '' : 's'}${evento.researchUsado ? ', con pre-hecho aprovechado' : ''}. ${String(evento.resumen || '').slice(0, 200)}`.trim()
      };
    }
    case 'dispatch': {
      return {
        speaker: evento.speaker || VOCES_EVENTO.dispatch,
        texto: `${String(evento.para || 'equipo')}, te toca: ${String(evento.tarea || '').slice(0, 200)}. Criterio: ${String(evento.doneCriteria || '').slice(0, 200)}`.trim()
      };
    }
    case 'entrega': {
      return {
        speaker: String(evento.de || 'Especialista'),
        texto: `Entregué: ${String(evento.resumen || evento.tarea || '').slice(0, 220)}${evento.taskId ? '' : ''}`.trim()
      };
    }
    case 'devolucion': {
      const n = Number(evento.items) || (Array.isArray(evento.detalle) ? evento.detalle.length : 0);
      return {
        speaker: VOCES_EVENTO.devolucion,
        texto: `Probé como ${String(evento.persona || 'usuario').slice(0, 60)} y encontré ${n} cosa${n === 1 ? '' : 's'}: ${String(evento.resumen || '').slice(0, 200)}. Vuelve a trabajo, ronda ${Number(evento.ronda) || 1}.`.trim()
      };
    }
    case 'aprobado': {
      return {
        speaker: VOCES_EVENTO.aprobado,
        texto: `Aprobado: ${String(evento.resumen || 'el Tester dio el visto bueno').slice(0, 220)}${evento.limitaciones ? ` Ojo: ${String(evento.limitaciones).slice(0, 160)}` : ''}`.trim()
      };
    }
    default:
      return null;
  }
}

// ── Orchestrator class ──────────────────────────────────────────────────
// In-memory state per job. Injected deps: fetchUrl (research),
// requestSpawn (track B by protocol), announce (voice on live call),
// store (optional: mirror into existing tasks).

export class Orchestrator {
  constructor({ fetchUrl = null, requestSpawn = null, announce = null, store = null, now = null, maxRondas = MAX_RONDAS_DEFAULT } = {}) {
    this.fetchUrl = fetchUrl;
    this.requestSpawn = requestSpawn;
    this.announce = typeof announce === 'function' ? announce : null;
    this.store = store;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.maxRondas = maxRondas;
    this.jobs = new Map();
  }

  anunciar(evento) {
    if (!this.announce) return null;
    const payload = voicePayload(evento);
    if (!payload) return null;
    try {
      this.announce(payload);
    } catch {
      // Voice never breaks the flow: if the call dropped, continue muted.
    }
    return payload;
  }

  // Brief intake (Pablo): incomplete → preguntas; complete → job created
  // (no plan yet: the plan is proposed by the LLM and enters via planificar).
  intake(brief) {
    const preguntas = preguntasFaltantes(brief);
    if (preguntas.length > 0) {
      return { estado: 'preguntas', preguntas };
    }
    assertBrief(brief);
    const job = {
      id: `job-${nanoid(6)}`,
      brief: { ...brief },
      plan: null,
      dispatches: new Map(),
      rechazos: new Map(),
      ronda: 0,
      estado: 'brief_ok',
      creadoEn: this.now()
    };
    this.jobs.set(job.id, job);
    return { estado: 'brief_ok', job };
  }

  // Meticulous plan + appended pre-built research. When a phase lacks a role
  // (para='FALTA:<rol>'), ask the Spawner by protocol before the plan.
  async planificar(jobId, fases, { research = true } = {}) {
    const job = this.jobOrThrow(jobId);
    let plan = crearPlan(job.brief, { jobId: job.id, fases });

    const faltantes = plan.fases
      .map((f) => f.dueño)
      .filter((d) => /^FALTA:/i.test(d))
      .map((d) => d.replace(/^FALTA:/i, '').trim())
      .filter(Boolean);
    for (const rol of [...new Set(faltantes)]) {
      const res = await this.pedirRol(job, rol);
      const nombre = res?.agente?.nombre || res?.existente?.nombre || rol;
      for (const f of plan.fases) {
        if (f.dueño.toLowerCase() === `falta:${rol.toLowerCase()}`) {
          f.dueño = res?.ok ? nombre : `SIN_DUEÑO:${rol}`;
        }
      }
    }
    plan = assertPlan(plan);

    if (research) {
      const queries = researchQueries(job.brief, plan);
      const resultados = await runResearch(queries, { fetchUrl: this.fetchUrl });
      plan = anexarResearch(plan, resultados);
    }

    job.plan = plan;
    job.estado = 'planificado';
    this.anunciar({
      tipo: 'plan_listo',
      fases: plan.fases.length,
      researchUsado: plan.research.some((r) => r.decision !== 'se construye desde cero' && r.hallazgo !== 'sin pre-hecho usable encontrado'),
      resumen: plan.fases.map((f) => f.titulo).join(' → ').slice(0, 200)
    });
    return job;
  }

  // Spawn by PROTOCOL (no direct import): signature agreed with track B.
  // requestSpawn(req) -> { ok, agente?|existente?, motivo? }.
  async pedirRol(job, rolFaltante, capabilities = []) {
    const req = assertSpawnRequest({
      jobId: job.id,
      rolFaltante,
      porQue: `fase del plan sin dueño: hace falta ${rolFaltante}`,
      capabilities: capabilities.length > 0 ? capabilities : ['workspace-read', 'workspace-write', 'web', 'memoria']
    });
    if (typeof this.requestSpawn !== 'function') {
      return { ok: false, motivo: 'sin Spawner cableado (track B / main lo inyecta)' };
    }
    try {
      return await this.requestSpawn(req);
    } catch (error) {
      return { ok: false, motivo: String(error?.message || error).slice(0, 200) };
    }
  }

  // Dispatch of one phase to one dueño (existing or freshly spawned).
  dispatchFase(jobId, faseN, opts = {}) {
    const job = this.jobOrThrow(jobId);
    if (!job.plan) throw new Error(`Job ${jobId} sin plan: primero planificar()`);
    const dispatch = hacerDispatch(job.plan, faseN, opts);
    dispatch.estado = 'en_curso';
    job.dispatches.set(dispatch.taskId, dispatch);
    if (job.estado === 'planificado') job.estado = 'en_curso';
    this.anunciar({ tipo: 'dispatch', para: dispatch.para, tarea: dispatch.tarea, doneCriteria: dispatch.doneCriteria });
    return dispatch;
  }

  rechazar(jobId, taskId, motivo, opts = {}) {
    const job = this.jobOrThrow(jobId);
    const dispatch = job.dispatches.get(taskId);
    if (!dispatch) throw new Error(`Dispatch ${taskId} desconocido en ${jobId}`);
    return aplicarRechazo(job, dispatch, motivo, opts);
  }

  entregar(jobId, taskId, resumen) {
    const job = this.jobOrThrow(jobId);
    const dispatch = job.dispatches.get(taskId);
    if (!dispatch) throw new Error(`Dispatch ${taskId} desconocido en ${jobId}`);
    dispatch.estado = 'entregado';
    dispatch.entrega = { resumen: String(resumen || '').slice(0, 500), en: this.now() };
    this.anunciar({ tipo: 'entrega', de: dispatch.para, resumen: dispatch.entrega.resumen, tarea: dispatch.tarea });
    return dispatch;
  }

  devolver(jobId, devolucion) {
    const job = this.jobOrThrow(jobId);
    const resultado = aplicarDevolucion(job, devolucion, { maxRondas: this.maxRondas });
    if (resultado.estado === 'rework') {
      const primero = devolucion.items[0] || {};
      this.anunciar({
        tipo: 'devolucion',
        items: devolucion.items.length,
        persona: primero.persona || 'usuario',
        resumen: primero.descripcion || '',
        ronda: job.ronda
      });
    }
    return resultado;
  }

  aprobar(jobId, aprobacion) {
    const job = this.jobOrThrow(jobId);
    if (aprobacion.jobId !== job.id) throw new Error(`Aprobación de ${aprobacion.jobId} no corresponde al job ${job.id}`);
    job.estado = 'aprobado';
    job.aprobacion = { ...aprobacion };
    this.anunciar({
      tipo: 'aprobado',
      resumen: `${(aprobacion.probado || []).length} persona(s) × dimensiones probadas, ${(aprobacion.arreglado || []).length} arreglo(s)`,
      limitaciones: (aprobacion.limitaciones || []).join('; ')
    });
    return job;
  }

  estado(jobId) {
    const job = this.jobOrThrow(jobId);
    return {
      id: job.id,
      estado: job.estado,
      ronda: job.ronda,
      fases: job.plan?.fases?.length || 0,
      dispatches: [...job.dispatches.values()].map((d) => ({
        taskId: d.taskId, fase: d.fase, para: d.para, tarea: d.tarea,
        intento: d.intento, estado: d.estado
      })),
      escalado: job.escalado || null
    };
  }

  jobOrThrow(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} desconocido`);
    return job;
  }
}
