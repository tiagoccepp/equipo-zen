// ── Protocolos del equipo: los 7 contratos entre agentes ─────────────────
// Lógica 100% PURA: validadores sin I/O, sin imports, sin estado.
// Sirve a los 3 tracks (A orquestador, B spawner, C tester) como vocabulario
// compartido. Si un objeto no valida, no viaja: el emisor lo corrige antes.
//
// Convención: cada contrato expone `is<Nombre>(obj) -> { ok, errors[] }`
// y `assert<Nombre>(obj) -> obj` (lanza Error con mensaje legible).

const esObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esStr = (v) => typeof v === 'string';
const noVacio = (v) => esStr(v) && v.trim().length > 0;
const esArr = (v) => Array.isArray(v);

function check(cond, errors, msg) {
  if (!cond) errors.push(msg);
  return cond;
}

function assertOk(nombre, { ok, errors }, obj) {
  if (!ok) {
    throw new Error(`Contrato ${nombre} inválido: ${errors.join('; ')}`);
  }
  return obj;
}

// 1. Brief (Pablo → Orquestador). Sin objetivo ni criterios no hay dispatch.
export function isBrief(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'brief debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.objetivo), errors, 'objetivo requerido (string no vacío)');
  check(obj.contexto === undefined || esStr(obj.contexto), errors, 'contexto debe ser string');
  check(obj.restricciones === undefined || esArr(obj.restricciones), errors, 'restricciones debe ser array');
  check(
    esArr(obj.criteriosExito) && obj.criteriosExito.length > 0 && obj.criteriosExito.every(noVacio),
    errors, 'criteriosExito requerido (array no vacío de strings)'
  );
  check(obj.formatoEntrega === undefined || esStr(obj.formatoEntrega), errors, 'formatoEntrega debe ser string');
  check(obj.de === undefined || noVacio(obj.de), errors, 'de debe ser string no vacío');
  return { ok: errors.length === 0, errors };
}
export function assertBrief(obj) { return assertOk('brief', isBrief(obj), obj); }

// Fase suelta dentro de un plan.
export function isFase(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'fase debe ser un objeto')) return { ok: false, errors };
  check(Number.isInteger(obj.n) && obj.n >= 1, errors, 'fase.n entero >= 1');
  check(noVacio(obj.titulo), errors, 'fase.titulo requerido');
  check(noVacio(obj.dueño), errors, 'fase.dueño requerido (rol o agentId)');
  check(noVacio(obj.doneCriteria), errors, 'fase.doneCriteria requerido (medible)');
  check(
    obj.dependeDe === undefined || (esArr(obj.dependeDe) && obj.dependeDe.every((d) => Number.isInteger(d) && d >= 1)),
    errors, 'fase.dependeDe debe ser array de enteros >= 1'
  );
  return { ok: errors.length === 0, errors };
}

// 2. Plan (Orquestador). Fases 1..N sin huecos, dependeDe solo a anteriores.
export function isPlan(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'plan debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.jobId), errors, 'plan.jobId requerido');
  if (!check(esArr(obj.fases) && obj.fases.length > 0, errors, 'plan.fases requerido (array no vacío)')) {
    return { ok: false, errors };
  }
  const numeros = new Set();
  obj.fases.forEach((fase, i) => {
    const r = isFase(fase);
    if (!r.ok) errors.push(`fases[${i}]: ${r.errors.join(', ')}`);
    else {
      numeros.add(fase.n);
      for (const dep of fase.dependeDe || []) {
        if (dep >= fase.n) errors.push(`fases[${i}]: dependeDe ${dep} debe ser < n (${fase.n})`);
      }
    }
  });
  if (errors.length === 0) {
    for (let n = 1; n <= obj.fases.length; n++) {
      if (!numeros.has(n)) errors.push(`falta la fase ${n} (numeración 1..N sin huecos)`);
    }
  }
  check(
    obj.research === undefined || (esArr(obj.research) && obj.research.every((r) =>
      esObj(r) && noVacio(r.hallazgo) && noVacio(r.decision))),
    errors, 'plan.research: cada entrada { hallazgo*, decision*, fuente? }'
  );
  return { ok: errors.length === 0, errors };
}
export function assertPlan(obj) { return assertOk('plan', isPlan(obj), obj); }

