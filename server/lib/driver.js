// ── Driver autónomo del flujo de equipo ("Pablo, haceme X" → corre solo) ──
// Ante un brief, mueve el loop de punta a punta: intake → plan+research →
// spawn por protocolo → dispatches secuenciales → peer review → tester →
// rework loop → learnings. Todo paso se anuncia vía session.announceTeamEvent
// (audible en la llamada viva) y queda en el registry para GET /api/team/jobs.
//
// Aislamiento: este archivo es el ÚNICO que el track driver posee. Importa
// (sin editar) orchestrator / team-protocol (adaptadores) / spawner REAL /
// critic / tester / learning / manos (fetch_url default). Sin companySlug →
// el spawner no escribe nada.
//
// Sesión: http.js no ve la sesión viva y meeting-session.js es no-tocar, así
// que main cablea la sesión con setDefaultSession() al integrarse. En tests
// se pasa session fake directo a runJob (cero modelo, cero disco salvo tmp).
//
// Decisiones finas: /home/tito/research/flujo-driver-plan.md (addendum A1-A8).

import { access } from 'node:fs/promises';

import {
  MAX_RONDAS_DEFAULT,
  ordenEjecucion,
  Orchestrator
} from './orchestrator.js';
import {
  adaptarSpawnResponse,
  aprobacionDesdeTester,
  devolucionDesdeTester,
  spawnRequestPara
} from './team-protocol.js';
import { spawnRequest } from './spawner.js';
import { CHECKLISTS_ROL, revisar } from './critic.js';
import { juzgar, PERSONAS_POR_TIPO, planDePrueba } from './tester.js';
import { contextoPrevio, registrarLearningsDeLaburo } from './learning.js';
import { getTool } from './manos.js';

export const JOB_TIMEOUT_MS_DEFAULT = 20 * 60 * 1000;
export const TURN_TIMEOUT_MS_DEFAULT = 120000;
const MAX_ANUNCIOS = 20;
const RESUMEN_CHARS = 300;

// ── Registry en memoria + provider de sesión ───────────────────────────

const registry = new Map(); // id → entry interna (ver prepareJob)
let defaultSession = null;
let defaultJobOpts = {};

export function setDefaultSession(session) {
  defaultSession = session || null;
}

export function getDefaultSession() {
  return defaultSession;
}

// Main puede inyectar deps globales (ej: { fetchUrl } con buscador real)
// sin tocar este archivo ni las rutas.
export function setDefaultJobOpts(opts = {}) {
  defaultJobOpts = { ...defaultJobOpts, ...(opts || {}) };
}

export function __resetRegistry() {
  registry.clear();
}

// Solo tests: entry interna (para verificar origen mecanico|turno, etc).
export function __getEntry(id) {
  return registry.get(id) || null;
}

// Vista públicamente segura: resumida, sin prompts internos ni textos gigantes.
export function getJob(id) {
  const e = registry.get(id);
  if (!e) return null;
  return {
    id: e.id,
    estado: e.estado,
    motivo: e.motivo || null,
    progreso: {
      ...e.progreso,
      anuncios: [...e.anuncios].slice(-MAX_ANUNCIOS)
    },
    resumen: {
      objetivo: e.objetivo,
      fases: e.progreso.fasesTotal,
      entregas: e.entregas.map((x) => ({
        fase: x.fase,
        para: x.para,
        resumen: String(x.resumen || '').slice(0, RESUMEN_CHARS),
        rework: !!x.rework
      })),
      tests: { ...e.progreso.tests },
      rondas: e.progreso.ronda,
      preguntas: e.preguntas ? [...e.preguntas] : null,
      escalado: e.escalado || null
    }
  };
}

export function listJobs() {
  return [...registry.values()].map((e) => ({
    id: e.id,
    estado: e.estado,
    objetivo: e.objetivo,
    actualizadoEn: e.progreso.actualizadoEn
  }));
}

// ── Helpers puros ──────────────────────────────────────────────────────

function trunc(s, n = RESUMEN_CHARS) {
  return String(s || '').slice(0, n);
}

function equipoDeSession(session) {
  const fuentes = [session?.sessionAgents, session?.roster];
  for (const f of fuentes) {
    if (Array.isArray(f) && f.length > 0) {
      return f.map((m) => ({
        id: String(m.id || m.agentId || ''),
        role: String(m.role || m.rol || 'worker'),
        name: String(m.name || m.nombre || m.id || '')
      })).filter((m) => m.id);
    }
  }
  if (session?.agents instanceof Map && session.agents.size > 0) {
    const out = [];
    for (const [id, runtime] of session.agents) {
      const a = runtime?.agent || {};
      out.push({
        id: String(a.id || id),
        role: String(a.role || 'worker'),
        name: String(a.name || a.id || id)
      });
    }
    return out;
  }
  return [];
}

