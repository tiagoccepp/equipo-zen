// E-11: reincidentes — 3+ repeticiones proponen fix, no más learnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  learningHealth,
  proposeFixesForReincidents,
  recordErrorLearning,
  reincidentErrors
} from '../server/lib/learning.js';
import { dreamCycle } from '../server/lib/dreaming.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'M' });
  return { store, project };
}

function repeat(store, goalId, tool, times) {
  for (let i = 0; i < times; i += 1) {
    recordErrorLearning(store, { agentId: 'a1', goalId, tool, error: 'boom' });
  }
}

test('e11: 3 refuerzos = reincidente; health mide tasa', () => {
  const { store, project } = seeded();
  repeat(store, project.id, 'run_cmd', 3);
  repeat(store, project.id, 'fetch_url', 1);
  const re = reincidentErrors(store, project.id);
  assert.equal(re.length, 1);
  assert.ok(re[0].content.includes('run_cmd'), 'solo el de 3');
  const h = learningHealth(store, project.id);
  assert.equal(h.errorLearnings, 2);
  assert.equal(h.reincident, 1);
  assert.equal(h.reincidentRate, 0.5);
  assert.equal(reincidentErrors(store, 'otro-goal').length, 0, 'scope por proyecto (+globales)');
  store.close();
});

test('e11: proposeFixes crea skill pendiente una sola vez', () => {
  const { store, project } = seeded();
  repeat(store, project.id, 'run_cmd', 4);
  const ids = proposeFixesForReincidents(store, project.id);
  assert.equal(ids.length, 1);
  const pend = store.pendingProposals(project.id);
  assert.equal(pend.length, 1);
  const d = JSON.parse(pend[0].text);
  assert.equal(d.kind, 'skill');
  assert.ok(d.payload.name.includes('run_cmd'), d.payload.name);
  assert.equal(d.risk, 'medium');
  const ids2 = proposeFixesForReincidents(store, project.id);
  assert.deepEqual(ids2, [], 'no duplica propuesta');
  store.close();
});

test('e11: dreaming reporta health + propone (dry-run no escribe)', async () => {
  const { store, project } = seeded();
  repeat(store, project.id, 'run_cmd', 3);
  const dry = await dreamCycle({ store, dryRun: true });
  assert.equal(dry.health.reincident, 1);
  assert.deepEqual(dry.fixProposals, []);
  assert.equal(store.pendingProposals(project.id).length, 0, 'dry no propone');
  const r = await dreamCycle({ store });
  assert.equal(r.fixProposals.length, 1);
  assert.equal(store.pendingProposals(project.id).length, 1);
  store.close();
});
