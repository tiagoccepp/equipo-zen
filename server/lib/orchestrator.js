// ── Orquestador: brief → plan → research → dispatch → tracking → replan ──
// Track A. El Orquestador planifica meticuloso, investiga pre-hecho PRIMERO,
// reparte a especialistas, pide roles al Spawner por protocolo y re-dispatcha
// ante devoluciones del Tester (loop con máx rondas).
//
// Aislamiento: importa SOLO team-protocol.js (+ nanoid). El Spawner, el
// fetch web, la voz y el store entran por DEPS INYECTADAS en el constructor:
// jamás imports directos (el Spawner es track B, la llamada es main).
//
// Estado: memoria (Map por jobId). Cada dispatch se puede reflejar en la
// tabla tasks existente si main pasa `store` (ver flujo-orquestador-plan.md:
// tabla nueva NO — tasks/goals/task_comments ya modelan el tracking).

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

// ── Intake: preguntas cuando falta info (Pablo-interfaz pide, no inventa) ──

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

// Las fases las propone el LLM del Orquestador (prompt, lo cablea main) o
// main a mano; acá se ordenan, numeran y VALIDAN (contrato plan).
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

// Orden de ejecución: verifica el DAG (dependeDe solo a anteriores ya lo
// garantiza el contrato; esto lo recorre en orden seguro de todos modos).
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

// ── Research: pre-hecho primero (open source, libs, diseños) ─────────────

const STOPWORDS = new Set([
  'una', 'uno', 'para', 'con', 'que', 'los', 'las', 'del', 'por', 'una',
  'the', 'and', 'for', 'with', 'quiero', 'hacer', 'esto', 'esta', 'este'
]);

// Queries derivadas del objetivo + títulos de fases. Pura (testeable).
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

// Ejecuta queries con fetchUrl INYECTADO (main pasa manos fetch_url o
// web_search). Nunca lanza: cada fallo queda como hallazgo { error }.
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

// Anexa el research al plan: qué pre-hecho se usa y por qué (o nada usable).
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

// ── Dispatch + rechazo-1-vez + replan ───────────────────────────────────

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

// Clave de rechazo: mismo dueño + misma tarea (normalizada).
export function claveRechazo(dispatch) {
  return `${String(dispatch.para).toLowerCase()}::${String(dispatch.tarea).toLowerCase().trim()}`;
}

// Rechazo-1-vez con motivo → re-plan (cambia dueño o redefine) → dispatch
// intento+1. Segundo rechazo de la misma clave → lanza RECHAZO_AGOTADO.
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

// ── Devolución del Tester → re-dispatch (loop con máx rondas) ────────────

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

// ── Voz en grupal: cada evento genera turno del dueño ────────────────────
// Eventos: plan_listo, dispatch, entrega, devolucion, aprobado.
// Devuelve { speaker, texto } o null si el evento no tiene voz.

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

// ── Clase Orchestrator ──────────────────────────────────────────────────
// Estado en memoria por job. Deps inyectadas: fetchUrl (research),
// requestSpawn (track B por protocolo), announce (voz en llamada viva),
// store (opcional: reflejo en tasks existentes).

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
      // La voz nunca rompe el flujo: si la llamada se cayó, se sigue mudo.
    }
    return payload;
  }

  // Intake de brief (Pablo): incompleto → preguntas; completo → job creado
  // (sin plan todavía: el plan lo propone el LLM y entra por planificar).
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

  // Plan meticuloso + research de pre-hecho anexado. Si falta rol para una
  // fase (para='FALTA:<rol>'), pide al Spawner por protocolo antes del plan.
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

  // Spawn por PROTOCOLO (no import directo): firma acordada con track B.
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

  // Dispatch de una fase a un dueño (existente o recién spawneado).
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