// dueño (rol|nombre|id, viene de la fase o del spawn) → miembro del equipo.
function resolverMiembro(dueno, equipo) {
  const d = String(dueno || '').trim().toLowerCase();
  if (!d) return null;
  return equipo.find((m) => m.role.toLowerCase() === d)
    || equipo.find((m) => m.id.toLowerCase() === d)
    || equipo.find((m) => m.name.toLowerCase() === d)
    || null;
}

// Ejecutor cuando el dueño no tiene runtime en la llamada (rol spawneado
// sin runtime, tester ausente, etc). Se anuncia explícitamente (A3).
function ejecutorFallback(equipo) {
  return equipo.find((m) => m.role.toLowerCase() === 'orquestador')
    || equipo.find((m) => m.role.toLowerCase() === 'pablo')
    || equipo[0]
    || null;
}

function rolRevisor(dueno, equipo) {
  const d = String(dueno || '').toLowerCase();
  const par = equipo.map((m) => m.role.toLowerCase()).find((r) => r !== d && CHECKLISTS_ROL[r]);
  if (par) return par;
  if (CHECKLISTS_ROL[d]) return d;
  return 'backend';
}

function descPersona(personaId, tipo) {
  const lista = PERSONAS_POR_TIPO[tipo] || PERSONAS_POR_TIPO.generico || [];
  return lista.find((p) => p.id === personaId)?.desc || personaId;
}

const DESC_DIM = {
  visual: 'qué se ve',
  funcional: 'flujos + criterios del brief',
  destructivo: 'romper a propósito',
  bordes: 'casos límite'
};

function productoDeBrief(brief) {
  const p = brief?.producto && typeof brief.producto === 'object' ? brief.producto : {};
  const fmt = String(brief?.formatoEntrega || '').toLowerCase();
  let tipo = p.tipo;
  if (!tipo) {
    if (/web|landing|sitio|página|pagina|html/.test(fmt)) tipo = 'web';
    else if (/cv|currículum|curriculum|resume/.test(fmt)) tipo = 'cv';
    else if (/app|móvil|movil|mobile/.test(fmt)) tipo = 'app';
    else tipo = 'generico';
  }
  const producto = {
    tipo,
    descripcion: p.descripcion || brief?.objetivo || '',
    brief: { criteriosExito: brief?.criteriosExito || [] }
  };
  if (p.url) producto.url = p.url;
  if (p.path) producto.path = p.path;
  return producto;
}