// 3. Dispatch (Orquestador → Especialista). intento 1-based; el rechazo lo sube.
export function isDispatch(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'dispatch debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.taskId), errors, 'dispatch.taskId requerido');
  check(noVacio(obj.jobId), errors, 'dispatch.jobId requerido');
  check(Number.isInteger(obj.fase) && obj.fase >= 1, errors, 'dispatch.fase entero >= 1');
  check(noVacio(obj.para), errors, 'dispatch.para requerido (rol o agentId)');
  check(noVacio(obj.tarea), errors, 'dispatch.tarea requerida');
  check(noVacio(obj.doneCriteria), errors, 'dispatch.doneCriteria requerido');
  check(obj.deadlineRelativo === undefined || esStr(obj.deadlineRelativo), errors, 'deadlineRelativo debe ser string');
  check(obj.coordinarCon === undefined || esArr(obj.coordinarCon), errors, 'coordinarCon debe ser array');
  check(obj.intento === undefined || (Number.isInteger(obj.intento) && obj.intento >= 1), errors, 'intento entero >= 1');
  check(obj.estado === undefined || ['pendiente', 'aceptado', 'rechazado', 'en_curso', 'entregado'].includes(obj.estado),
    errors, 'estado inválido');
  return { ok: errors.length === 0, errors };
}
export function assertDispatch(obj) { return assertOk('dispatch', isDispatch(obj), obj); }

// 4. Spawn-request (Orquestador → Spawner) + su respuesta.
export function isSpawnRequest(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'spawn-request debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.jobId), errors, 'spawn-request.jobId requerido');
  check(noVacio(obj.rolFaltante), errors, 'spawn-request.rolFaltante requerido');
  check(noVacio(obj.porQue), errors, 'spawn-request.porQue requerido');
  check(esArr(obj.capabilities) && obj.capabilities.length > 0 && obj.capabilities.every(noVacio),
    errors, 'spawn-request.capabilities requerido (array no vacío)');
  return { ok: errors.length === 0, errors };
}
export function assertSpawnRequest(obj) { return assertOk('spawn-request', isSpawnRequest(obj), obj); }

export function isSpawnResponse(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'spawn-response debe ser un objeto')) return { ok: false, errors };
  check(typeof obj.ok === 'boolean', errors, 'spawn-response.ok booleano requerido');
  if (obj.ok === true) {
    const a = obj.agente || obj.existente;
    check(esObj(a) && noVacio(a.id) && noVacio(a.nombre), errors,
      'spawn-response ok:true requiere agente|existente { id*, nombre* }');
  } else if (obj.ok === false) {
    check(noVacio(obj.motivo), errors, 'spawn-response ok:false requiere motivo');
  }
  return { ok: errors.length === 0, errors };
}
export function assertSpawnResponse(obj) { return assertOk('spawn-response', isSpawnResponse(obj), obj); }

// 5. Peer review (Especialista → Especialista). Solo existe si hay mejora.
export function isPeerReview(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'peer-review debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.de), errors, 'peer-review.de requerido');
  check(noVacio(obj.para), errors, 'peer-review.para requerido');
  check(obj.sobreTaskId === undefined || noVacio(obj.sobreTaskId), errors, 'sobreTaskId debe ser string no vacío');
  check(noVacio(obj.que), errors, 'peer-review.que requerido (qué mejorar)');
  check(noVacio(obj.porQue), errors, 'peer-review.porQue requerido');
  check(obj.como === undefined || noVacio(obj.como), errors, 'como debe ser string no vacío');
  return { ok: errors.length === 0, errors };
}
export function assertPeerReview(obj) { return assertOk('peer-review', isPeerReview(obj), obj); }

// 6. Devolución (Tester → Orquestador). Items severizados, ronda >= 1.
export const SEVERIDADES = ['bug', 'mejora'];

export function isDevolucion(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'devolucion debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.jobId), errors, 'devolucion.jobId requerido');
  check(obj.taskId === undefined || noVacio(obj.taskId), errors, 'taskId debe ser string no vacío');
  check(Number.isInteger(obj.ronda) && obj.ronda >= 1, errors, 'devolucion.ronda entero >= 1');
  if (!check(esArr(obj.items) && obj.items.length > 0, errors, 'devolucion.items requerido (array no vacío)')) {
    return { ok: false, errors };
  }
  obj.items.forEach((item, i) => {
    if (!esObj(item)) { errors.push(`items[${i}]: debe ser objeto`); return; }
    if (!SEVERIDADES.includes(item.severidad)) errors.push(`items[${i}]: severidad bug|mejora`);
    if (!noVacio(item.descripcion)) errors.push(`items[${i}]: descripcion requerida`);
    if (item.reproduccion !== undefined && !esStr(item.reproduccion)) errors.push(`items[${i}]: reproduccion debe ser string`);
    if (item.persona !== undefined && !esStr(item.persona)) errors.push(`items[${i}]: persona debe ser string`);
  });
  return { ok: errors.length === 0, errors };
}
export function assertDevolucion(obj) { return assertOk('devolucion', isDevolucion(obj), obj); }

