// Memoria estilo OpenClaw para Pablo: SOUL/USER/MEMORY/daily/AGENTS por empresa.
// Vive en <workspace>/<empresa>/memoria/ (misma raíz que WORKSPACE_ROOT de
// workforce.js), con override PABLO_MEMORY_DIR para tests y despliegues.
//
// Lecturas con caché de 30s (patrón skills.js). Faltantes devuelven null,
// nunca throw. Solo este módulo toca estos archivos.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { rootDir } from './config.js';

const CACHE_TTL_MS = 30000;
const cache = new Map(); // ruta absoluta -> { content, at }

// Presupuesto default de render: cubre SOUL+USER+MEMORY+daily corto (~3.2k
// los seeds; ship 09/11: 1200 dejaba las directivas de USER.md afuera).
// Lo episódico pesado (learnings) tiene su propio presupuesto aparte.
export const DEFAULT_RENDER_BUDGET = 3600;

// Cola máxima del daily (D1): el log de hoy nunca puede comerse el
// presupuesto entero y dejar la identidad afuera. Se queda con lo ÚLTIMO
// (lo reciente es lo que importa) y el resto es para SOUL/USER/MEMORY.
export const DAILY_TAIL_MAX_CHARS = 800;

// Nombres escribibles. Todo lo demás se rechaza: no hay subpaths ni escapes.
const ALLOWLIST = new Set(['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md']);

// Misma resolución que WORKSPACE_ROOT (workforce.js): env primero, después el
// workspace del repo. PABLO_MEMORY_DIR gana cuando existe (tests, overrides).
// Se lee en cada llamada (no cacheado en módulo) para que los tests puedan
// apuntar a un tmpdir con solo setear el env.
function baseRoot() {
  return resolve(process.env.PABLO_MEMORY_DIR || process.env.WORKSPACE_ROOT || join(rootDir, 'workspace'));
}

// Dir de memoria de una empresa: <base>/<slug>/memoria. El slug es un solo
// segmento: cualquier intento de traversal tira.
export function memoryDirFor(companySlug) {
  const slug = String(companySlug || '').trim();
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error(`Empresa inválida: ${companySlug}`);
  }
  return join(baseRoot(), slug, 'memoria');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.content;
  }
  cache.delete(key);
  return undefined;
}

function readFileCached(absPath) {
  const hit = cacheGet(absPath);
  if (hit !== undefined) {
    return hit;
  }
  let content = null;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    // Faltante o ilegible: null, nunca throw.
    content = null;
  }
  cache.set(absPath, { content, at: Date.now() });
  return content;
}

// Lee un archivo de memoria. Nombre fuera de allowlist o archivo faltante
// devuelven null, nunca throw.
export function readMemoryFile(companySlug, name) {
  const clean = String(name || '').trim();
  if (!ALLOWLIST.has(clean)) {
    return null;
  }
  return readFileCached(join(memoryDirFor(companySlug), clean));
}

// Escribe un archivo de memoria (crea el dir). Nombre inválido tira.
export function writeMemoryFile(companySlug, name, content) {
  const clean = String(name || '').trim();
  if (!ALLOWLIST.has(clean) || clean.includes('/') || clean.includes('..')) {
    throw new Error(`Nombre de memoria inválido: ${name}`);
  }
  const dir = memoryDirFor(companySlug);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, clean);
  writeFileSync(abs, String(content ?? ''), 'utf-8');
  cache.delete(abs);
  return abs;
}

