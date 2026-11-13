// E-10: auto-modificación — riesgo, auto-apply low, Tito decide resto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyLowRisk, classifyRisk } from '../server/lib/self-improve.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { getTool, setManosStore } from '../server/lib/manos.js';

const TMPROOT = mkdtempSync(path.join(os.tmpdir(), 'e10-skills-'));

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Mejora' });
  setManosStore(store);
  return { store, project, ctx: { companyId: company.id, slug: project.slug, agentId: 'a1' } };
}

test('e10: matriz de riesgo', () => {
  assert.equal(classifyRisk({ kind: 'skill', action: 'create' }), 'low');
  assert.equal(classifyRisk({ kind: 'taste', action: 'update' }), 'low');
  assert.equal(classifyRisk({ kind: 'prompt-note', action: 'create' }), 'low');
  assert.equal(classifyRisk({ kind: 'skill', action: 'update' }), 'medium');
  assert.equal(classifyRisk({ kind: 'tier', action: 'ask' }), 'medium');
  assert.equal(classifyRisk({ kind: 'skill', action: 'delete' }), 'high', 'irreversible');
  assert.equal(classifyRisk({ kind: 'tier', action: 'allow' }), 'high', 'abrir permisos');
  assert.equal(classifyRisk({ kind: 'tier', action: 'allow', payload: { tier: 'allow' } }), 'high');
  assert.equal(classifyRisk({ kind: 'invento', action: 'x' }), 'medium', 'desconocido a Tito');
});

test('e10: low se auto-aplica (skill a tmp + taste a DB)', async () => {
  const { store, project } = seeded();
  const s = await applyLowRisk({
    store, goalId: project.id, skillsRoot: TMPROOT,
    proposal: {
      kind: 'skill', action: 'create', reason: 'test',
      payload: { name: 'auto-test', description: 'Skill auto.', keywords: ['auto'], scope: 'chat', body: 'Cuando veas X, hacé Y con calma y reportá el resultado en dos líneas como máximo.' }
    }
  });
  assert.equal(s.applied, true, s.detail);
  assert.ok(existsSync(path.join(TMPROOT, 'auto-test.md')), 'skill viva en tmp');
  const t = await applyLowRisk({
    store, goalId: project.id,
    proposal: { kind: 'taste', action: 'create', reason: 'test', payload: { key: 'tono', value: 'cálido', scope: 'project' } }
  });
  assert.equal(t.applied, true, t.detail);
  store.close();
  setManosStore(null);
});

test('e10: medium/high van a pendientes (tool) + dieta frena', async () => {
  const { store, project, ctx } = seeded();
  const propose = getTool('improve_propose');
  const r1 = await propose.execute({ kind: 'skill', action: 'update', payload: { name: 'x' }, reason: 'mejorar x' }, ctx);
  assert.equal(r1.ok, true);
  assert.ok(r1.output.includes('riesgo medium'), r1.output);
  const r2 = await propose.execute({ kind: 'tier', action: 'allow', payload: { tool: 'run_cmd' }, reason: 'comodidad' }, ctx);
  assert.ok(r2.output.includes('riesgo high'), r2.output);
  assert.equal(store.pendingProposals(project.id).length, 2);
  const st = await getTool('improve_status').execute({}, ctx);
  assert.ok(st.output.includes('skill:update'), st.output);
  const noreason = await propose.execute({ kind: 'taste', action: 'create', payload: {} }, ctx);
  assert.equal(noreason.ok, false, 'sin motivo no');
  store.close();
  setManosStore(null);
});

test('e10: resolve via API-semántica (finishTask) + tier-ask aplica', async () => {
  const { store, project } = seeded();
  const { setTier, tierFor, __resetPermissions } = await import('../server/lib/permissions.js');
  const row = store.proposeChange(project.id, 'a1', { kind: 'tier', action: 'ask', payload: { tool: 'fetch_url' }, reason: 'cerrar', risk: 'medium' });
  assert.ok(setTier('fetch_url', 'ask'));
  assert.equal(tierFor('fetch_url'), 'ask');
  store.finishTask(row.id, { status: 'approved', summary: 'ok' });
  assert.equal(store.pendingProposals(project.id).length, 0);
  __resetPermissions();
  store.close();
  setManosStore(null);
});