// fetchUrl default: tool fetch_url de manos. Solo resuelve URLs http(s);
// las queries de research (texto libre) devuelven vacío honesto hasta que
// main inyecte un buscador real (A7). Nunca lanza en la construcción.
function fetchUrlDefault() {
  let tool = null;
  try {
    tool = getTool('fetch_url');
  } catch {
    return null;
  }
  if (!tool || typeof tool.execute !== 'function') return null;
  return async (input) => {
    const s = String(input || '').trim();
    if (!/^https?:\/\//i.test(s)) return '';
    const r = await tool.execute({ url: s });
    if (!r || r.ok === false) throw new Error(r?.error || `fetch ${s} falló`);
    return String(r.output || '');
  };
}

// ── Anuncios (voz + registry) ────────────────────────────────────────────

function decir(prep, evento, textoLog) {
  const { entry, session } = prep;
  try {
    session?.announceTeamEvent?.(evento);
  } catch {
    // La voz nunca rompe el flujo.
  }
  entry.anuncios.push({ at: new Date().toISOString(), texto: trunc(textoLog || evento?.tipo || '', 500) });
  if (entry.anuncios.length > MAX_ANUNCIOS * 2) {
    entry.anuncios.splice(0, entry.anuncios.length - MAX_ANUNCIOS * 2);
  }
  entry.progreso.actualizadoEn = Date.now();
}

function setFase(prep, fase) {
  prep.entry.fase = fase;
  prep.entry.progreso.fase = fase;
  prep.entry.progreso.actualizadoEn = Date.now();
}

// ── Prepare (síncrono: intake ya, para que POST devuelva jobId real) ─────

function prepareJob(session, brief, opts = {}) {
  const merged = { ...defaultJobOpts, ...(opts || {}) };
  const turnTimeoutMs = Number(merged.turnTimeoutMs) > 0 ? Number(merged.turnTimeoutMs) : TURN_TIMEOUT_MS_DEFAULT;
  const jobTimeoutMs = Number(merged.timeoutMs) > 0 ? Number(merged.timeoutMs) : JOB_TIMEOUT_MS_DEFAULT;
  const maxRondas = Number(merged.maxRondas) > 0 ? Number(merged.maxRondas) : MAX_RONDAS_DEFAULT;
  const equipo = equipoDeSession(session);
  const store = session?.store || null;
  const fetchUrl = typeof merged.fetchUrl === 'function' ? merged.fetchUrl : fetchUrlDefault();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

  // requestSpawn por protocolo contra el spawner REAL, sin companySlug
  // (cero writes: sin ficha en disco, sin daily).
  const equipoSpawn = equipo.map((m) => ({ id: m.id, role: m.role }));
  const requestSpawn = async (req) => {
    const pedido = spawnRequestPara(req);
    const res = spawnRequest(pedido, { equipo: equipoSpawn });
    return adaptarSpawnResponse(res, equipo);
  };

  // Sin announce inyectado: el orquestador es máquina de estado pura y el
  // driver anuncia TODO vía session.announceTeamEvent (A-voz).
  const orc = new Orchestrator({ fetchUrl, requestSpawn, maxRondas });
  const intake = orc.intake(brief || {});
  const job = intake.job || null;
  const entry = {
    id: job?.id || `job-${Date.now().toString(36)}`,
    estado: intake.estado === 'preguntas' ? 'preguntas' : 'brief_ok',
    motivo: null,
    fase: intake.estado === 'preguntas' ? 'preguntas' : 'intake',
    objetivo: trunc(brief?.objetivo || '', 200),
    preguntas: intake.estado === 'preguntas' ? [...intake.preguntas] : null,
    progreso: {
      estado: intake.estado === 'preguntas' ? 'preguntas' : 'brief_ok',
      fase: intake.estado === 'preguntas' ? 'preguntas' : 'intake',
      fasesTotal: 0,
      fasesCompletadas: 0,
      ronda: 0,
      maxRondas,
      dispatches: { total: 0, entregados: 0 },
      tests: { celdas: 0, pasadas: 0, fallidas: 0, mecanicas: 0, turnos: 0 },
      actualizadoEn: Date.now()
    },
    anuncios: [],
    entregas: [],
    testResultados: [],
    escalado: null,
    dead: false,
    briefClon: brief && typeof brief === 'object' ? { ...brief } : {}
  };
  if (job) {
    // El registry usa el id del orquestador como id único del job.
    entry.id = job.id;
  }
  registry.set(entry.id, entry);
  const prep = {
    entry, orc, job, session, equipo, store, fetchUrl,
    controller, turnTimeoutMs, jobTimeoutMs, maxRondas,
    preguntas: intake.estado === 'preguntas'
  };
  if (prep.preguntas) {
    decir(prep, { tipo: 'preguntas', preguntas: entry.preguntas },
      `Intake: faltan datos — ${entry.preguntas.length} pregunta(s). Pablo las habla con Tito.`);
  }
  return prep;
}

function checkVivo(prep) {
  if (prep.entry.dead) {
    const err = new Error('job cancelado (timeout)');
    err.code = 'JOB_MUERTO';
    throw err;
  }
}

function markFallo(prep, error) {
  const terminales = ['aprobado', 'escalado', 'fallo'];
  if (terminales.includes(prep.entry.estado)) return prep.entry;
  prep.entry.estado = 'fallo';
  prep.entry.motivo = trunc(error?.message || String(error), 300);
  prep.entry.progreso.estado = 'fallo';
  setFase(prep, 'fallo');
  decir(prep, { tipo: 'fallo', motivo: prep.entry.motivo }, `FALLO: ${prep.entry.motivo}`);
  return prep.entry;
}

// ── Fases: brief.fases → planning turn → fallback (A1) ───────────────────

function fasesValidas(lista) {
  if (!Array.isArray(lista) || lista.length === 0) return null;
  const out = [];
  for (const f of lista) {
    const titulo = String(f?.titulo || '').trim();
    const dueno = String(f?.dueño ?? f?.dueno ?? '').trim();
    const doneCriteria = String(f?.doneCriteria || '').trim();
    if (!titulo || !dueno || !doneCriteria) return null;
    out.push({
      titulo: titulo.slice(0, 300),
      dueño: dueno.slice(0, 80),
      doneCriteria: doneCriteria.slice(0, 500),
      dependeDe: Array.isArray(f?.dependeDe) ? f.dependeDe.filter((d) => Number.isInteger(d) && d >= 1) : []
    });
  }
  return out;
}

function parsearFasesPlanning(texto) {
  const raw = String(texto || '');
  const candidatos = [];
  const code = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (code) candidatos.push(code[1]);
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) candidatos.push(arr[0]);
  candidatos.push(raw);
  for (const c of candidatos) {
    try {
      const parsed = JSON.parse(c.trim());
      const validas = fasesValidas(parsed);
      if (validas) return validas;
    } catch {
      // Siguiente candidato.
    }
  }
  return null;
}

