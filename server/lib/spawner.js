// Spawner (track B — flujo de equipo): crea especialistas bajo demanda.
//
// Protocolo spawn-request (Orquestador→Spawner): rol faltante + por qué + qué
// capabilities necesita. El Spawner responde con la ficha del nuevo agente o
// con "ya existe X que cubre" (cero duplicados, vía rolQueCubre). Rechaza con
// motivo si el rol no tiene sentido.
//
// La ficha vive en workspace/<empresa>/agentes/<id>/AGENTS.md (vía
// ensureAgentConventions, seed por rol). Nunca lanza: todo resultado es un
// objeto { created, ... } con motivo legible.

import {
  CAPABILITY_SOURCES,
  capabilitiesForRole,
  isKnownRole,
  knownRoles,
  rolQueCubre,
  skillsForCapabilities,
  toolsForRole
} from './capabilities.js';
import { getTool, listTools, runToolLoop } from './manos.js';
import { rmSync } from 'node:fs';
import { enterSpawn, exitSpawn } from './budgets.js';
import { ensureAgentConventions } from './agent-conventions.js';
import { appendDaily } from './pablo-memory.js';

// Log de spawns del proceso (la matriz viva la persiste el main vía
// learning; acá queda el registro consultable + daily opcional).
const spawnLogEntries = [];

export function spawnLog() {
  return [...spawnLogEntries];
}

function registrar(entry, companySlug = null) {
  spawnLogEntries.push({ at: new Date().toISOString(), ...entry });
  if (companySlug) {
    try {
      appendDaily(companySlug, `Spawner: ${entry.resumen || JSON.stringify(entry)}`);
    } catch {
      // Memoria ausente no rompe el spawn.
    }
  }
}

function slugId(rol) {
  const base = String(rol || 'agente').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agente';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}`;
}

// Normaliza el pedido a { rol, porque, capabilities }. capabilities pedidas
// que no existen en la matriz se reportan como desconocidas (no se inventan).
export function normalizarPedido(pedido = {}) {
  const rol = String(pedido.rol || '').trim().toLowerCase();
  const porque = String(pedido.porque || pedido.why || '').trim();
  const capabilities = [...new Set(
    (Array.isArray(pedido.capabilities) ? pedido.capabilities : [])
      .map((c) => String(c || '').trim())
      .filter(Boolean)
  )];
  return { rol, porque, capabilities };
}

