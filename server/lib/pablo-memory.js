// OpenClaw-style memory for Pablo: SOUL/USER/MEMORY/daily/AGENTS per company.
// Lives in <workspace>/<company>/memoria/ (same root as workforce.js
// WORKSPACE_ROOT), with a PABLO_MEMORY_DIR override for tests and deploys.
//
// Reads with a 30s cache (skills.js pattern). Missing files return null,
// never throw. Only this module touches these files.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { rootDir } from './config.js';

const CACHE_TTL_MS = 30000;
const cache = new Map(); // ruta absoluta -> { content, at }

// Default render budget: covers SOUL+USER+MEMORY+short daily (~3.2k
// for the seeds; ship 09/11: 1200 left the USER.md directives out).
// Heavy episodic stuff (learnings) has its own separate budget.
export const DEFAULT_RENDER_BUDGET = 3600;

// Daily tail cap (D1): today's log can never eat the
// whole budget and leave identity out. It keeps the LAST part
// (recent is what matters) and the rest is for SOUL/USER/MEMORY.
export const DAILY_TAIL_MAX_CHARS = 800;

// Writable names. Everything else is rejected: no subpaths or escapes.
const ALLOWLIST = new Set(['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md']);

// Same resolution as WORKSPACE_ROOT (workforce.js): env first, then the
// repo workspace. PABLO_MEMORY_DIR wins when set (tests, overrides).
// Read on every call (not cached at module level) so tests can
// point at a tmpdir by just setting the env.
function baseRoot() {
  return resolve(process.env.PABLO_MEMORY_DIR || process.env.WORKSPACE_ROOT || join(rootDir, 'workspace'));
}

// One company's memory dir: <base>/<slug>/memoria. The slug is a single
// segment: any traversal attempt throws.
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
    // Missing or unreadable: null, never throw.
    content = null;
  }
  cache.set(absPath, { content, at: Date.now() });
  return content;
}

// Reads one memory file. Off-allowlist names or missing files
// return null, never throw.
export function readMemoryFile(companySlug, name) {
  const clean = String(name || '').trim();
  if (!ALLOWLIST.has(clean)) {
    return null;
  }
  return readFileCached(join(memoryDirFor(companySlug), clean));
}

// Writes one memory file (creates the dir). Invalid name throws.
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

// Local date (not UTC): the daily log follows Tito's day, not Greenwich's.
export function todayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Appends an entry to today's daily (memory/YYYY-MM-DD.md), creating the dir.
export function appendDaily(companySlug, text) {
  const dir = join(memoryDirFor(companySlug), 'memory');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${todayStamp()}.md`);
  appendFileSync(abs, `${String(text || '').trimEnd()}\n`, 'utf-8');
  cache.delete(abs);
  return abs;
}

// Reads one daily by date (default today). Invalid format or missing: null.
export function readDaily(companySlug, stamp = todayStamp()) {
  const clean = String(stamp || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return null;
  }
  return readFileCached(join(memoryDirFor(companySlug), 'memory', `${clean}.md`));
}

// Memory section for the system prompt: SOUL + USER + MEMORY + today, in that
// order, trimmed by a hard char budget. AGENTS.md is not injected:
// it holds writing conventions for file-wielding agents, not for voice.
// A company without memory returns '' (zero tokens, zero drama).
// PER-PART trimming (D1), back to front: the daily drops first
// (also capped to the DAILY_TAIL_MAX_CHARS tail), SOUL identity
// last. Never a blind slice that beheads what matters.
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
  // Shrink from the last part: first trim the body (with a …
  // marker), and when not even the header fits, drop the whole part.
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

// Tests only.
export function __resetPabloMemoryCache() {
  cache.clear();
}

// HOOK-SHIP: how to plug this memory into the prompt (implemented by the ship;
// this file is foreign to agent-runtime.js — do NOT touch runtime from here).
//
// WHERE: buildSystemInstruction() in server/lib/agent-runtime.js (def line
// ~674). The learnings block lives at ~724-725:
//
//   const learningsBlock = context.learningsSection
//     ? [context.learningsSection, '']
//     : [];
//
// and it expands in the return at ~747, just before the tasks '---':
//
//   ...boundariesBlock,
//   ...learningsBlock,
//   '---',
//
// SNIPPET (add next to learningsBlock, ~724):
//
//   const memoryBlock = context.memorySection
//     ? [context.memorySection, '']
//     : [];
//
// and in the return, BEFORE ...learningsBlock:
//
//   ...boundariesBlock,
//   ...memoryBlock,      // <-- identity and directives first
//   ...learningsBlock,   // <-- episodic after
//   '---',
//
// WHO PASSES memorySection: the three promptContexts that today pass
// learningsSection — meeting-session.js lines ~267 and ~306, and the HTTP preview
// in http.js line ~343:
//
//   memorySection: renderMemorySection(this.company?.id || 'pablo', { maxChars: 3600 }),
//   // http.js: renderMemorySection(agent.companyId || 'pablo', { maxChars: 3600 })
//
// BUDGET: 3600 chars (~900 tokens). 1200 was NOT enough: the SOUL seed alone
// already measures ~1.6k and the USER.md directives were left out of the prompt
// (ship 09/11, verified via prompt-preview). With 3600, SOUL+USER+MEMORY+short
// daily fit; when the daily grows, trimming hits it (it goes last), never
// identity and directives. Learnings keep their own budget (4800) separate.
// ORDER: memory BEFORE learnings — who he is and what Tito wants comes before
// the episodic past-meeting stuff.
