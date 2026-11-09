// Matriz de capabilities por rol (track B — flujo de equipo).
//
// Cada capability mapea a TOOLS/SKILLS/LIBS REALES de este repo: el test de
// integridad (tests/flujo-spawner.test.mjs) resuelve cada entrada contra el
// registry de manos.js y el dir de skills, y FALLA si alguien agrega una
// capability fantasma. Lo que se pidió y NO existe va en GAPS, no en la
// matriz: nunca se finge una conexión.

import { listTools } from './manos.js';
import { listSkillNames } from './skills.js';

// ---------------------------------------------------------------------------
// Capabilities: capability -> fuentes reales
// ---------------------------------------------------------------------------
// tools: nombres del registry de manos.js (verificado 09/11: read_file,
//   list_files, write_file, run_cmd, fetch_url, now, open_url, window_list,
//   screenshot).
// skills: nombres de server/skills/*.md (frontmatter name:).
// libs: módulos de server/lib que el rol usa (memoria, voz, verificación).
// needs: condiciones del entorno que pueden faltar (se reportan, no rompen):
//   display (sesión gráfica), openpencil (binarios op), mcp:<server> (config).

export const CAPABILITY_SOURCES = {
  // Base: todos los roles.
  'workspace-read': { tools: ['read_file', 'list_files'], skills: [], libs: [] },
  'workspace-write': { tools: ['write_file'], skills: [], libs: [] },
  web: { tools: ['fetch_url'], skills: ['investigacion-web'], libs: [] },
  memoria: { tools: [], skills: [], libs: ['pablo-memory.js', 'learning.js'] },
  voz: { tools: [], skills: ['reunion-breve'], libs: ['groupchat.js'] },
  tiempo: { tools: ['now'], skills: [], libs: [] },
  // Backend.
  exec: { tools: ['run_cmd'], skills: ['terminal'], libs: ['herramientas.js'] },
  tests: { tools: ['run_cmd'], skills: ['revision-codigo'], libs: ['verify.js'] },
  // Frontend.
  navegador: { tools: ['open_url', 'fetch_url'], skills: [], libs: [], needs: ['display'] },
  preview: { tools: ['open_url'], skills: [], libs: [], needs: ['display'] },
  // Diseño.
  canvas: { tools: [], skills: ['diseno-web'], libs: ['openpencil.js'], needs: ['openpencil'] },
  assets: { tools: ['read_file', 'write_file'], skills: ['diseno-web'], libs: [] },
  // Copy.
  estilos: { tools: [], skills: ['copy-ventas'], libs: [] },
  // Marketing / ventas.
  research: { tools: ['fetch_url'], skills: ['investigacion-web', 'marketing'], libs: [] },
  copy: { tools: [], skills: ['copy-ventas', 'marketing'], libs: [] },
  'outreach-lectura': { tools: ['fetch_url'], skills: ['ventas'], libs: [] },
  // Tester.
  'navegador-destructivo': { tools: ['open_url', 'fetch_url', 'run_cmd'], skills: ['pruebas'], libs: [], needs: ['display'] },
  screenshots: { tools: ['screenshot'], skills: ['pruebas'], libs: [], needs: ['display'] },
  'verificacion': { tools: ['run_cmd'], skills: ['pruebas', 'revision-codigo'], libs: ['verify.js'] },
  // Orquestador.
  dispatch: { tools: [], skills: ['plan-dispatch'], libs: ['workforce.js'] },
  tracking: { tools: ['read_file', 'list_files'], skills: ['plan-dispatch'], libs: ['session-log.js'] },
  // Spawner.
  'crear-agentes': { tools: ['write_file'], skills: [], libs: ['agent-conventions.js'] },
  // Data / devops (roles base del plan maestro).
  datos: { tools: ['run_cmd', 'read_file'], skills: ['terminal'], libs: ['verify.js'] },
  deploy: { tools: ['run_cmd', 'open_url'], skills: ['terminal'], libs: ['native-build.js'] }
};