async function resolverFases(prep, brief) {
  const directas = fasesValidas(brief?.fases);
  if (directas) return { fases: directas, origen: 'brief' };

  const planner = ejecutorFallback(prep.equipo);
  if (!planner) throw new Error('sin roster: no hay agentes para planificar ni ejecutar');
  const roles = [...new Set(prep.equipo.map((m) => m.role))].join(', ');
  const prompt = [
    'Sos el ORQUESTADOR del equipo. Armá el plan de fases para este laburo.',
    '',
    'BRIEF:',
    `objetivo: ${brief?.objetivo || ''}`,
    `contexto: ${brief?.contexto || ''}`,
    `restricciones: ${(brief?.restricciones || []).join('; ')}`,
    `criterios de éxito: ${(brief?.criteriosExito || []).join('; ')}`,
    `formato de entrega: ${brief?.formatoEntrega || ''}`,
    `ROLES DISPONIBLES EN EL EQUIPO: ${roles}`,
    'Si necesitás un rol que NO está, poné dueño "FALTA:<rol>" (ej: "FALTA:diseño").',
    '',
    'Respondé SOLO con un JSON array (sin markdown ni explicación):',
    '[{"titulo":"...","dueño":"<rol>","doneCriteria":"<medible>","dependeDe":[<n>]}, ...]',
    'REGLAS: fases en orden; dependeDe solo a números de fase anteriores; dueño en minúsculas.'
  ].join('\n');
  const res = await prep.session.runAgentJobTurn(planner.id, prompt, {
    timeoutMs: prep.turnTimeoutMs,
    signal: prep.controller?.signal
  });
  checkVivo(prep);
  const fases = parsearFasesPlanning(res?.text);
  if (fases) return { fases, origen: 'planning-turn' };

  const dueno = planner.role || 'worker';
  return {
    fases: [{
      titulo: trunc(brief?.objetivo || 'laburo', 300),
      dueño: dueno,
      doneCriteria: trunc((brief?.criteriosExito || ['cumplir el objetivo del brief'])[0], 500),
      dependeDe: []
    }],
    origen: 'fallback'
  };
}

// ── Turnos ───────────────────────────────────────────────────────────────

async function correrTurno(prep, agentId, prompt) {
  const res = await prep.session.runAgentJobTurn(agentId, prompt, {
    timeoutMs: prep.turnTimeoutMs,
    signal: prep.controller?.signal
  });
  checkVivo(prep);
  return res;
}

// dueño (de fase o re-dispatch) → { miembro ejecutor, notaFallback? }.
function resolverEjecutor(prep, dueno) {
  const directo = resolverMiembro(dueno, prep.equipo);
  if (directo) return { miembro: directo, nota: null };
  const fb = ejecutorFallback(prep.equipo);
  if (!fb) throw new Error(`sin ejecutor para "${dueno}": roster vacío`);
  return {
    miembro: fb,
    nota: `${dueno} no tiene runtime en la llamada, lo ejecuta ${fb.name || fb.id} (${fb.role})`
  };
}

function contextoEntregasPrevias(prep, hastaFaseN = Infinity) {
  const previas = prep.entry.entregas.filter((e) => e.fase < hastaFaseN);
  if (previas.length === 0) return '';
  return [
    'CONTEXTO DE FASES ANTERIORES (entregas de las que dependés):',
    ...previas.map((e) => `- fase ${e.fase} (${e.para}): ${trunc(e.resumen, 500)}`)
  ].join('\n');
}

function promptDispatch(prep, jobId, fase, total, dispatch) {
  const partes = [
    `[laburo ${jobId} · fase ${fase.n}/${total}: ${fase.titulo}]`,
    `TAREA: ${dispatch.tarea}`,
    `CRITERIO DE DONE: ${dispatch.doneCriteria}`
  ];
  const plan = prep.job?.plan;
  if (plan?.research?.length) {
    partes.push('RESEARCH (pre-hecho, úsalo si sirve):');
    for (const r of plan.research.slice(0, 3)) {
      partes.push(`- ${trunc(r.hallazgo, 200)} — decisión: ${trunc(r.decision, 120)}`);
    }
  }
  const ctx = contextoPrevio(prep.store, dispatch.para, `${fase.titulo} ${prep.entry.objetivo}`);
  if (ctx) partes.push(ctx);
  const prev = contextoEntregasPrevias(prep, fase.n);
  if (prev) partes.push(prev);
  partes.push('Entregá tu parte completa y concreta. Si algo del brief te bloquea, decilo explícito al inicio.');
  return partes.join('\n\n');
}

// ── Checks mecánicos directos (A5): sin turno, origen 'mecanico' ─────────

