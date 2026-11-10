import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyTemplates } from '../server/lib/config.js';
import { Store } from '../server/lib/store.js';

function nuevaEmpresa() {
  const store = new Store(':memory:');
  const company = store.ensureCompanies(companyTemplates);
  return { store, company };
}

// A project with everything that can hang off it: meeting with turns, tasks
// with runs and comments. It is the case that must be left clean when deleted.
function proyectoPoblado(store, company, titulo = 'Landing del restaurante') {
  const project = store.createProject({ companyId: company.id, title: titulo, brief: 'Una landing con menú.' });
  const meeting = store.createMeeting({ companyId: company.id, goalId: project.id });
  store.appendTurn(meeting.id, { kind: 'user', speaker: 'Nino', text: 'Quiero una landing.' });
  store.appendTurn(meeting.id, { kind: 'agent', speaker: 'Valentina', text: 'Vamos.' });

  const agente = store.listAgents({ companyId: company.id })[0];
  const taskId = store.insertTask(meeting.id, agente.id, { text: 'Armar la landing' });
  store.assignTaskToGoal(taskId, project.id);
  const runId = store.startWorkRun(taskId, agente.id, company.id);
  store.finishWorkRun(runId, { status: 'ok', summary: 'Hecho', artifacts: ['index.html'] });
  store.addTaskComment({ taskId, companyId: company.id, authorId: agente.id, kind: 'nota', text: 'Revisado.' });

  return { project, meeting, taskId, agente };
}

test('the project is the container: its meetings hang off it', () => {
  const { store, company } = nuevaEmpresa();
  const { project, meeting } = proyectoPoblado(store, company);

  assert.equal(store.getMeeting(meeting.id).goal_id, project.id);
  assert.deepEqual(store.meetingsForProject(project.id).map((m) => m.id), [meeting.id]);
});

test('deleting a project takes meetings, turns, tasks, runs, and comments with it', () => {
  const { store, company } = nuevaEmpresa();
  const { project, meeting, taskId } = proyectoPoblado(store, company);

  const resultado = store.deleteProject(project.id);

  assert.equal(resultado.reuniones, 1);
  assert.equal(resultado.tareas, 1);
  assert.equal(resultado.corridas, 1);

  assert.equal(store.getGoal(project.id), null);
  assert.equal(store.getMeeting(meeting.id), null);
  assert.equal(store.getTask(taskId), null);
  assert.equal(store.recentTurns(meeting.id).length, 0);
  assert.equal(store.taskComments(taskId).length, 0);
  assert.equal(store.recentWorkRuns(company.id).length, 0);
});

test('deleting a project does not touch the others', () => {
  const { store, company } = nuevaEmpresa();
  const uno = proyectoPoblado(store, company, 'Proyecto uno');
  const dos = proyectoPoblado(store, company, 'Proyecto dos');

  store.deleteProject(uno.project.id);

  assert.equal(store.getGoal(dos.project.id)?.title, 'Proyecto dos');
  assert.equal(store.getMeeting(dos.meeting.id)?.id, dos.meeting.id);
  assert.equal(store.tasksForGoal(dos.project.id).length, 1);
  assert.equal(store.recentTurns(dos.meeting.id).length, 2);
});

test('two projects with the same title do not share a folder', () => {
  const { store, company } = nuevaEmpresa();
  const uno = store.createProject({ companyId: company.id, title: 'Landing' });
  const dos = store.createProject({ companyId: company.id, title: 'Landing' });

  assert.notEqual(uno.slug, dos.slug);
  assert.equal(store.slugSharedWithOthers(uno.id), false);
});

// Goals from before projects ALL ended up with slug 'general'
// (migration v5). Deleting one must not take the others' files.
test('a shared folder is not marked for deletion', () => {
  const { store, company } = nuevaEmpresa();
  const uno = store.createProject({ companyId: company.id, title: 'General' });
  const dos = store.createProject({ companyId: company.id, title: 'Otro' });
  store.db.prepare('UPDATE goals SET slug = ? WHERE id = ?').run('general', dos.id);

  assert.equal(store.slugSharedWithOthers(uno.id), true);
  assert.equal(store.deleteProject(uno.id).carpetaCompartida, true);
});