// Spawn-request completo. ctx: { companySlug?, nombre?, equipo? }.
// equipo: miembros actuales [{id, role}] para el chequeo de duplicados.
// Devuelve:
// - creado: { created: true, agent: {id, role, name}, ficha, capabilities,
//             skills, tools, motivo }
// - existente: { created: false, existing: <rol>, motivo }
// - rechazo: { created: false, rejected: true, motivo }
export function spawnRequest(pedido = {}, ctx = {}) {
  const { rol, porque, capabilities } = normalizarPedido(pedido);
  const companySlug = ctx.companySlug || null;

  // 1. Sin porqué no hay spawn: el Orquestador tiene que justificar.
  if (!porque) {
    const r = { created: false, rejected: true, motivo: 'rechazado: falta el porqué (el Orquestador no justificó el rol)' };
    registrar({ ...r, resumen: `rechazo ${rol || '(sin rol)'}: sin porqué` }, companySlug);
    return r;
  }

  // 2. Cero duplicados contra el EQUIPO ACTUAL (ctx.equipo: [{id, role}]):
  // si un miembro ya cubre lo pedido, se responde con el existente.
  // La matriz sola no decide: un rol conocido sin miembro en el equipo
  // SÍ se crea; con miembro que cubre, NO.
  const equipo = Array.isArray(ctx.equipo) ? ctx.equipo : [];
  const pedidas = capabilities.length > 0 ? capabilities : capabilitiesForRole(rol);
  for (const miembro of equipo) {
    const tiene = new Set(capabilitiesForRole(miembro?.role));
    if (pedidas.length > 0 && pedidas.every((p) => tiene.has(p))) {
      const r = {
        created: false,
        existing: miembro.role,
        agentId: miembro.id || null,
        motivo: `ya existe ${miembro.id || miembro.role} (${miembro.role}) que cubre ${pedidas.join(', ')} — cero duplicados`
      };
      registrar({ ...r, resumen: `duplicado evitado: ${rol || '(sin rol)'} → ${miembro.role}` }, companySlug);
      return r;
    }
  }
  // Sin equipo informado, la matriz igual evita el disparate: pedir un rol
  // conocido sin nada extra y sin porqué específico no aplica (el porqué ya
  // se exigió arriba), así que se sigue a crear.
  if (isKnownRole(rol)) {
    // Rol conocido, nadie lo cubre en el equipo → crear (paso 5).
  } else if (rol) {
    // 3. Rol desconocido: si lo pedido lo cubre un rol existente, derivar.
    const cubre = capabilities.length > 0 ? rolQueCubre(capabilities) : null;
    if (cubre) {
      const r = {
        created: false,
        existing: cubre,
        motivo: `el rol ${rol} no existe pero ${cubre} ya cubre ${capabilities.join(', ')} — usá ${cubre}`
      };
      registrar({ ...r, resumen: `duplicado evitado: ${rol} → ${cubre}` }, companySlug);
      return r;
    }
    // Rol desconocido SIN capabilities concretas = no tiene sentido.
    if (capabilities.length === 0) {
      const r = {
        created: false,
        rejected: true,
        motivo: `rechazado: el rol ${rol} no existe y el pedido no trae capabilities concretas (roles válidos: ${knownRoles().join(', ')})`
      };
      registrar({ ...r, resumen: `rechazo ${rol}: rol desconocido sin capabilities` }, companySlug);
      return r;
    }
    // Rol nuevo CON capabilities concretas: se crea como especialista ad-hoc.
    // (La matriz no se muta: el main decide si el rol nuevo amerita matriz.)
  } else {
    // 4. Sin rol y sin capabilities: rechazo.
    if (capabilities.length === 0) {
      const r = { created: false, rejected: true, motivo: 'rechazado: pedido vacío (sin rol ni capabilities)' };
      registrar({ ...r, resumen: 'rechazo: pedido vacío' }, companySlug);
      return r;
    }
    const cubre = rolQueCubre(capabilities);
    if (cubre) {
      const r = { created: false, existing: cubre, motivo: `ya existe el rol ${cubre} que cubre ${capabilities.join(', ')}` };
      registrar({ ...r, resumen: `duplicado evitado: (sin rol) → ${cubre}` }, companySlug);
      return r;
    }
  }

  // 5. Crear: ficha + skills + tools.
  const roleFinal = rol || 'backend';
  const id = slugId(roleFinal);
  const name = ctx.nombre || `${roleFinal[0].toUpperCase()}${roleFinal.slice(1)}`;
  const agent = { id, role: roleFinal, name };
  const capsFinales = [...new Set([...capabilitiesForRole(roleFinal), ...capabilities])];

  let ficha = null;
  if (companySlug) {
    try {
      const r = ensureAgentConventions(companySlug, agent);
      ficha = r.path || null;
    } catch {
      ficha = null;
    }
  }

  // E-04(a): necesidades del entorno (display, tito-ok, mcp:X) + MCPs.
  const needs = needsForCapabilities(capsFinales);
  const r = {
    created: true,
    agent,
    ficha,
    capabilities: capsFinales,
    skills: skillsForCapabilities(capsFinales),
    tools: toolsForRole(roleFinal),
    needs,
    mcp: needs.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4)),
    motivo: `creado ${name} (${roleFinal}) para: ${porque}`
  };
  registrar({ ...r, resumen: `spawn ${id} (${roleFinal}): ${porque.slice(0, 120)}` }, companySlug);
  return r;
}

