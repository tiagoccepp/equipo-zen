// Capability matrix by role (track B — team flow).
//
// Each capability maps to REAL TOOLS/SKILLS/LIBS from this repo: the integrity
// test (tests/flujo-spawner.test.mjs) resolves each entry against the
// manos.js registry and the skills dir, and FAILS if anyone adds a
// phantom capability. What was requested and does NOT exist goes in GAPS, not in
// the matrix: a connection is never faked.

import { listTools } from './manos.js';
import { listSkillNames } from './skills.js';

// ---------------------------------------------------------------------------
// Capabilities: capability -> real sources
// ---------------------------------------------------------------------------
// tools: manos.js registry names (verified 09/11: read_file,
//   list_files, write_file, run_cmd, fetch_url, now, open_url, window_list,
//   screenshot).
// skills: server/skills/*.md names (frontmatter name:).
// libs: server/lib modules the role uses (memory, voice, verification).
// needs: environment conditions that may be missing (reported, not fatal):
//   display (graphical session), openpencil (op binaries), mcp:<server> (config).

export const CAPABILITY_SOURCES = {
  // Base: all roles.
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
  // Design.
  canvas: { tools: [], skills: ['diseno-web'], libs: ['openpencil.js'], needs: ['openpencil'] },
  assets: { tools: ['read_file', 'write_file'], skills: ['diseno-web'], libs: [] },
  // Copy.
  estilos: { tools: [], skills: ['copy-ventas'], libs: [] },
  // Marketing / sales.
  research: { tools: ['fetch_url'], skills: ['investigacion-web', 'marketing'], libs: [] },
  copy: { tools: [], skills: ['copy-ventas', 'marketing'], libs: [] },
  'outreach-lectura': { tools: ['fetch_url'], skills: ['ventas'], libs: [] },
  // Tester.
  'navegador-destructivo': { tools: ['open_url', 'fetch_url', 'run_cmd'], skills: ['pruebas'], libs: [], needs: ['display'] },
  screenshots: { tools: ['screenshot'], skills: ['pruebas'], libs: [], needs: ['display'] },
  'verificacion': { tools: ['run_cmd'], skills: ['pruebas', 'revision-codigo'], libs: ['verify.js'] },
  // Orchestrator.
  dispatch: { tools: [], skills: ['plan-dispatch'], libs: ['workforce.js'] },
  tracking: { tools: ['read_file', 'list_files'], skills: ['plan-dispatch'], libs: ['session-log.js'] },
  // Spawner.
  'crear-agentes': { tools: ['write_file'], skills: [], libs: ['agent-conventions.js'] },
  // Data / devops (master plan base roles).
  datos: { tools: ['run_cmd', 'read_file'], skills: ['terminal'], libs: ['verify.js'] },
  deploy: { tools: ['run_cmd', 'open_url'], skills: ['terminal'], libs: ['native-build.js'] },
  // Extended manos (09/11 integration). MCP: dynamic tools (mcp_<server>_<tool>
  // names only known with live servers) → tools: [] and
  // mcp:X needs that toolsForRole expands against the registry.
  'navegador-auto': { tools: ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_eval', 'browser_shot', 'browser_close'], skills: [], libs: [], needs: ['chrome'] },
  'canvas-real': { tools: ['canvas_abrir', 'canvas_tokens', 'canvas_codigo', 'canvas_cerrar'], skills: ['diseno-web'], libs: ['openpencil.js'], needs: ['openpencil'] },
  'outreach-borrador': { tools: ['outreach_draft'], skills: ['ventas', 'marketing', 'copy-ventas'], libs: [] },
  'outreach-envio': { tools: ['outreach_send'], skills: ['ventas'], libs: [], needs: ['tito-ok'] },
  'mcp-memoria': { tools: [], skills: [], libs: ['manos-mcp.js'], needs: ['mcp:memoria'] },
  'mcp-pensar': { tools: [], skills: [], libs: ['manos-mcp.js'], needs: ['mcp:pensar'] }
};

// GAPS: requests that do NOT exist in the repo/box. Documented here so nobody
// wires them as if they worked. Each gap says what would unblock it.
export const GAPS = [
  {
    pedido: 'outreach envío real (email/linkedin/dm)',
    realidad: 'outreach_draft + outreach_send con gate de Tito; send encola en outbox/*.ready.json, entrega manual v1',
    desbloquea: 'Tito define canal + credenciales para un conector real'
  },
  {
    pedido: 'búsqueda web vía MCP (brave)',
    realidad: 'sin BRAVE_API_KEY; cubierto por fetch_url + skill investigacion-web',
    desbloquea: 'Tito provee BRAVE_API_KEY y se suma server MCP de búsqueda'
  },
  {
    pedido: 'sequential-thinking @latest',
    realidad: 'pinneado a @2025.12.18: el latest (2026.8.31) llega roto (falta zod-to-json-schema)',
    desbloquea: 'fix upstream, re-probar latest y des-pinnear'
  }
];

export const BASE_CAPABILITIES = [
  'workspace-read',
  'workspace-write',
  'web',
  'memoria',
  'voz',
  'tiempo',
  'mcp-memoria'
];

// Role -> own-capabilities matrix (base is always added).
export const ROLE_MATRIX = {
  pablo: [],
  orquestador: ['research', 'dispatch', 'tracking', 'mcp-pensar'],
  spawner: ['crear-agentes'],
  backend: ['exec', 'tests', 'navegador-auto'],
  frontend: ['exec', 'navegador', 'preview', 'navegador-auto'],
  diseno: ['canvas', 'assets', 'canvas-real'],
  copy: ['estilos', 'copy', 'outreach-borrador'],
  marketing: ['research', 'copy', 'outreach-lectura', 'outreach-borrador', 'outreach-envio'],
  ventas: ['research', 'copy', 'outreach-lectura', 'outreach-borrador', 'outreach-envio'],
  data: ['datos'],
  devops: ['exec', 'deploy'],
  tester: ['navegador-destructivo', 'screenshots', 'verificacion', 'navegador-auto']
};

export function knownRoles() {
  return Object.keys(ROLE_MATRIX);
}

export function isKnownRole(rol) {
  return Object.hasOwn(ROLE_MATRIX, String(rol || '').trim().toLowerCase());
}

// Base + own, deduplicated, in stable order.
export function capabilitiesForRole(rol) {
  const key = String(rol || '').trim().toLowerCase();
  const propias = ROLE_MATRIX[key];
  if (!propias) {
    return [...BASE_CAPABILITIES];
  }
  return [...new Set([...BASE_CAPABILITIES, ...propias])];
}

// Concrete tools/skills a role can use (for the manos prompt and
// skill injection). needs are reported separately, not filtered: the role knows
// what may fail on it due to environment.
export function toolsForRole(rol, { mcpTools = null } = {}) {
  const out = [];
  const caps = capabilitiesForRole(rol);
  for (const cap of caps) {
    for (const t of CAPABILITY_SOURCES[cap]?.tools || []) {
      if (!out.includes(t)) {
        out.push(t);
      }
    }
  }
  // Dynamic MCP: each mcp:X need adds registered tools with the mcp_X_ prefix.
  // Without mcpTools (old tests, integrity) → statics only, untouched.
  if (Array.isArray(mcpTools)) {
    const registered = mcpTools.map((t) => t?.name).filter((n) => typeof n === 'string');
    const needs = new Set();
    for (const cap of caps) {
      for (const n of CAPABILITY_SOURCES[cap]?.needs || []) {
        needs.add(n);
      }
    }
    let anyMcpNeed = false;
    for (const n of needs) {
      const m = /^mcp:(.+)$/.exec(n);
      if (!m) continue;
      anyMcpNeed = true;
      const prefix = `mcp_${m[1]}_`;
      for (const name of registered) {
        if (name.startsWith(prefix) && !out.includes(name)) {
          out.push(name);
        }
      }
    }
    // F-05 diferido: con needs mcp, el rol puede buscar + usar cualquiera
    // que se registre on-demand (el loop valida 'mcp_*').
    if (anyMcpNeed) {
      if (!out.includes('mcp_search')) {
        out.push('mcp_search');
      }
      if (!out.includes('mcp_*')) {
        out.push('mcp_*');
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

// Does a capability resolve to real sources? tools/skills are checked against
// the passed inventories (default: the repo's real ones). libs are checked
// against the known server/lib module list.
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

// Walks the WHOLE matrix: returns phantom capabilities. Empty = sound.
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

// Which existing role already covers these capabilities? For zero duplicates: if
// the requested ones are a subset of a role's (base + own), that role covers.
// Returns the role name or null.
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

// Pure, no IO: does this product warrant a marketing/sales review before
// approval? Logic hook for track C (tester): if true, the Tester adds
// the monetization pass. Signals: sells, charges, is offered or competes.
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
