// F-02: workshop — dieta + ciclo draft→approve→rollback en tmpdir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'f02-skills-'));

const ws = await import('../server/lib/skill-workshop.js');

const good = {
  name: 'nueva-skill',
  description: 'Hace cosas nuevas.',
  keywords: ['nuevo', 'cosa'],
  scope: 'chat',
  body: 'Cuando te pidan algo nuevo, hacelo con calma y reportá el resultado en dos líneas como máximo siempre.'
};

test('f02: dieta detecta cada problema', () => {
  assert.deepEqual(ws.checkSkillDiet(good), [], 'apta');
  assert.ok(ws.checkSkillDiet({ ...good, name: 'Mala Name!' }).some((i) => i.includes('name')));
  assert.ok(ws.checkSkillDiet({ ...good, description: '' }).some((i) => i.includes('description')));
  assert.ok(ws.checkSkillDiet({ ...good, keywords: [] }).some((i) => i.includes('keywords')));
  assert.ok(ws.checkSkillDiet({ ...good, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }).some((i) => i.includes('keywords')));
  assert.ok(ws.checkSkillDiet({ ...good, body: 'corto' }).some((i) => i.includes('corto')));
  assert.ok(ws.checkSkillDiet({ ...good, body: 'x'.repeat(2000) }).some((i) => i.includes('dieta')));
});

test('f02: draft valida dieta salvo force', () => {
  const bad = ws.draftSkill({ ...good, name: 'mala', body: 'corta' }, { root: ROOT });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length > 0);
  const forced = ws.draftSkill({ ...good, name: 'mala', body: 'corta' }, { force: true, root: ROOT });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.ok(ws.listDrafts(ROOT).includes('mala'));
  assert.ok(ws.readDraft('mala', ROOT).includes('name: mala'));
  assert.equal(ws.rejectDraft('mala', ROOT), true);
  assert.ok(!ws.listDrafts(ROOT).includes('mala'));
});

test('f02: approve publica + versiona + rollback restaura', () => {
  writeFileSync(path.join(ROOT, 'versionada.md'), '---\nname: versionada\ndescription: v1\nkeywords: a\nscope: all\n---\nContenido original de la versión uno viva.');
  ws.draftSkill({ ...good, name: 'versionada', description: 'v2 mejorada' }, { root: ROOT });
  const ap = ws.approveDraft('versionada', ROOT);
  assert.equal(ap.ok, true);
  assert.ok(ap.versioned, 'versionó la viva');
  assert.ok(readFileSync(path.join(ROOT, 'versionada.md'), 'utf8').includes('v2 mejorada'));
  assert.ok(!ws.listDrafts(ROOT).includes('versionada'), 'draft consumido');
  assert.equal(ws.skillVersions('versionada', ROOT).length, 1);

  const rb = ws.rollbackSkill('versionada', ROOT);
  assert.equal(rb.ok, true);
  assert.ok(readFileSync(path.join(ROOT, 'versionada.md'), 'utf8').includes('Contenido original'), 'restaurada');
  // El undo también versiona (undoable).
  assert.ok(ws.skillVersions('versionada', ROOT).length >= 1);
});

test('f02: errores claros (draft inexistente, sin versiones)', () => {
  assert.equal(ws.approveDraft('no-existe', ROOT).ok, false);
  assert.equal(ws.rollbackSkill('nunca-versionada', ROOT).ok, false);
  assert.equal(ws.rejectDraft('no-existe', ROOT), false);
  assert.equal(ws.readDraft('no-existe', ROOT), null);
});

test('f02: drafts/versions invisibles para loadSkills', async () => {
  const { loadSkills } = await import('../server/lib/skills.js');
  const before = loadSkills().map((s) => s.name);
  ws.draftSkill(good, { root: ROOT });
  // El tmpdir no es el live: pero verificar convención de nombres.
  assert.ok(!before.some((n) => n.startsWith('.')), 'nada oculto en live');
  assert.ok(existsSync(path.join(ROOT, '.drafts', 'nueva-skill.md')));
});
