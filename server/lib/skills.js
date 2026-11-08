// Skills estilo SKILL.md (OpenClaw/opencode): conocimiento reutilizable que se
// inyecta al prompt cuando el turno lo pide. Formato:
//
//   ---
//   name: investigacion-web
//   description: Buscar y citar información de la web.
//   keywords: buscar, precio, docs, documentación, web, investigar
//   scope: all            (chat | work | all)
//   ---
//   <cuerpo markdown breve, imperativo>
//

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    body: match[2].trim().slice(0, 4000)
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

export function matchSkills(text, { scope = 'chat', max = 2 } = {}) {
  const skills = loadSkills().filter((s) => s.scope === 'all' || s.scope === scope);
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

export function renderSkillsSection(text, { scope = 'chat', max = 2 } = {}) {
  const matched = matchSkills(text, { scope, max });
  if (matched.length === 0) {
    return '';
  }
  return [
    'CONOCIMIENTO APLICABLE (skills, seguilo al pie de la letra):',
    ...matched.map((s) => `### ${s.name}\n${s.body}`),
    ''
  ].join('\n');
}

export function listSkillNames() {
  return loadSkills().map((s) => s.name);
}

// Solo tests.
export function __resetSkillsCache() {
  cache = null;
  cachedAt = 0;
}