// What the team needs to receive to build the right thing: the user's words.
// Without this they invented a generic project.
test('the user request travels from the meeting turn to the project', () => {
  const { store, company } = nuevaEmpresa();
  const project = store.createProject({ companyId: company.id, title: 'Fasa' });
  const meeting = store.createMeeting({ companyId: company.id, goalId: project.id });

  store.appendTurn(meeting.id, { kind: 'user', speaker: 'Nino', text: 'quiero un menú digital para un restaurante de sushi' });
  store.appendTurn(meeting.id, { kind: 'agent', speaker: 'Renata', text: 'Dale, lo armamos.' });
  store.appendTurn(meeting.id, { kind: 'user', speaker: 'Nino', text: 'con parallax, súper animado' });

  const pedido = store.userRequestForGoal(project.id);
  assert.deepEqual(pedido, [
    'quiero un menú digital para un restaurante de sushi',
    'con parallax, súper animado'
  ], 'solo los turnos del usuario, en orden');
});

test("another project's request does not leak", () => {
  const { store, company } = nuevaEmpresa();
  const uno = store.createProject({ companyId: company.id, title: 'Uno' });
  const dos = store.createProject({ companyId: company.id, title: 'Dos' });
  const m1 = store.createMeeting({ companyId: company.id, goalId: uno.id });
  const m2 = store.createMeeting({ companyId: company.id, goalId: dos.id });
  store.appendTurn(m1.id, { kind: 'user', speaker: 'Nino', text: 'sushi' });
  store.appendTurn(m2.id, { kind: 'user', speaker: 'Nino', text: 'panadería' });

  assert.deepEqual(store.userRequestForGoal(uno.id), ['sushi']);
  assert.deepEqual(store.userRequestForGoal(dos.id), ['panadería']);
});

// The bug that sent all the work to a ghost project named with the date.
test('an orphan meeting is adopted by the project you are in', () => {
  const { store, company } = nuevaEmpresa();
  const huerfana = store.createMeeting({ companyId: company.id });
  assert.equal(huerfana.goal_id, null);

  const project = store.createProject({ companyId: company.id, title: 'Fasa' });
  assert.equal(store.attachMeetingToGoal(huerfana.id, project.id), true);
  assert.equal(store.getMeeting(huerfana.id).goal_id, project.id);
});

test('a meeting that already has a project is not stolen', () => {
  const { store, company } = nuevaEmpresa();
  const uno = store.createProject({ companyId: company.id, title: 'Uno' });
  const dos = store.createProject({ companyId: company.id, title: 'Dos' });
  const meeting = store.createMeeting({ companyId: company.id, goalId: uno.id });

  assert.equal(store.attachMeetingToGoal(meeting.id, dos.id), false);
  assert.equal(store.getMeeting(meeting.id).goal_id, uno.id);
});

test('listProjects brings the count of what hangs off each project', () => {
  const { store, company } = nuevaEmpresa();
  const { project, taskId } = proyectoPoblado(store, company);
  store.finishTask(taskId, { status: 'done', summary: 'listo' });

  const [fila] = store.listProjects(company.id);
  assert.equal(fila.id, project.id);
  assert.equal(fila.meeting_count, 1);
  assert.equal(fila.task_count, 1);
  assert.equal(fila.done_count, 1);
});

// ── The file map ───────────────────────────────────────────────
//
// The cause of the blocked tasks: the team split by discipline
// ("definir la paleta", "implementar el parallax", "prototipo en Figma") and
// those tasks map to no file, so they exhausted the steps.

test('the target file is saved with the task and says who the owner is', () => {
  const { store, company } = nuevaEmpresa();
  const project = store.createProject({ companyId: company.id, title: 'Menú' });
  const [uno, dos] = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');

  const a = store.insertTask(null, uno.id, { text: 'Armar el menú' });
  store.assignTaskToGoal(a, project.id, { kind: 'entregable', targetFile: 'index.html' });
  const b = store.insertTask(null, dos.id, { text: 'Escribir los estilos' });
  store.assignTaskToGoal(b, project.id, { kind: 'entregable', targetFile: 'estilos.css' });

  const duenos = store.fileOwnersForGoal(project.id);
  assert.deepEqual(duenos.map((d) => d.file), ['index.html', 'estilos.css']);
  assert.equal(duenos[0].agent_id, uno.id);
  assert.equal(duenos[1].agent_id, dos.id);
});

test('a decision takes no file', () => {
  const { store, company } = nuevaEmpresa();
  const project = store.createProject({ companyId: company.id, title: 'Menú' });
  const agente = store.listAgents({ companyId: company.id })[0];

  const id = store.insertTask(null, agente.id, { text: 'definir la paleta' });
  store.assignTaskToGoal(id, project.id, { kind: 'decision' });

  assert.equal(store.getTask(id).target_file, null);
  assert.equal(store.fileOwnersForGoal(project.id).length, 0, 'las decisiones no entran al esquema');
});
