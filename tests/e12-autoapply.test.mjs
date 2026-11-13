// E-12: auto-aplicación + veto — claim/release/veto + voz.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';
import { getTool, setManosStore } from '../server/lib/manos.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Auto' });
  setManosStore(store);
  const meeting = store.createMeeting({ companyId: company.id, goalId: project.id });
  const taskId = store.insertTask(meeting.id, 'sin-dueno', { text: 'Tarea libre' });
  store._prepare('UPDATE tasks SET agent_id = \'unassigned\', goal_id = ? WHERE id = ?').run(project.id, taskId);
  return { store, project, taskId, ctx: { companyId: company.id, slug: project.slug, agentId: 'backend-1' } };
}

test('e12: claim/release por tool con motivo obligatorio', async () => {
  const { store, project, taskId, ctx } = seeded();
  const claim = getTool('task_claim');
  const noreason = await claim.execute({ item: taskId }, ctx);
  assert.equal(noreason.ok, false, 'sin motivo no');
  const r = await claim.execute({ item: taskId, reason: 'soy el indicado' }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.output.includes('ANUNCIALO'), 'instrucción de anunciar');
  const task = store.getTask(taskId);
  assert.equal(task.agent_id, 'backend-1');
  assert.equal(task.origin, 'self');
  const dup = await claim.execute({ item: taskId, reason: 'yo también' }, { ...ctx, agentId: 'otro' });
  assert.equal(dup.ok, false, 'con dueño no');
  const rel = await getTool('task_release').execute({ item: taskId }, ctx);
  assert.equal(rel.ok, true);
  assert.equal(store.getTask(taskId).agent_id, 'unassigned');
  store.close();
  setManosStore(null);
});

test('e12: veto revierte pendiente; empezada no', () => {
  const { store, project, taskId } = seeded();
  store.claimTask(taskId, 'backend-1', 'test');
  const v = store.vetoTask(taskId, 'tito');
  assert.equal(v.ok, true);
  assert.equal(store.getTask(taskId).agent_id, 'unassigned');
  assert.equal(store.selfAssignedTasks(project.id, 60).length, 0, 'vetada sale de la lista');
  // Empezada: no se veta.
  store.claimTask(taskId, 'backend-1', 'test');
  store._prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run(taskId);
  const v2 = store.vetoTask(taskId, 'tito');
  assert.equal(v2.ok, false, 'empezada no se veta');
  assert.equal(store.vetoTask('nope', 'tito').ok, false);
  store.close();
  setManosStore(null);
});

test('e12: veto por voz revierte la última auto-aplicada', () => {
  const { store, project, taskId } = seeded();
  store.claimTask(taskId, 'backend-1', 'test');
  const sent = [];
  const socket = { readyState: 1, OPEN: 1, send: (p) => sent.push(JSON.parse(p)) };
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.project = project;
  const r = session.maybeVetoClaim('veto eso, pará');
  assert.equal(r.vetoed, true);
  assert.equal(store.getTask(taskId).agent_id, 'unassigned');
  const r2 = session.maybeVetoClaim('veto eso');
  assert.equal(r2.vetoed, false, 'ya no hay nada');
  assert.equal(session.maybeVetoClaim('seguí nomás').vetoed, false, 'sin veto no');
  store.close();
  setManosStore(null);
});