// E-04(a): needs agregados de las capabilities (se reportan, no filtran:
// el rol SABE qué puede fallarle por entorno).
export function needsForCapabilities(caps) {
  const out = [];
  for (const cap of caps || []) {
    for (const need of CAPABILITY_SOURCES[cap]?.needs || []) {
      if (!out.includes(need)) {
        out.push(need);
      }
    }
  }
  return out;
}

// E-04(b): smoke test real del rol spawneado. Sin red, sin side effects:
// - registry: toda tool no-mcp del allow existe de verdad.
// - boundaries: una tool real fuera del allow se rechaza sin ejecutar.
// - exec: una tool segura del allow se ejecuta (now/read/list).
// - responde: el loop llega a texto final.
const SAFE_SMOKE_ARGS = {
  now: {},
  list_files: {},
  read_file: { path: '__smoke__.txt' }
};

function smokeCall(name, args) {
  return `\`\`\`tool:${name}\n${JSON.stringify(args || {})}\n\`\`\``;
}

export async function smokeSpawnedAgent({ role, allow = null, source = {} } = {}) {
  const checks = {};
  const allowed = Array.isArray(allow) ? allow : toolsForRole(role);
  // 1. Registry: presencia real (las mcp_* son dinámicas, se saltean).
  const missing = allowed.filter((n) => !String(n).startsWith('mcp_') && !getTool(n));
  checks.registry = missing.length === 0 ? 'ok' : `faltan: ${missing.join(',')}`;
  // 2-4. Loop con modelo fake.
  const registered = new Set(listTools().map((x) => x.name));
  const forbidden = [...registered].find((n) => !allowed.includes(n) && !String(n).startsWith('mcp_'))
    || '__smoke_unknown__';
  const safe = allowed.find((n) => SAFE_SMOKE_ARGS[n] && registered.has(n));
  const scripts = [
    smokeCall(forbidden, {}),
    safe ? smokeCall(safe, SAFE_SMOKE_ARGS[safe]) : 'smoke: sin tool segura, respondo directo.',
    'smoke final: respondo.'
  ];
  let fakeCalls = 0;
  let idx = 0;
  const outcome = await runToolLoop({
    system: 'smoke del spawner',
    messages: [{ role: 'user', content: 'smoke' }],
    completeChat: async () => {
      fakeCalls += 1;
      return { text: scripts[Math.min(idx++, scripts.length - 1)] };
    },
    source: { companyId: 'smoke', slug: 'smoke', ...source },
    allow: allowed,
    maxTurns: 5,
    deadlineMs: 20000
  });
  const calls = (outcome.toolTurns || []).flatMap((x) => x?.calls || []);
  const rej = calls.find((c) => c.tool === forbidden);
  checks.boundary = rej && !rej.ok && String(rej.error || '').includes('no permitida')
    ? 'ok'
    : (forbidden === '__smoke_unknown__' && rej && !rej.ok ? 'ok-desconocida' : `falló (calls=${calls.length})`);
  if (safe) {
    const ran = calls.find((c) => c.tool === safe);
    checks.exec = ran && !String(ran.error || '').includes('no permitida') && !String(ran.error || '').includes('desconocida')
      ? 'ok'
      : 'falló';
  } else {
    checks.exec = 'n/a (solo presencia)';
  }
  checks.responded = fakeCalls >= 2 ? 'ok' : 'falló';
  const ok = checks.registry === 'ok' && checks.boundary.startsWith('ok') &&
    (checks.exec === 'ok' || checks.exec.startsWith('n/a')) && checks.responded === 'ok';
  return { ok, role, checks };
}

const SPAWN_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M4', 'M5'];
const SPAWN_COLORS = ['#4c6ef5', '#9c36b5', '#0ca678', '#e8590c', '#1c7ed6', '#f08c00', '#7048e8', '#37b24d'];

