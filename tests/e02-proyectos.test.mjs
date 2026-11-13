// E-02: proyecto como unidad de contexto — learnings con goal_id +
// overlay de memoria por proyecto. DB :memory: + tmpdir. Cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'e02-'));
process.env.PABLO_MEMORY_DIR = TMP;

const { Store } = await import('../server/lib/store.js');
const { companyTemplates } = await import('../server/lib/config.js');
const mem = await import('../server/lib/pablo-memory.js');

function seedCompany(store) {
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const p1 = store.createProject({ companyId: company.id, title: 'Web' });
  const p2 = store.createProject({ companyId: company.id, title: 'App' });
  return { company, p1, p2 };
}

test('e02: learnings con goal_id; filtro por proyecto + globales', () => {
  const store = new Store(':memory:');
  const { p1, p2 } = seedCompany(store);
  const idGlobal = store.insertLearning({ type: 'fact', content: 'Tito prefiere español rioplatense siempre', confidence: 0.9 });
  const idP1 = store.insertLearning({ goalId: p1.id, type: 'fact', content: 'El stack de la web es Astro con Tailwind', confidence: 0.9 });
  const idP2 = store.insertLearning({ goalId: p2.id, type: 'fact', content: 'La app usa React Native con Expo', confidence: 0.9 });
  assert.ok(idGlobal && idP1 && idP2);

  const enP1 = store.activeLearnings(null, p1.id).map((l) => l.content);
  assert.ok(enP1.some((c) => c.includes('rioplatense')), 'global aplica en p1');
  assert.ok(enP1.some((c) => c.includes('Astro')), 'p1 ve lo suyo');
  assert.ok(!enP1.some((c) => c.includes('Expo')), 'p1 NO ve lo de p2');

  const enP2 = store.activeLearnings(null, p2.id).map((l) => l.content);
  assert.ok(enP2.some((c) => c.includes('Expo')), 'p2 ve lo suyo');
  assert.ok(!enP2.some((c) => c.includes('Astro')), 'p2 NO ve lo de p1');

  const all = store.activeLearnings().map((l) => l.content);
  assert.equal(all.length, 3, 'sin goal: histórico (todo)');

  const mapped = store.activeLearnings(null, p1.id).find((l) => l.content.includes('Astro'));
  assert.equal(mapped.goalId, p1.id, 'mapper expone goalId');
  store.close();
});

test('e02: overlay de memoria — proyecto gana, empresa de fallback', () => {
  mem.writeMemoryFile('acme', 'MEMORY.md', 'DATO EMPRESA');
  mem.writeMemoryFile('acme', 'USER.md', 'USER EMPRESA');
  mem.writeMemoryFile('acme', 'MEMORY.md', 'DATO PROYECTO WEB', 'web');
  assert.equal(mem.readMemoryFile('acme', 'MEMORY.md'), 'DATO EMPRESA');
  assert.equal(mem.readMemoryFile('acme', 'MEMORY.md', 'web'), 'DATO PROYECTO WEB', 'overlay gana');
  assert.equal(mem.readMemoryFile('acme', 'USER.md', 'web'), 'USER EMPRESA', 'sin overlay: fallback');
  assert.equal(mem.readMemoryFile('acme', 'MEMORY.md', 'otro'), 'DATO EMPRESA', 'otro proyecto: no ve overlay ajeno');
});

test('e02: renderMemorySection suma bloques PROJECT solo con overlay propio', () => {
  const base = mem.renderMemorySection('acme', { maxChars: 4000 });
  assert.ok(base.includes('DATO EMPRESA'), 'base empresa');
  assert.ok(!base.includes('PROJECT MEMORY'), 'sin proyecto: sin bloques project');
  const scoped = mem.renderMemorySection('acme', { maxChars: 4000, projectSlug: 'web' });
  assert.ok(scoped.includes('DATO EMPRESA'), 'empresa sigue');
  assert.ok(scoped.includes('PROJECT MEMORY (web'), 'bloque project');
  assert.ok(scoped.includes('DATO PROYECTO WEB'), 'contenido project');
  const other = mem.renderMemorySection('acme', { maxChars: 4000, projectSlug: 'otro' });
  assert.ok(!other.includes('DATO PROYECTO WEB'), 'aislado entre proyectos');
});

test('e02: slugs con traversal no rompen nada', () => {
  assert.throws(() => mem.projectMemoryDirFor('acme', '../x'), /Proyecto inválido/);
  assert.throws(() => mem.projectMemoryDirFor('a/b', 'web'), /Empresa inválida/);
  // read con slug raro: cae a empresa, no lanza.
  assert.equal(mem.readMemoryFile('acme', 'MEMORY.md', '../x'), 'DATO EMPRESA');
});
