// Per-agent conventions: each meeting agent has its own
// `workspace/<empresa>/agentes/<agentId>/AGENTS.md` with its working
// conventions. Created (seeded by role) if missing; a short fragment (~15 lines,
// ≤900ch) is injected into ITS system prompt and nobody else's.
//
// pablo-memory.js pattern: same workspace root, 30s cache, missing entries
// return null/empty, never throw. Diet budget: the fragment must not
// exceed CONVENTIONS_MAX_CHARS.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { rootDir } from './config.js';

export const CONVENTIONS_MAX_LINES = 15;
export const CONVENTIONS_MAX_CHARS = 900;
const CACHE_TTL_MS = 30000;
const cache = new Map(); // absolute path -> { content, at }

function baseRoot() {
  return resolve(process.env.PABLO_MEMORY_DIR || process.env.WORKSPACE_ROOT || join(rootDir, 'workspace'));
}

function cleanSegment(value, label) {
  const clean = String(value || '').trim();
  if (!clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) {
    throw new Error(`${label} inválido: ${value}`);
  }
  return clean;
}

// Agent dir: <base>/<empresa>/agentes/<agentId>
export function agentDirFor(companySlug, agentId) {
  return join(baseRoot(), cleanSegment(companySlug, 'Empresa'), 'agentes', cleanSegment(agentId, 'Agente'));
}

export function conventionsPathFor(companySlug, agentId) {
  return join(agentDirFor(companySlug, agentId), 'AGENTS.md');
}

