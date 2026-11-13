// E-09: gustos — upsert/merge/render + tools + promoción.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeTastes,
  promoteLearningToTaste,
  renderTastesSection,
  tasteKeyFromContent
} from '../server/lib/tastes.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { getTool, setManosStore } from '../server/lib/manos.js';

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const p1 = store.createProject({ companyId: company.id, title: 'Uno' });
  const p2 = store.createProject({ companyId: company.id, title: 'Dos' });
  setManosStore(store);
  return { store, p1, p2, ctx: (p) => ({ companyId: company.id, slug: p.slug, agentId: 'a1' }) };
}

test('e09: upsert + proyecto gana a global + delete', () => {
  const { store, p1, p2 } = seeded();
  store.upsertTaste({ scope: 'global', key: 'color-boton', value: 'azul', confidence: 0.7 });
  store.upsertTaste({ scope: 'project', goalId: p1.id, key: 'color-boton', value: 'verde', confidence: 0.9 });
  const { global, project } = store.tastesFor(p1.id);
  const merged = mergeTastes(global, project);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, 'verde', 'proyecto gana');
  assert.equal(merged[0].scope, 'project');
  const m2 = mergeTastes(...Object.values(store.tastesFor(p2.id)));
  assert.equal(m2[0].value, 'azul', 'otro proyecto ve global');
  store.upsertTaste({ scope: 'global', key: 'color-boton', value: 'rojo', confidence: 0.95 });
  assert.equal(mergeTastes(...Object.values(store.tastesFor(p2.id)))[0].value, 'rojo', 'upsert pisa');
  assert.equal(store.deleteTaste('global', null, 'color-boton'), true);
  assert.equal(store.tastesFor(p2.id).global.length, 0);
  store.close();
  setManosStore(null);
});

test('e09: render + keys derivadas', () => {
  assert.equal(renderTastesSection([]), '');
  const s = renderTastesSection([{ value: 'Botones azules' }]);
  assert.ok(s.includes('GUSTOS DE Tito'), s);
  assert.ok(s.includes('nunca menciones'), 'discreto');
  assert.equal(tasteKeyFromContent('Tito prefiere botones azules grandes'), 'tito-prefiere-botones-azules');
  assert.ok(tasteKeyFromContent('a').length >= 1);
});

test('e09: promoción desde learning con confianza alta', () => {
  const { store, p1 } = seeded();
  const id = store.insertLearning({ goalId: p1.id, type: 'user_preference', content: 'Tito prefiere español rioplatense', confidence: 0.95 });
  const t = promoteLearningToTaste(store, { id, type: 'user_preference', content: 'Tito prefiere español rioplatense', confidence: 0.95, goalId: p1.id });
  assert.ok(t, 'promovido');
  assert.equal(t.scope, 'project');
  const low = promoteLearningToTaste(store, { id, type: 'user_preference', content: 'x', confidence: 0.5 });
  assert.equal(low, null, 'baja confianza no');
  const other = promoteLearningToTaste(store, { id, type: 'fact', content: 'Tito prefiere español rioplatense', confidence: 0.95 });
  assert.equal(other, null, 'solo user_preference');
  store.close();
  setManosStore(null);
});

test('e09: tools taste_set/list por proyecto', async () => {
  const { store, p1, p2, ctx } = seeded();
  const set = getTool('taste_set');
  const list = getTool('taste_list');
  const r1 = await set.execute({ key: 'tono', value: 'rioplatense cálido', scope: 'project' }, ctx(p1));
  assert.equal(r1.ok, true, r1.error);
  const r2 = await set.execute({ key: 'mala key!', value: 'x' }, ctx(p1));
  assert.equal(r2.ok, false, 'key inválida');
  const l1 = await list.execute({}, ctx(p1));
  assert.ok(l1.output.includes('tono = rioplatense'), l1.output);
  const l2 = await list.execute({}, ctx(p2));
  assert.ok(!l2.output.includes('rioplatense'), 'aislado por proyecto');
  store.close();
  setManosStore(null);
});