async function checksMecanicos(prep, producto) {
  const out = [];
  if (producto.url) {
    const titulo = `url-responde: ${producto.url}`;
    try {
      if (typeof prep.fetchUrl !== 'function') throw new Error('sin fetchUrl: URL no verificable');
      const texto = await prep.fetchUrl(producto.url);
      if (String(texto || '').trim()) {
        out.push({ persona: 'mecanico', dimension: 'funcional', estado: 'pass', titulo, origen: 'mecanico' });
      } else {
        out.push({
          persona: 'mecanico', dimension: 'funcional', estado: 'fail', titulo,
          observado: 'respuesta vacía', pasosRepro: [`GET ${producto.url}`], origen: 'mecanico'
        });
      }
    } catch (error) {
      out.push({
        persona: 'mecanico', dimension: 'funcional', estado: 'fail', titulo,
        observado: trunc(error?.message || String(error), 200),
        pasosRepro: [`GET ${producto.url}`], origen: 'mecanico'
      });
    }
    checkVivo(prep);
  }
  if (producto.path) {
    const titulo = `archivo-existe: ${producto.path}`;
    try {
      await access(producto.path);
      out.push({ persona: 'mecanico', dimension: 'funcional', estado: 'pass', titulo, origen: 'mecanico' });
    } catch {
      out.push({
        persona: 'mecanico', dimension: 'funcional', estado: 'fail', titulo,
        observado: 'no existe o inaccesible', pasosRepro: [`verificar ${producto.path}`], origen: 'mecanico'
      });
    }
    checkVivo(prep);
  }
  return out;
}

// ── Veredicto tester ─────────────────────────────────────────────────────

const VEREDICTO_RE = /VEREDICTO:\s*(PASS|FAIL)\b\s*[—–-]?\s*([\s\S]*)/i;