// E-04(d): spawn completo contra store + proyecto: valida → inserta agente
// → asigna a roster → smoke → persiste (changelog). Si algo falla,
// ROLLBACK (borra agente + roster + ficha) y devuelve motivo.
export async function spawnAgent({ store, goalId, pedido = {}, ctx = {} } = {}) {
  if (!store || !goalId) {
    return { created: false, rejected: true, motivo: 'spawnAgent necesita {store, goalId}' };
  }
  const goal = store.getGoal(goalId);
  if (!goal) {
    return { created: false, rejected: true, motivo: `proyecto inexistente: ${goalId}` };
  }
  // Equipo actual = roster del proyecto (cero duplicados intra-proyecto).
  let equipo = Array.isArray(ctx.equipo) ? ctx.equipo : null;
  if (!equipo) {
    try {
      equipo = store.rosterForProject(goalId)
        .filter((r) => r.agent_id)
        .map((r) => ({ id: r.agent_id, role: r.role || r.roleWanted }));
    } catch {
      equipo = [];
    }
  }
  const companySlug = ctx.companySlug || goal.company_id;
  // A-08: anti-recursión estructural de spawns anidados.
  if (!enterSpawn()) {
    return { created: false, rejected: true, motivo: 'rechazado: tope de spawns anidados (anti-recursión)' };
  }
  try {
    return await spawnAgentInner(store, goal, goalId, pedido, ctx, equipo, companySlug);
  } finally {
    exitSpawn();
  }
}

async function spawnAgentInner(store, goal, goalId, pedido, ctx, equipo, companySlug) {
  const r = spawnRequest(pedido, { ...ctx, companySlug, equipo });
  if (!r.created) {
    return r;
  }
  const createdPaths = [];
  if (r.ficha) {
    createdPaths.push(r.ficha);
  }
  const rollback = (motivo) => {
    try { store.deleteAgent(r.agent.id, 'spawner'); } catch { /* best-effort */ }
    for (const p of createdPaths) {
      try {
        rmSync(p, { force: true });
      } catch { /* best-effort */ }
    }
    try { store.logChange('spawner', 'agent', r.agent.id, 'rollback', { motivo }); } catch { /* best-effort */ }
    registrar({ created: false, rolledBack: true, motivo }, companySlug);
    return { created: false, rolledBack: true, motivo };
  };
  try {
    const companyAgents = store.listAgents({ companyId: goal.company_id });
    const usedVoices = new Set(companyAgents.map((a) => a.voice));
    const voice = SPAWN_VOICES.find((v) => !usedVoices.has(v)) || SPAWN_VOICES[companyAgents.length % SPAWN_VOICES.length];
    const color = SPAWN_COLORS[companyAgents.length % SPAWN_COLORS.length];
    store.insertAgent({
      id: r.agent.id,
      name: r.agent.name,
      title: `Especialista ${r.agent.role}`,
      voice,
      color,
      style: '',
      aliases: [r.agent.name.toLowerCase(), r.agent.role],
      domains: [],
      boundaries: [`Respeta su rol (${r.agent.role}): fuera de él, deriva.`],
      knowledge: '',
      craft: '',
      companyId: goal.company_id,
      role: r.agent.role,
      managerId: null
    }, 'spawn', 'spawner');
    store.addAgentToProject(goalId, r.agent.id, r.agent.role, 'spawn');
    store.logChange('spawner', 'roster', goalId, 'assign', { agentId: r.agent.id, role: r.agent.role });
  } catch (error) {
    return rollback(`no se pudo persistir: ${String(error?.message || error).slice(0, 200)}`);
  }
  // Smoke: si el rol no pasa, el spawn se revierte (barra perfectito).
  try {
    const smoke = await smokeSpawnedAgent({ role: r.agent.role });
    if (!smoke.ok) {
      return rollback(`smoke falló: ${JSON.stringify(smoke.checks).slice(0, 300)}`);
    }
    r.smoke = smoke.checks;
  } catch (error) {
    return rollback(`smoke rompió: ${String(error?.message || error).slice(0, 200)}`);
  }
  return r;
}

// Solo tests.
export function __resetSpawnLog() {
  spawnLogEntries.length = 0;
}