// Fecha local (no UTC): el daily log sigue el día de Tito, no el de Greenwich.
export function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Agrega una entrada al daily de hoy (memory/YYYY-MM-DD.md), creando el dir.
export function appendDaily(companySlug, text) {
  const dir = join(memoryDirFor(companySlug), 'memory');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${todayStamp()}.md`);
  appendFileSync(abs, `${String(text || '').trimEnd()}\n`, 'utf-8');
  cache.delete(abs);
  return abs;
}

// Lee un daily por fecha (default hoy). Formato inválido o faltante: null.
export function readDaily(companySlug, stamp = todayStamp()) {
  const clean = String(stamp || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return null;
  }
  return readFileCached(join(memoryDirFor(companySlug), 'memory', `${clean}.md`));
}

// Sección de memoria para el system prompt: SOUL + USER + MEMORY + hoy, en ese
// orden, recortada por presupuesto duro de caracteres. AGENTS.md no se inyecta:
// son convenciones de escritura para agentes con archivos, no para la voz.
// Empresa sin memoria devuelve '' (cero tokens, cero drama).
// Recorte POR PARTE (D1), de atrás hacia adelante: el daily cae primero
// (además va acotado a la cola de DAILY_TAIL_MAX_CHARS), la identidad SOUL
// última. Nunca un slice ciego que decapite lo importante.
export function renderMemorySection(companySlug, { maxChars = DEFAULT_RENDER_BUDGET } = {}) {
  const budget = Math.max(0, Number(maxChars) || 0);
  if (budget <= 0) {
    return '';
  }
  const soul = readMemoryFile(companySlug, 'SOUL.md') || '';
  const user = readMemoryFile(companySlug, 'USER.md') || '';
  const memory = readMemoryFile(companySlug, 'MEMORY.md') || '';
  const daily = readDaily(companySlug) || '';
  const blocks = [];
  if (soul.trim()) {
    blocks.push({ head: 'PABLO SOUL (who I am, how I talk):', body: soul.trim() });
  }
  if (user.trim()) {
    blocks.push({ head: 'PABLO USER (standing directives from Tito):', body: user.trim() });
  }
  if (memory.trim()) {
    blocks.push({ head: 'PABLO MEMORY (durable facts):', body: memory.trim() });
  }
  if (daily.trim()) {
    blocks.push({ head: `PABLO TODAY (${todayStamp()}, daily log):`, body: daily.trim().slice(-DAILY_TAIL_MAX_CHARS) });
  }
  if (blocks.length === 0) {
    return '';
  }
  const totalLen = () => blocks.reduce((n, b) => n + b.head.length + 1 + b.body.length, 0) + Math.max(0, blocks.length - 1) * 2;
  const render = () => blocks.map((b) => `${b.head}\n${b.body}`).join('\n\n');
  if (totalLen() <= budget) {
    return render();
  }
  // Achicar desde la última parte: primero se recorta el cuerpo (con marca
  // …), y si ni el header entra, la parte entera sale.
  let over = totalLen() - budget;
  while (blocks.length > 1 && over > 0) {
    const last = blocks[blocks.length - 1];
    if (last.body.length > over + 1) {
      last.body = `${last.body.slice(0, last.body.length - over - 1).trimEnd()}…`;
      over = 0;
    } else {
      blocks.pop();
      over = totalLen() - budget;
    }
  }
  if (blocks.length === 1 && totalLen() > budget) {
    const solo = blocks[0];
    const room = budget - solo.head.length - 1;
    solo.body = room > 1 ? `${solo.body.slice(0, room - 1).trimEnd()}…` : '';
    if (room <= 1) {
      return solo.head.slice(0, budget);
    }
  }
  return render();
}

// Solo tests.
export function __resetPabloMemoryCache() {
  cache.clear();
}

// HOOK-SHIP: cómo enchufar esta memoria al prompt (lo implementa el ship, este
// archivo es ajeno a agent-runtime.js — NO tocar runtime desde acá).
//
// DÓNDE: buildSystemInstruction() en server/lib/agent-runtime.js (def línea
// ~674). El bloque de learnings vive en ~724-725:
//
//   const learningsBlock = context.learningsSection
//     ? [context.learningsSection, '']
//     : [];
//
// y se expande en el return en ~747, justo antes del '---' de tareas:
//
//   ...boundariesBlock,
//   ...learningsBlock,
//   '---',
//
// SNIPPET (agregar junto al learningsBlock, ~724):
//
//   const memoryBlock = context.memorySection
//     ? [context.memorySection, '']
//     : [];
//
// y en el return, ANTES de ...learningsBlock:
//
//   ...boundariesBlock,
//   ...memoryBlock,      // <-- identidad y directivas primero
//   ...learningsBlock,   // <-- episódico después
//   '---',
//
// QUIÉN PASA memorySection: los tres promptContext que hoy pasan
// learningsSection — meeting-session.js líneas ~267 y ~306, y el preview HTTP
// en http.js línea ~343:
//
//   memorySection: renderMemorySection(this.company?.id || 'pablo', { maxChars: 3600 }),
//   // http.js: renderMemorySection(agent.companyId || 'pablo', { maxChars: 3600 })
//
// PRESUPUESTO: 3600 chars (~900 tokens). 1200 NO alcanzaba: el SOUL seed solo
// ya mide ~1.6k y las directivas de USER.md quedaban afuera del prompt (ship
// 09/11, verificado por prompt-preview). Con 3600 entran SOUL+USER+MEMORY+daily
// corto; si el daily crece, el recorte cae sobre él (va último), nunca sobre
// identidad y directivas. Los learnings keeps su propio presupuesto (4800) aparte.
// ORDEN: memoria ANTES que learnings — quién es y qué quiere Tito precede a lo
// episódico de reuniones pasadas.