// Templates by role: their own WORK conventions, not personality (that
// already lives in the profile's style/knowledge/craft) nor room rules (they live
// in the system's §VOICE). Short on purpose: the system injects them whole.
const ROLE_TEMPLATES = {
  ceo: (name) => [
    `# AGENTS.md — ${name} (coordina)`,
    '',
    '- Coordinás: repartís diciendo quién hace qué y por qué; las tareas van a quien las hace, nunca a vos.',
    '- Confirmás el objetivo en una frase con tus palabras antes de repartir.',
    '- Si algo no se puede todavía, lo decís en una línea y proponés el siguiente paso.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera (mensajes, posteos) sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  worker: (name) => [
    `# AGENTS.md — ${name} (produce)`,
    '',
    '- Producís ARCHIVOS en la carpeta del proyecto: un archivo con un dueño.',
    '- Antes de escribir, mirás lo que ya existe (leés, no adivinás).',
    '- Ningún pedido se da por hecho hasta que sus checks pasan con evidencia real.',
    '- Si te trabás, rodeás y seguís; el bloqueo se reporta con evidencia, nunca un "falló" pelado.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  contratista: (name) => [
    `# AGENTS.md — ${name} (refina)`,
    '',
    '- Refinás lo que otros producen: revisión, criterio y detalle, no entregables propios.',
    '- Cada observación trae propuesta concreta; objetar sin alternativa se descarta.',
    '- No prometés fechas sin chequear el estado real.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  // Track B (team flow): specialist-role seeds. Same
  // budget (≤15 lines, ≤900ch) and same workspace rules.
  pablo: (name) => [
    `# AGENTS.md — ${name} (interfaz)`,
    '',
    '- Hablás con Tito: preguntás lo que falta, armás el brief, se lo pasás al Orquestador.',
    '- En llamadas escuchás; intervenís si Tito te habla o si hay desvío del brief.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  orquestador: (name) => [
    `# AGENTS.md — ${name} (dirige)`,
    '',
    '- Planificás meticuloso: fases, dependencias, done-criteria medibles; investigás pre-hecho antes de pedir laburo.',
    '- Repartís tareas con dueño y criterio de done; pedís roles al Spawner si faltan.',
    '- Trackeás progreso y re-planificás ante bloqueos; un rechazo con motivo se atiende, no se ignora.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  spawner: (name) => [
    `# AGENTS.md — ${name} (crea)`,
    '',
    '- Creás especialistas bajo demanda: ficha + skills + tools + registro de capabilities.',
    '- Cero duplicados: si un rol existente cubre el pedido, respondés con el existente.',
    '- Rechazás con motivo claro si el rol no tiene sentido; en grupal solo anunciás ("sumé a X").',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  backend: (name) => [
    `# AGENTS.md — ${name} (backend)`,
    '',
    '- Producís lógica y datos: código que corre, verificado con comandos reales, no a ojo.',
    '- Antes de escribir, mirás lo que ya existe (leés, no adivinás).',
    '- Ningún pedido se da por hecho hasta que sus checks pasan con evidencia real.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  frontend: (name) => [
    `# AGENTS.md — ${name} (frontend)`,
    '',
    '- Producís interfaz que abre y responde: la probás abriéndola de verdad, no imaginándola.',
    '- Consumís los tokens del diseño si existen; no reinterpretás la intención visual.',
    '- Responsive desde el arranque: angosto (360px) antes de dar por hecho un layout.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  diseno: (name) => [
    `# AGENTS.md — ${name} (diseño)`,
    '',
    '- Diseñás en el archivo de diseño real (.op + tokens), no escribiendo theme.js a mano.',
    '- Contrato visual primero: 1 dominante, 1 acento, 1 fondo, 2 fuentes máximo.',
    '- El handoff es el archivo: el dev consume tus tokens, no adivina tu intención.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  copy: (name) => [
    `# AGENTS.md — ${name} (textos)`,
    '',
    '- Escribís textos claros: beneficio concreto, sin humo ni superlativos vacíos.',
    '- Un mensaje por pantalla; un solo llamado a la acción visible por sección.',
    '- Anticipás la duda más obvia del lector y la respondés en una línea.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  marketing: (name) => [
    `# AGENTS.md — ${name} (marketing)`,
    '',
    '- Definís propuesta de valor, posicionamiento y canal con datos, no con corazonadas.',
    '- Cada pieza trae su métrica: qué mide éxito y cómo se verifica.',
    '- Investigás mercado y competencia citando fuentes; nunca inventás datos.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  ventas: (name) => [
    `# AGENTS.md — ${name} (ventas)`,
    '',
    '- Vendés con discovery: necesidad real del comprador antes que pitch.',
    '- Objeciones con respuesta concreta; propuesta con precio y siguiente paso claros.',
    '- NUNCA contactás a nadie real ni enviás nada sin el OK explícito de Tito.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  data: (name) => [
    `# AGENTS.md — ${name} (datos)`,
    '',
    '- Trabajás datos reales: consultas y scripts que corren, resultados verificables.',
    '- Citás fuente de cada número; un número sin fuente no existe.',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  devops: (name) => [
    `# AGENTS.md — ${name} (infra)`,
    '',
    '- Automatizás build y deploy: comandos repetibles, verificados corriéndolos.',
    '- Nada se da por desplegado hasta que responde de verdad (URL/archivo vivo).',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n'),
  tester: (name) => [
    `# AGENTS.md — ${name} (testea)`,
    '',
    '- Testeás como cada receptor posible: usuario, comprador, ingeniero; visual + funcional + romper.',
    '- Cada hallazgo trae severidad y pasos para reproducir; lo limpio se aprueba con evidencia.',
    '- Si el producto puede vender, sumás la pasada de monetización (marketing/ventas revisan).',
    '- Escribís solo dentro de `workspace/<empresa>/…`; nada fuera del workspace.',
    '- Reporte corto: el hecho, después qué significa. 1-2 frases.',
    '- Nunca enviás nada afuera sin el OK explícito de Tito.',
    '- Nunca guardás secretos en archivos: rutas y últimos 4, nada más.'
  ].join('\n')
};

export function seedForRole(role, name) {
  const key = String(role || '').trim().toLowerCase();
  const build = ROLE_TEMPLATES[key] || ROLE_TEMPLATES.worker;
  return build(name || 'agente');
}

// Creates the agent's AGENTS.md if missing (seed by role + name).
// Returns { created: bool, path }. Never throws.
export function ensureAgentConventions(companySlug, agent) {
  try {
    const agentId = agent?.id;
    if (!agentId) {
      return { created: false, path: null };
    }
    const abs = conventionsPathFor(companySlug, agentId);
    try {
      readFileSync(abs, 'utf-8');
      return { created: false, path: abs };
    } catch {
      // Missing: created from the seed.
    }
    mkdirSync(agentDirFor(companySlug, agentId), { recursive: true });
    writeFileSync(abs, `${seedForRole(agent?.role, agent?.name)}\n`, 'utf-8');
    cache.delete(abs);
    return { created: true, path: abs };
  } catch {
    return { created: false, path: null };
  }
}

function readCached(abs) {
  const hit = cache.get(abs);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.content;
  }
  let content = null;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    content = null;
  }
  cache.set(abs, { content, at: Date.now() });
  return content;
}

// Fragment for THAT agent's system prompt: top ~15 lines, ≤900ch.
// No file or unreadable → '' (the turn continues unchanged).
export function renderAgentConventions(companySlug, agent, { maxLines = CONVENTIONS_MAX_LINES, maxChars = CONVENTIONS_MAX_CHARS } = {}) {
  try {
    if (!agent?.id) {
      return '';
    }
    const raw = readCached(conventionsPathFor(companySlug, agent.id));
    if (!raw?.trim()) {
      return '';
    }
    const lines = raw.trim().split('\n').slice(0, maxLines).join('\n').trim();
    const head = lines.length > maxChars ? `${lines.slice(0, maxChars - 1).trimEnd()}…` : lines;
    return [
      `CONVENCIONES DE ${String(agent.name || 'agente').toUpperCase()} (solo tuyas, no las cites):`,
      head
    ].join('\n');
  } catch {
    return '';
  }
}

// Tests only.
export function __resetConventionsCache() {
  cache.clear();
}
