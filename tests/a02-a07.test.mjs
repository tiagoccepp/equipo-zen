// A-02 + A-07: team-run (cheap/team) + background bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTeamTask, teamModeFor } from '../server/lib/team-run.js';
import { injectSynthetic, promotableWorkEvent } from '../server/lib/background.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

function fakeSession() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'T' });
  const agents = store.listAgents({ companyId: company.id }).slice(0, 3).map((a) => ({ ...a, enabled: true }));
  const sentBus = [];
  const ran = [];
  return {
    store,
    project,
    company,
    sessionAgents: agents,
    projectSlug: project.slug,
    agentBus: { send: (from, to, text) => { sentBus.push({ from, to, text }); return { ok: true }; } },
    runAgentJobTurn: async (agentId, text) => {
      ran.push({ agentId, text });
      return { text: `hecho por ${agentId}: ${String(text).slice(0, 60)}`, toolCalls: [] };
    },
    sentBus,
    ran
  };
}

test('a02: modo por complejidad + cheap con uno solo', async () => {
  assert.equal(teamModeFor('hola'), 'cheap');
  assert.equal(teamModeFor('Analizá por qué falla el build, compará con ayer y proponé un fix completo ya.'), 'team');
  const fx = fakeSession();
  const r = await runTeamTask(fx, { goalId: fx.project.id, brief: 'hola, confirmá que estás' });
  assert.equal(r.mode, 'cheap');
  assert.equal(fx.ran.length, 1, 'un solo worker');
  assert.ok(r.summary.includes('hecho por'));
  fx.store.close();
});

test('a02: team reparte + checklist compartida + sintetiza', async () => {
  const fx = fakeSession();
  const brief = 'Primero diseñá la paleta de colores. Luego analizá por qué tarda el build y compará alternativas. Publicá el resumen.';
  const r = await runTeamTask(fx, { goalId: fx.project.id, brief });
  assert.equal(r.mode, 'team');
  assert.ok(r.workers.length >= 1 && r.workers.length <= 3, 'workers acotados');
  assert.ok(fx.sentBus.length >= 1, 'reparto por bus directo');
  const checklist = fx.store.checklistForGoal(fx.project.id);
  assert.ok(checklist.length >= 2, 'checklist compartida creada');
  assert.ok(r.summary.length > 0, 'síntesis del lead');
  assert.ok(fx.ran.length >= 2, 'workers + lead corrieron');
  fx.store.close();
});

test('a07: promotable filtra terminales con resumen', () => {
  assert.equal(promotableWorkEvent({ type: 'work_event', kind: 'task_started' }), null);
  assert.equal(promotableWorkEvent({ type: 'otro' }), null);
  const p = promotableWorkEvent({ type: 'work_event', kind: 'task_done', taskId: 't1', agentId: 'a1', agentName: 'X', summary: 'listo todo' });
  assert.deepEqual(p, { kind: 'task_done', agentId: 'a1', agentName: 'X', text: 'listo todo', taskId: 't1' });
  const g = promotableWorkEvent({ type: 'work_event', kind: 'goal_done', title: 'Web' });
  assert.equal(g.text, 'Objetivo listo: Web');
});

test('a07: injectSynthetic valida y delega', async () => {
  const fx = fakeSession();
  const out = await injectSynthetic(fx, 'a1', 'revisá la home');
  assert.ok(out.text.includes('hecho por a1'));
  await assert.rejects(() => injectSynthetic(null, 'a1', 'x'), /session/);
  await assert.rejects(() => injectSynthetic(fx, '', 'x'), /agentId/);
  fx.store.close();
});