// 7. Aprobación (Tester → Pablo → Tito).
export function isAprobacion(obj) {
  const errors = [];
  if (!check(esObj(obj), errors, 'aprobacion debe ser un objeto')) return { ok: false, errors };
  check(noVacio(obj.jobId), errors, 'aprobacion.jobId requerido');
  check(
    esArr(obj.probado) && obj.probado.length > 0 && obj.probado.every((p) =>
      esObj(p) && noVacio(p.persona) && esArr(p.dimensiones) && p.dimensiones.length > 0),
    errors, 'aprobacion.probado requerido (array no vacío de { persona*, dimensiones[]* })'
  );
  check(obj.arreglado === undefined || esArr(obj.arreglado), errors, 'arreglado debe ser array');
  check(obj.limitaciones === undefined || esArr(obj.limitaciones), errors, 'limitaciones debe ser array');
  return { ok: errors.length === 0, errors };
}
export function assertAprobacion(obj) { return assertOk('aprobacion', isAprobacion(obj), obj); }

// ── Adaptadores entre tracks (main integra) ───────────────────────────────
// El Orquestador (A) habla en contratos canonical; el Spawner (B) y el
// Tester (C) devuelven sus propias formas. Estos adaptadores son el ÚNICO
// lugar donde se concilian: nadie más traduce.
// A→B: spawn-request canonical → pedido del spawner.
export function spawnRequestPara(orqReq) {
  return {
    rol: orqReq.rolFaltante,
    porque: orqReq.porQue,
    capabilities: orqReq.capabilities
  };
}

// B→A: respuesta del spawner → spawn-response canonical.
// equipo: [{id, role|rol, name|nombre}] para resolver `existing` (que viene
// como string de rol) a {id, nombre} que exige el protocolo.
export function adaptarSpawnResponse(spawnerRes, equipo = []) {
  if (spawnerRes?.created === true && spawnerRes.agent) {
    return {
      ok: true,
      agente: {
        id: spawnerRes.agent.id,
        nombre: spawnerRes.agent.name,
        role: spawnerRes.agent.role
      },
      motivo: spawnerRes.motivo || `rol ${spawnerRes.agent.role} creado`
    };
  }
  if (typeof spawnerRes?.existing === 'string') {
    const miembro = equipo.find((m) => m.role === spawnerRes.existing || m.rol === spawnerRes.existing);
    return {
      ok: true,
      existente: {
        id: spawnerRes.agentId || miembro?.id || `rol-${spawnerRes.existing}`,
        nombre: miembro?.name || miembro?.nombre || spawnerRes.existing
      },
      motivo: spawnerRes.motivo || `ya existe ${spawnerRes.existing}`
    };
  }
  return { ok: false, motivo: spawnerRes?.motivo || 'spawn rechazado sin motivo' };
}

// C→A: juicio del tester con fallos → devolucion canonical.
// nit→mejora (el protocolo solo admite bug|mejora); observado→descripcion.
export function devolucionDesdeTester(testerDev, { jobId, taskId } = {}) {
  const fallos = Array.isArray(testerDev?.fallos) ? testerDev.fallos : [];
  const dev = {
    jobId,
    ronda: testerDev?.ronda || 1,
    items: fallos.map((f) => ({
      severidad: f.severidad === 'bug' ? 'bug' : 'mejora',
      descripcion: `${f.titulo || 'tema'}: ${f.observado || ''}`.slice(0, 500),
      persona: f.persona,
      reproduccion: Array.isArray(f.pasosRepro) ? f.pasosRepro.join(' → ').slice(0, 500) : undefined
    }))
  };
  if (taskId) dev.taskId = taskId;
  return assertDevolucion(dev);
}

// C→A: aprobación del tester → aprobacion canonical.
export function aprobacionDesdeTester(testerAp, { jobId } = {}) {
  const personas = testerAp?.cobertura?.personas || [];
  const dimensiones = testerAp?.cobertura?.dimensiones || [];
  return assertAprobacion({
    jobId,
    probado: personas.map((p) => ({ persona: p, dimensiones })),
    arreglado: testerAp?.arregladoEnRondas || [],
    limitaciones: testerAp?.limitaciones || []
  });
}
