// Convenciones por agente: cada agente de la reunión tiene su propio
// `workspace/<empresa>/agentes/<agentId>/AGENTS.md` con sus convenciones de
// trabajo. Se crea (seed por rol) si falta; un fragmento corto (~15 líneas,
// ≤900ch) se inyecta en SU system prompt y en el de nadie más.
//
// Patrón pablo-memory.js: misma raíz de workspace, caché 30s, faltantes
// devuelven null/vacío, nunca throw. Presupuesto dieta: el fragmento no
// puede pasar de CONVENTIONS_MAX_CHARS.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { rootDir } from './config.js';

export const CONVENTIONS_MAX_LINES = 15;
export const CONVENTIONS_MAX_CHARS = 900;
const CACHE_TTL_MS = 30000;
const cache = new Map(); // ruta absoluta -> { content, at }

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

// Dir del agente: <base>/<empresa>/agentes/<agentId>
export function agentDirFor(companySlug, agentId) {
  return join(baseRoot(), cleanSegment(companySlug, 'Empresa'), 'agentes', cleanSegment(agentId, 'Agente'));
}

export function conventionsPathFor(companySlug, agentId) {
  return join(agentDirFor(companySlug, agentId), 'AGENTS.md');
}

// Templates por rol: convenciones de TRABAJO propias, no personalidad (eso
// ya vive en style/knowledge/craft del perfil) ni reglas de sala (viven en
// §VOICE del system). Cortos a propósito: el sistema los inyecta enteros.
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
  ].join('\n')
};

export function seedForRole(role, name) {
  const key = String(role || '').trim().toLowerCase();
  const build = ROLE_TEMPLATES[key] || ROLE_TEMPLATES.worker;
  return build(name || 'agente');
}

// Crea el AGENTS.md del agente si falta (seed por rol + nombre).
// Devuelve { created: bool, path }. Nunca lanza.
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
      // Falta: se crea desde el seed.
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

// Fragmento para el system prompt de ESE agente: top ~15 líneas, ≤900ch.
// Sin archivo o ilegible → '' (el turno sigue igual).
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

// Solo tests.
export function __resetConventionsCache() {
  cache.clear();
}