// GAPS: pedido que NO existe en el repo/box. Documentado acá para que nadie
// lo cablee como si anduviera. Cada gap dice qué lo desbloquearía.
export const GAPS = [
  {
    pedido: 'browser-automation (click/type/DOM)',
    realidad: 'no hay automation de navegador; lo más cercano es open_url + fetch_url + screenshot',
    desbloquea: 'un driver CDP/playwright + tool manos (no existe en el repo)'
  },
  {
    pedido: 'mcp:* por rol',
    realidad: 'cero MCP servers configurados (PABLO_MCP_SERVERS unset)',
    desbloquea: 'configurar PABLO_MCP_SERVERS con servers reales y re-correr integrity'
  },
  {
    pedido: 'canvas openpencil en este box',
    realidad: 'lib openpencil.js real pero binarios op/openpencil-desktop no instalados',
    desbloquea: 'scripts/instalar-openpencil.sh en el desktop'
  },
  {
    pedido: 'outreach envío (email/linkedin/dm)',
    realidad: 'no existe tool de envío; además prohibido sin OK de Tito',
    desbloquea: 'definir canal + tool + aprobación explícita (decisión de Tito)'
  }
];

export const BASE_CAPABILITIES = [
  'workspace-read',
  'workspace-write',
  'web',
  'memoria',
  'voz',
  'tiempo'
];

// Matriz rol -> capabilities propias (la base se suma siempre).
export const ROLE_MATRIX = {
  pablo: [],
  orquestador: ['research', 'dispatch', 'tracking'],
  spawner: ['crear-agentes'],
  backend: ['exec', 'tests'],
  frontend: ['exec', 'navegador', 'preview'],
  diseno: ['canvas', 'assets'],
  copy: ['estilos', 'copy'],
  marketing: ['research', 'copy', 'outreach-lectura'],
  ventas: ['research', 'copy', 'outreach-lectura'],
  data: ['datos'],
  devops: ['exec', 'deploy'],
  tester: ['navegador-destructivo', 'screenshots', 'verificacion']
};

export function knownRoles() {
  return Object.keys(ROLE_MATRIX);
}

export function isKnownRole(rol) {
  return Object.hasOwn(ROLE_MATRIX, String(rol || '').trim().toLowerCase());
}

// Base + propias, deduplicadas, en orden estable.
export function capabilitiesForRole(rol) {
  const key = String(rol || '').trim().toLowerCase();
  const propias = ROLE_MATRIX[key];
  if (!propias) {
    return [...BASE_CAPABILITIES];
  }
  return [...new Set([...BASE_CAPABILITIES, ...propias])];
}

// Tools/skills concretas que un rol puede usar (para el prompt manos y la
// inyección de skills). needs se reporta aparte, no filtra: el rol sabe qué
// le puede fallar por entorno.
export function toolsForRole(rol) {
  const out = [];
  for (const cap of capabilitiesForRole(rol)) {
    for (const t of CAPABILITY_SOURCES[cap]?.tools || []) {
      if (!out.includes(t)) {
        out.push(t);
      }
    }
  }
  return out;
}

export function skillsForCapabilities(caps) {
  const out = [];
  for (const cap of caps || []) {
    for (const s of CAPABILITY_SOURCES[cap]?.skills || []) {
      if (!out.includes(s)) {
        out.push(s);
      }
    }
  }
  return out;
}

export function skillsForRoleMatrix(rol) {
  return skillsForCapabilities(capabilitiesForRole(rol));
}

// ¿Un capability resuelve a fuentes reales? tools/skills se chequean contra
// los inventarios pasados (default: los reales del repo). libs se chequean
// contra la lista de módulos conocidos de server/lib.
const KNOWN_LIBS = new Set([
  'agent-conventions.js', 'agent-runtime.js', 'andamiaje.js', 'audio.js',
  'conciencia.js', 'config.js', 'db.js', 'groupchat.js', 'herramientas.js',
  'learning.js', 'llm.js', 'manos.js', 'manos-mcp.js', 'mcp.js',
  'meeting-session.js', 'memory.js', 'mission.js', 'native-build.js',
  'openpencil.js', 'pablo-memory.js', 'playbooks.js', 'priority.js',
  'sala.js', 'session-log.js', 'settings.js', 'skills.js', 'store.js',
  'turn-pipeline.js', 'verify.js', 'workforce.js', 'workforce-fs.js'
]);

