// F-02: workshop de skills — drafts + undo + dieta. Las skills vivas NO se
// tocan a mano: se proponen (draft), se validan (dieta) y se aprueban;
// cada cambio versiona para rollback. Todo bajo <skills>/.drafts y
// <skills>/.versions (loadSkills solo lee *.md top-level: invisibles).

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_BODY_MAX = 1500;
export const SKILL_KEYWORDS_MAX = 20;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const WORKSHOP_KEEP_VERSIONS = 5;

export function skillsDir() {
  return process.env.PABLO_SKILLS_DIR || process.env.SOFIA_SKILLS_DIR
    || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'skills');
}

function draftsDir(root = skillsDir()) {
  const d = join(root, '.drafts');
  mkdirSync(d, { recursive: true });
  return d;
}

function versionsDir(root = skillsDir()) {
  const d = join(root, '.versions');
  mkdirSync(d, { recursive: true });
  return d;
}

function toFrontMatter({ name, description, keywords, scope, body }) {
  const kw = (keywords || []).join(', ');
  return `---\nname: ${name}\ndescription: ${description}\nkeywords: ${kw}\nscope: ${scope}\n---\n${body}\n`;
}

// Dieta: devuelve issues[] (vacío = apta). Pura, testeable.
export function checkSkillDiet({ name, description, keywords, scope, body }) {
  const issues = [];
  if (!SKILL_NAME_RE.test(String(name || ''))) {
    issues.push('name inválido (minúsculas-números-guiones, 2..61)');
  }
  if (!String(description || '').trim()) {
    issues.push('description vacía');
  }
  const kw = Array.isArray(keywords) ? keywords : [];
  if (kw.length === 0) {
    issues.push('sin keywords (nadie la va a matchear)');
  }
  if (kw.length > SKILL_KEYWORDS_MAX) {
    issues.push(`demasiadas keywords (máx ${SKILL_KEYWORDS_MAX})`);
  }
  if (!String(scope || '').trim()) {
    issues.push('scope vacío (chat | work | all | role:x | agent:y)');
  }
  const b = String(body || '').trim();
  if (b.length < 50) {
    issues.push('body muy corto (<50ch: no enseña nada)');
  }
  if (b.length > SKILL_BODY_MAX) {
    issues.push(`body excede dieta (máx ${SKILL_BODY_MAX}ch)`);
  }
  return issues;
}

// Propone (o pisa) un draft. Valida dieta salvo {force:true}.
export function draftSkill(draft, { force = false, root = skillsDir() } = {}) {
  const data = {
    name: String(draft?.name || '').trim().toLowerCase(),
    description: String(draft?.description || '').trim(),
    keywords: (Array.isArray(draft?.keywords) ? draft.keywords : String(draft?.keywords || '').split(','))
      .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean),
    scope: String(draft?.scope || 'all').trim().toLowerCase(),
    body: String(draft?.body || '').trim()
  };
  const issues = checkSkillDiet(data);
  if (issues.length > 0 && !force) {
    return { ok: false, issues };
  }
  const abs = join(draftsDir(root), `${data.name}.md`);
  writeFileSync(abs, toFrontMatter(data), 'utf-8');
  return { ok: true, name: data.name, path: abs, forced: issues.length > 0 };
}

export function listDrafts(root = skillsDir()) {
  try {
    return readdirSync(draftsDir(root)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

export function readDraft(name, root = skillsDir()) {
  try {
    return readFileSync(join(draftsDir(root), `${name}.md`), 'utf-8');
  } catch {
    return null;
  }
}

export function rejectDraft(name, root = skillsDir()) {
  try {
    unlinkSync(join(draftsDir(root), `${name}.md`));
    return true;
  } catch {
    return false;
  }
}

// Aprueba: versiona la viva (si existe) y mueve el draft a live.
export function approveDraft(name, root = skillsDir()) {
  const clean = String(name || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(clean)) {
    return { ok: false, error: 'name inválido' };
  }
  const draftPath = join(draftsDir(root), `${clean}.md`);
  let content;
  try {
    content = readFileSync(draftPath, 'utf-8');
  } catch {
    return { ok: false, error: `draft inexistente: ${clean}` };
  }
  const livePath = join(root, `${clean}.md`);
  let versioned = null;
  try {
    const prev = readFileSync(livePath, 'utf-8');
    versioned = `${clean}.${Date.now()}.md`;
    writeFileSync(join(versionsDir(root), versioned), prev, 'utf-8');
    pruneVersions(clean, root);
  } catch {
    // No había viva: alta nueva, nada que versionar.
  }
  writeFileSync(livePath, content, 'utf-8');
  unlinkSync(draftPath);
  return { ok: true, name: clean, path: livePath, versioned };
}

export function skillVersions(name, root = skillsDir()) {
  const clean = String(name || '').trim().toLowerCase();
  try {
    return readdirSync(versionsDir(root))
      .filter((f) => f.startsWith(`${clean}.`) && f.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

function pruneVersions(name, root) {
  const versions = skillVersions(name, root);
  while (versions.length > WORKSHOP_KEEP_VERSIONS) {
    const oldest = versions.shift();
    try {
      unlinkSync(join(versionsDir(root), oldest));
    } catch { /* best-effort */ }
  }
}

// Undo: restaura la versión anterior más reciente a live.
export function rollbackSkill(name, root = skillsDir()) {
  const clean = String(name || '').trim().toLowerCase();
  const versions = skillVersions(clean, root);
  if (versions.length === 0) {
    return { ok: false, error: `sin versiones: ${clean}` };
  }
  const latest = versions[versions.length - 1];
  let content;
  try {
    content = readFileSync(join(versionsDir(root), latest), 'utf-8');
  } catch {
    return { ok: false, error: `versión ilegible: ${latest}` };
  }
  // La viva actual se versiona antes de pisar (el undo también es undoable).
  try {
    const current = readFileSync(join(root, `${clean}.md`), 'utf-8');
    writeFileSync(join(versionsDir(root), `${clean}.${Date.now()}.md`), current, 'utf-8');
    pruneVersions(clean, root);
  } catch { /* alta sin viva previa */ }
  writeFileSync(join(root, `${clean}.md`), content, 'utf-8');
  return { ok: true, name: clean, restored: latest };
}
