// Skills estilo SKILL.md (OpenClaw/opencode): conocimiento reutilizable que se
// inyecta al prompt cuando el turno lo pide. Formato:
//
//   ---
//   name: investigacion-web
//   description: Buscar y citar información de la web.
//   keywords: buscar, precio, docs, documentación, web, investigar
//   scope: all            (chat | work | all, más lista con comas:
//                          role:<rol> | agent:<id> para skills por agente)
//   ---
//   <cuerpo markdown breve, imperativo>
//

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTtsLanguage } from './settings.js';

const SKILLS_DIR = process.env.PABLO_SKILLS_DIR || process.env.SOFIA_SKILLS_DIR
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'skills');

let cache = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30000;

function parseSkill(filename, raw) {
  const match = String(raw).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  const name = meta.name || filename.replace(/\.md$/, '');
  return {
    name,
    description: meta.description || '',
    keywords: (meta.keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
    scope: (meta.scope || 'all').toLowerCase(),
    // Entradas del scope (lista con comas): 'all', 'chat', 'work',
    // 'role:<rol>', 'agent:<id>'. Desconocidas se ignoran al matchear.
    scopes: (meta.scope || 'all').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
    body: match[2].trim().slice(0, 1500) // D6: cuerpo acotado (antes 4000)
  };
}

export function loadSkills(dir = SKILLS_DIR) {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_TTL_MS) {
    return cache;
  }
  const skills = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) {
        continue;
      }
      try {
        const skill = parseSkill(file, readFileSync(join(dir, file), 'utf-8'));
        if (skill?.body) {
          skills.push(skill);
        }
      } catch {
        // Skill rota: se salta, no rompe el turno.
      }
    }
  } catch {
    // Sin directorio: cero skills, cero drama.
  }
  cache = skills;
  cachedAt = now;
  return skills;
}

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ' ');
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function scoreSkill(skill, words) {
  let score = 0;
  const hay = `${skill.name} ${skill.description} ${skill.keywords.join(' ')}`;
  const hayWords = normalize(hay).split(/\s+/).filter((w) => w.length > 2);
  const haySet = new Set(hayWords);
  for (const word of words) {
    if (haySet.has(word)) {
      score += word.length > 5 ? 2 : 1;
      continue;
    }
    // Conjugaciones: "compila" casa con keyword "compilar".
    if (word.length >= 5 && hayWords.some((h) => h.length >= 5 && commonPrefix(h, word) >= 5)) {
      score += 1;
    }
  }
  // Bonus si el nombre matchea directo (mención explícita).
  if (normalize(skill.name).split(/[-_\s]+/).some((part) => part.length > 3 && words.has(part))) {
    score += 3;
  }
  return score;
}

// ¿La skill le toca a este turno/agente? Sin agent: conducta histórica
// (scope 'all' o == scope del turno; skills solo rol/agente NO matchean).
// Con agent { id, role }: además matchean 'role:<rol>' y 'agent:<id>'.
export function skillAppliesTo(skill, scope, agent = null) {
  const entries = Array.isArray(skill.scopes) && skill.scopes.length > 0
    ? skill.scopes
    : [skill.scope];
  const agentId = String(agent?.id || '').trim().toLowerCase();
  const agentRole = String(agent?.role || '').trim().toLowerCase();
  for (const entry of entries) {
    if (entry === 'all' || entry === scope) {
      return true;
    }
    if (entry.startsWith('role:') && agentRole && entry.slice(5).trim() === agentRole) {
      return true;
    }
    if (entry.startsWith('agent:') && agentId && entry.slice(6).trim() === agentId) {
      return true;
    }
  }
  return false;
}

export function matchSkills(text, { scope = 'chat', max = 2, agent = null } = {}) {
  const skills = loadSkills().filter((s) => skillAppliesTo(s, scope, agent));
  if (skills.length === 0) {
    return [];
  }
  const words = new Set(normalize(text).split(/\s+/).filter((w) => w.length > 2));
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.skill);
}

export function renderSkillsSection(text, { scope = 'chat', max = 2, agent = null } = {}) {
  const matched = matchSkills(text, { scope, max, agent });
  if (matched.length === 0) {
    return '';
  }
  const en = scope !== 'work' && String(getTtsLanguage() || 'en').toLowerCase().startsWith('en');
  // Techo total D6: 2 skills × cuerpo ya acotado no pueden pasar de 1500ch
  // en el prompt del turno (peor caso viejo: 8000ch). La 2ª se recorta o cae.
  const SKILLS_TOTAL_MAX = 1500;
  const bodies = [];
  let used = 0;
  for (const s of matched) {
    const chunk = `### ${s.name}\n${s.body}`;
    if (used + chunk.length > SKILLS_TOTAL_MAX) {
      const room = SKILLS_TOTAL_MAX - used;
      if (room > s.name.length + 8 && bodies.length === 0) {
        bodies.push(`${chunk.slice(0, room - 1).trimEnd()}…`);
      }
      break;
    }
    bodies.push(chunk);
    used += chunk.length;
  }
  if (bodies.length === 0) {
    return '';
  }
  return [
    en
      ? 'APPLICABLE KNOWLEDGE (skills — follow to the letter):'
      : 'CONOCIMIENTO APLICABLE (skills, seguilo al pie de la letra):',
    ...bodies,
    ''
  ].join('\n');
}

export function listSkillNames() {
  return loadSkills().map((s) => s.name);
}

// Track B (flujo de equipo): skills inyectables para un rol — las que le
// aplican por scope (all o role:<rol>). Aditivo: usa loadSkills +
// skillAppliesTo existentes, no cambia su conducta.
export function skillsForRole(rol) {
  const agent = { id: null, role: String(rol || '').trim().toLowerCase() };
  // Aplica si le toca en ALGÚN turno (chat o work): cubre scopes 'all',
  // 'chat', 'work', 'role:<rol>' y 'agent:<id>' sin cambiar su semántica.
  return loadSkills()
    .filter((s) => skillAppliesTo(s, 'chat', agent) || skillAppliesTo(s, 'work', agent))
    .map((s) => s.name);
}

// Solo tests.
export function __resetSkillsCache() {
  cache = null;
  cachedAt = 0;
}