export function resolveCapability(name, { tools = null, skills = null } = {}) {
  const src = CAPABILITY_SOURCES[name];
  if (!src) {
    return { ok: false, missing: [`capability desconocida: ${name}`] };
  }
  const haveTools = new Set(tools || listTools().map((t) => t.name));
  const haveSkills = new Set(skills || listSkillNames());
  const missing = [];
  for (const t of src.tools || []) {
    if (!haveTools.has(t)) {
      missing.push(`tool ${t}`);
    }
  }
  for (const s of src.skills || []) {
    if (!haveSkills.has(s)) {
      missing.push(`skill ${s}`);
    }
  }
  for (const l of src.libs || []) {
    if (!KNOWN_LIBS.has(l)) {
      missing.push(`lib ${l}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

// Recorre TODA la matriz: devuelve las capabilities fantasma. Vacío = íntegra.
export function integrityCheck(inv = {}) {
  const fantasma = [];
  const todas = new Set([...BASE_CAPABILITIES]);
  for (const caps of Object.values(ROLE_MATRIX)) {
    for (const c of caps) {
      todas.add(c);
    }
  }
  for (const cap of todas) {
    const r = resolveCapability(cap, inv);
    if (!r.ok) {
      fantasma.push({ capability: cap, missing: r.missing });
    }
  }
  return fantasma;
}

// ¿Qué rol existente ya cubre estas capabilities? Para cero duplicados: si
// las pedidas son subconjunto de (base + propias) de un rol, ese rol cubre.
// Devuelve el nombre del rol o null.
export function rolQueCubre(caps) {
  const pedidas = new Set((caps || []).map((c) => String(c).trim()).filter(Boolean));
  if (pedidas.size === 0) {
    return null;
  }
  for (const rol of knownRoles()) {
    const tiene = new Set(capabilitiesForRole(rol));
    let cubre = true;
    for (const p of pedidas) {
      if (!tiene.has(p)) {
        cubre = false;
        break;
      }
    }
    if (cubre) {
      return rol;
    }
  }
  return null;
}

// Pura, sin IO: ¿este producto justifica revisión de marketing/ventas antes
// de aprobar? Hook lógico para el track C (tester): si true, el Tester suma
// la pasada de monetización. Señales: vende, cobra, se ofrece o compite.
const MONETIZA_PATTERNS = [
  /precio/i, /pago/i, /pagar/i, /suscripci[oó]n/i, /plan\s+(free|pro|pago|premium)/i,
  /venta/i, /vende/i, /vender/i, /tienda/i, /e-?commerce/i, /checkout/i,
  /negocio/i, /cliente/i, /mercado/i, /oferta/i, /landing/i, /anuncio/i,
  /monetiz/i, /comercial/i, /ingreso/i, /factur/i, /negocio/i, /marca/i,
  /posicionamiento/i, /embudo/i, /funnel/i, /conversi[oó]n/i, /leads?/i,
  /pricing/i, /billing/i, /subscribe/i, /customer/i, /market/i, /brand/i
];

export function revisaMonetizacion(producto) {
  if (!producto || typeof producto !== 'object') {
    return false;
  }
  if (producto.vende === true || producto.monetiza === true || producto.comercial === true) {
    return true;
  }
  const texto = [
    producto.nombre, producto.descripcion, producto.tipo,
    ...(Array.isArray(producto.features) ? producto.features : []),
    ...(Array.isArray(producto.tags) ? producto.tags : [])
  ].filter((v) => typeof v === 'string').join('\n');
  if (!texto.trim()) {
    return false;
  }
  return MONETIZA_PATTERNS.some((p) => p.test(texto));
}