function parsearVeredicto(texto) {
  const m = String(texto || '').match(VEREDICTO_RE);
  if (!m) {
    return {
      estado: 'fail',
      observado: `veredicto ambiguo (sin línea VEREDICTO): ${trunc(texto, 200)}`,
      pasosRepro: ['releer el turno tester y exigir VEREDICTO explícito']
    };
  }
  if (m[1].toUpperCase() === 'PASS') return { estado: 'pass' };
  const resto = (m[2] || '').trim();
  const [obs, pasos] = resto.split(/\|\s*PASOS:\s*/i);
  return {
    estado: 'fail',
    observado: trunc(obs, 500) || 'FAIL sin detalle',
    pasosRepro: pasos
      ? pasos.split(/;|→|\n/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
      : ['ver turno tester']
  };
}

function promptTesterCelda(prep, producto, celda) {
  const checks = celda.checks.map((c, i) =>
    `${i + 1}) Pasos: ${c.pasos.join(' → ')} | Mirar: ${c.mirar} | Pass si: ${c.pass}`
  ).join('\n');
  const partes = [
    `Sos el TESTER del equipo actuando como persona "${celda.persona}" (${descPersona(celda.persona, producto.tipo)}) — dimensión: ${celda.dimension} (${DESC_DIM[celda.dimension] || celda.dimension}).`,
    `PRODUCTO: ${producto.tipo} — ${trunc(producto.descripcion, 300)}`
  ];
  if (producto.url) partes.push(`URL: ${producto.url}`);
  if (producto.path) partes.push(`PATH: ${producto.path}`);
  partes.push('ENTREGAS DEL EQUIPO (resumen):');
  for (const e of prep.entry.entregas.slice(-6)) {
    partes.push(`- fase ${e.fase} (${e.para}): ${trunc(e.resumen, 400)}`);
  }
  partes.push(
    `CELDA ${celda.id}: ejecutá CADA check con tus herramientas (navegador, fetch, archivos — verificá de verdad, no adivines):\n${checks}`,
    'Cerrá con EXACTAMENTE una de estas líneas (nada después):\nVEREDICTO: PASS — <evidencia en 1 línea>\nVEREDICTO: FAIL — <qué observaste> | PASOS: <paso1 → paso2 → ...>'
  );
  return partes.join('\n\n');
}

// ── Ejecución ────────────────────────────────────────────────────────────

async function ejecutarDispatches(prep) {
  const orden = ordenEjecucion(prep.job.plan);
  prep.entry.progreso.fasesTotal = orden.length;
  prep.entry.progreso.dispatches.total = orden.length;
  setFase(prep, 'dispatch');

  for (const fase of orden) {
    checkVivo(prep);
    const dispatch = prep.orc.dispatchFase(prep.job.id, fase.n);
    const { miembro, nota } = resolverEjecutor(prep, dispatch.para);
    decir(prep,
      { tipo: 'dispatch', para: dispatch.para, tarea: dispatch.tarea, doneCriteria: dispatch.doneCriteria },
      `Dispatch fase ${fase.n}/${orden.length} → ${dispatch.para}: ${trunc(dispatch.tarea, 160)}${nota ? ` [${nota}]` : ''}`);
    if (nota) {
      prep.entry.progreso.actualizadoEn = Date.now();
    }
    const res = await correrTurno(prep, miembro.id, promptDispatch(prep, prep.job.id, fase, orden.length, dispatch));
    const texto = String(res?.text || '');
    prep.orc.entregar(prep.job.id, dispatch.taskId, texto);
    prep.entry.entregas.push({
      taskId: dispatch.taskId, fase: fase.n, para: dispatch.para,
      resumen: texto, rework: false
    });
    prep.entry.progreso.dispatches.entregados += 1;
    prep.entry.progreso.fasesCompletadas = prep.entry.entregas.filter((e) => !e.reworkTester).length;
    decir(prep,
      { tipo: 'entrega', de: dispatch.para, resumen: trunc(texto, 220), tarea: dispatch.tarea },
      `Entrega fase ${fase.n} (${dispatch.para}): ${trunc(texto, 200)}`);

    // Peer review: 1 par, puro. Solo rework si hay mejora concreta (A4).
    setFase(prep, 'review');
    const rolRev = rolRevisor(dispatch.para, prep.equipo);
    const rev = revisar({ texto }, { rol: rolRev });
    if (!rev.silencio) {
      const mejoras = rev.mejoras.map((m) =>
        `- [${m.severidad}] ${m.que} Cómo: ${trunc(m.como, 250)} (evidencia: ${trunc(m.evidencia, 120)})`
      ).join('\n');
      decir(prep,
        { tipo: 'dispatch', speaker: rolRev, para: dispatch.para, tarea: `rework peer review: ${trunc(rev.mejoras[0]?.que || '', 160)}`, doneCriteria: dispatch.doneCriteria },
        `Peer review (${rolRev} → ${dispatch.para}): ${rev.mejoras.length} mejora(s). 1 rework.`);
      const rePrompt = [
        `[laburo ${prep.job.id} · fase ${fase.n}: REWORK por peer review]`,
        `TAREA ORIGINAL: ${dispatch.tarea}`,
        `CRITERIO DE DONE: ${dispatch.doneCriteria}`,
        `PEER REVIEW de ${rolRev} (aplicar TODO y re-entregar completo):`,
        mejoras,
        'Re-entregá la fase completa con las mejoras aplicadas.'
      ].join('\n\n');
      const reRes = await correrTurno(prep, miembro.id, rePrompt);
      const reTexto = String(reRes?.text || '');
      prep.orc.entregar(prep.job.id, dispatch.taskId, reTexto);
      const ent = prep.entry.entregas.find((e) => e.taskId === dispatch.taskId);
      if (ent) {
        ent.resumen = reTexto;
        ent.rework = true;
      }
      decir(prep,
        { tipo: 'entrega', de: dispatch.para, resumen: trunc(reTexto, 220), tarea: dispatch.tarea },
        `Re-entrega fase ${fase.n} (${dispatch.para}, post-review): ${trunc(reTexto, 200)}`);
    }
    setFase(prep, 'dispatch');
  }
}

async function ejecutarRondaTest(prep, producto, ronda) {
  setFase(prep, ronda === 1 ? 'test' : 'rework');
  prep.entry.progreso.ronda = ronda;
  const { miembro: tester, nota } = resolverEjecutor(prep, 'tester');
  if (nota && ronda === 1) {
    decir(prep, { tipo: 'test', nota }, `Tester: ${nota}`);
  }

  const resultados = [];
  // Mecánicos primero (directos, baratos, honestos).
  const mecanicos = await checksMecanicos(prep, producto);
  resultados.push(...mecanicos);

  const plan = planDePrueba(producto);
  for (const celda of plan.celdas) {
    checkVivo(prep);
    const res = await correrTurno(prep, tester.id, promptTesterCelda(prep, producto, celda));
    const v = parsearVeredicto(res?.text);
    resultados.push({
      celdaId: celda.id,
      persona: celda.persona,
      dimension: celda.dimension,
      titulo: `${celda.persona}×${celda.dimension}: ${trunc(celda.checks[0]?.mirar || '', 100)}`,
      origen: 'turno',
      ...v
    });
  }

  const pasadas = resultados.filter((r) => r.estado !== 'fail').length;
  const fallidas = resultados.length - pasadas;
  prep.entry.progreso.tests = {
    celdas: resultados.length,
    pasadas,
    fallidas,
    mecanicas: resultados.filter((r) => r.origen === 'mecanico').length,
    turnos: resultados.filter((r) => r.origen !== 'mecanico').length
  };
  prep.entry.testResultados.push({ ronda, resultados });
  return resultados;
}

async function ejecutarTesterLoop(prep, producto) {
  const arreglados = [];
  for (let ronda = 1; ronda <= prep.maxRondas; ronda += 1) {
    checkVivo(prep);
    const resultados = await ejecutarRondaTest(prep, producto, ronda);
    const juicio = juzgar(resultados, { ronda, arregladoEnRondas: [...arreglados] });

    if (juicio.veredicto === 'aprobado') {
      const aprob = aprobacionDesdeTester(juicio, { jobId: prep.job.id });
      prep.orc.aprobar(prep.job.id, aprob);
      const t = prep.entry.progreso.tests;
      decir(prep,
        {
          tipo: 'aprobado',
          resumen: `${t.pasadas}/${t.celdas} checks en verde (${t.mecanicas} mecánicos, ${t.turnos} por turno tester)`,
          limitaciones: (aprob.limitaciones || []).join('; ')
        },
        `APROBADO ronda ${ronda}: ${t.pasadas}/${t.celdas} en verde (${t.mecanicas} mecánicos + ${t.turnos} turnos). ${juicio.resumenVoz}`);
      return { estado: 'aprobado', juicio };
    }

    const dev = devolucionDesdeTester(juicio, { jobId: prep.job.id });
    const res = prep.orc.devolver(prep.job.id, dev);
    if (res.estado === 'escalado') {
      prep.entry.estado = 'escalado';
      prep.entry.escalado = res.escalado;
      prep.entry.progreso.estado = 'escalado';
      setFase(prep, 'escalado');
      const primero = dev.items[0] || {};
      decir(prep,
        { tipo: 'devolucion', items: dev.items.length, persona: primero.persona || 'tester', resumen: res.escalado.motivo, ronda },
        `ESCALADO: ${res.escalado.motivo}`);
      return { estado: 'escalado', juicio };
    }

    const primero = dev.items[0] || {};
    decir(prep,
      { tipo: 'devolucion', items: dev.items.length, persona: primero.persona || 'tester', resumen: trunc(primero.descripcion || '', 200), ronda: res.ronda },
      `Devolución ronda ${ronda}: ${dev.items.length} item(s). ${juicio.resumenVoz}`);

    // Re-dispatches: 1 turno por item, dueño original.
    for (const red of res.redispatches) {
      checkVivo(prep);
      const { miembro, nota } = resolverEjecutor(prep, red.para);
      red.estado = 'en_curso';
      decir(prep,
        { tipo: 'dispatch', para: red.para, tarea: red.tarea, doneCriteria: red.doneCriteria },
        `Re-dispatch → ${red.para}: ${trunc(red.tarea, 160)}${nota ? ` [${nota}]` : ''}`);
      const item = dev.items.find((it) => red.tarea.includes(it.descripcion.slice(0, 40))) || {};
      const rePrompt = [
        `[laburo ${prep.job.id} · REWORK ronda ${ronda}]`,
        `TAREA: ${red.tarea}`,
        `CRITERIO DE DONE: ${red.doneCriteria}`,
        `DEVOLUCIÓN DEL TESTER (persona: ${item.persona || 'tester'}):`,
        `- ${item.descripcion || red.tarea}`,
        item.reproduccion ? `Repro: ${item.reproduccion}` : null,
        contextoEntregasPrevias(prep),
        'Corregí y re-entregá completo.'
      ].filter(Boolean).join('\n\n');
      const reRes = await correrTurno(prep, miembro.id, rePrompt);
      const reTexto = String(reRes?.text || '');
      prep.orc.entregar(prep.job.id, red.taskId, reTexto);
      prep.entry.entregas.push({
        taskId: red.taskId, fase: red.fase || 1, para: red.para,
        resumen: reTexto, rework: true, reworkTester: true
      });
      arreglados.push(trunc(red.tarea, 160));
      decir(prep,
        { tipo: 'entrega', de: red.para, resumen: trunc(reTexto, 220), tarea: red.tarea },
        `Re-entrega (${red.para}): ${trunc(reTexto, 200)}`);
    }
  }
  // Inalcanzable: devolver() escala en maxRondas. Defensa por si maxRondas
  // cambia bajo los pies.
  prep.entry.estado = 'escalado';
  prep.entry.progreso.estado = 'escalado';
  setFase(prep, 'escalado');
  return { estado: 'escalado', juicio: null };
}

function registrarLearnings(prep, salidaTester) {
  try {
    const agentePorRol = {};
    for (const m of prep.equipo) {
      if (!agentePorRol[m.role]) agentePorRol[m.role] = m.id;
    }
    const vistos = new Map();
    for (const { resultados } of prep.entry.testResultados) {
      for (const r of resultados) {
        if (r.estado === 'fail' && r.titulo) {
          vistos.set(r.titulo, (vistos.get(r.titulo) || 0) + 1);
        }
      }
    }
    const recurrentes = [...vistos.entries()]
      .filter(([, n]) => n > 1)
      .map(([t]) => t)
      .slice(0, 3);
    return registrarLearningsDeLaburo(prep.store, {
      meetingId: prep.session?.meeting?.id || null,
      agentePorRol,
      juicioFinal: salidaTester?.juicio || {},
      rondas: prep.entry.progreso.ronda,
      fallosRecurrentes: recurrentes
    });
  } catch {
    return { creados: 0, reforzados: 0 };
  }
}

async function executeJob(prep) {
  const brief = prep.entry.briefClon;
  if (!prep.job) throw new Error('job sin intake (brief inválido)');
  if (prep.equipo.length === 0) throw new Error('sin roster: no hay agentes en la sesión');

  // 1. Fases + plan + research (FALTA:* se resuelve vía spawner real).
  setFase(prep, 'plan');
  const { fases, origen } = await resolverFases(prep, brief);
  checkVivo(prep);
  await prep.orc.planificar(prep.job.id, fases, { research: true });
  checkVivo(prep);
  const plan = prep.job.plan;
  prep.entry.progreso.fasesTotal = plan.fases.length;
  const researchUsado = plan.research.some(
    (r) => r.decision !== 'se construye desde cero' && r.hallazgo !== 'sin pre-hecho usable encontrado'
  );
  decir(prep,
    {
      tipo: 'plan_listo',
      fases: plan.fases.length,
      researchUsado,
      resumen: plan.fases.map((f) => `${f.titulo} (${f.dueño})`).join(' → ')
    },
    `Plan listo (${origen}): ${plan.fases.map((f) => `${f.titulo}→${f.dueño}`).join(' → ')}${researchUsado ? ' [con pre-hecho]' : ''}`);

  // 2. Dispatches secuenciales en orden de dependencias + peer review.
  await ejecutarDispatches(prep);

  // 3. Tester loop (mecánicos + turnos) con rework acotado.
  const producto = productoDeBrief(brief);
  const salida = await ejecutarTesterLoop(prep, producto);

  // 4. Learnings + cierre.
  const learn = registrarLearnings(prep, salida);
  if (salida.estado === 'aprobado' && !prep.entry.dead) {
    prep.entry.estado = 'aprobado';
    prep.entry.progreso.estado = 'aprobado';
    setFase(prep, 'done');
    decir(prep,
      { tipo: 'aprobado', resumen: `laburo cerrado (${learn.creados} learnings nuevos, ${learn.reforzados} reforzados)` },
      `Cierre: learnings ${learn.creados} nuevos / ${learn.reforzados} reforzados.`);
  }
  return salida;
}

function withJobTimeout(promise, prep) {
  let timer = null;
  const ms = prep.jobTimeoutMs;
  const espera = new Promise((_, reject) => {
    timer = setTimeout(() => {
      prep.entry.dead = true;
      try {
        prep.controller?.abort();
      } catch {
        // Sin AbortController: el race igual corta la espera.
      }
      reject(Object.assign(new Error(`timeout job ${ms}ms`), { code: 'JOB_TIMEOUT' }));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, espera]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── API pública ──────────────────────────────────────────────────────────

// Corre el job hasta el final (tests lo usan directo con session fake).
// Retorna la vista pública final. Nunca cuelga: todo error → estado 'fallo'.
export async function runJob(session, brief, opts = {}) {
  const prep = prepareJob(session, brief, opts);
  if (prep.preguntas) return getJob(prep.entry.id);
  try {
    await withJobTimeout(executeJob(prep), prep);
  } catch (error) {
    if (error?.code !== 'JOB_MUERTO') markFallo(prep, error);
    else markFallo(prep, new Error('timeout job (cancelado entre pasos)'));
  }
  return getJob(prep.entry.id);
}

// Encola el job para correr async (rutas HTTP). Intake YA (síncrono) para
// devolver jobId real; la ejecución va por setImmediate.
export function enqueueJob(session, brief, opts = {}) {
  const prep = prepareJob(session, brief, opts);
  if (prep.preguntas) return { jobId: prep.entry.id, estado: 'preguntas' };
  prep.entry.estado = 'encolado';
  prep.entry.progreso.estado = 'encolado';
  setImmediate(() => {
    withJobTimeout(executeJob(prep), prep).catch((error) => {
      if (error?.code !== 'JOB_MUERTO') markFallo(prep, error);
      else markFallo(prep, new Error('timeout job (cancelado entre pasos)'));
    });
  });
  return { jobId: prep.entry.id, estado: 'encolado' };
}
