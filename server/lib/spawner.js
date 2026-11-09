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
  capabilitiesForRole,
  isKnownRole,
  knownRoles,
  rolQueCubre,
  skillsForCapabilities,
  toolsForRole
} from './capabilities.js';
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

  const r = {
    created: true,
    agent,
    ficha,
    capabilities: capsFinales,
    skills: skillsForCapabilities(capsFinales),
    tools: toolsForRole(roleFinal),
    motivo: `creado ${name} (${roleFinal}) para: ${porque}`
  };
  registrar({ ...r, resumen: `spawn ${id} (${roleFinal}): ${porque.slice(0, 120)}` }, companySlug);
  return r;
}

// Solo tests.
export function __resetSpawnLog() {
  spawnLogEntries.length = 0;
}
