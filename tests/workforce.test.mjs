import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { extractFileContent, safeWorkspacePath, Workforce } from '../server/lib/workforce.js';

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function newCompany() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'tecnologia');
  const company = store.createCompanyFromTemplate(template, 'test');
  const events = [];
  const workforce = new Workforce(store, { hasKeys: () => false }, {
    onEvent: (companyId, payload) => events.push(payload)
  });
  return { store, company, workforce, events };
}

test('el sandbox no deja escapar de la carpeta del proyecto', () => {
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '../otra/index.html'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '/etc/passwd'), /inválida/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '.env'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', 'script.sh'), /Extensión no permitida/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', 'nested/../../fuera.html'), /fuera del proyecto/);

  const ok = safeWorkspacePath('emp1', 'proy', 'css/estilos.css');
  assert.match(ok, /emp1\/proy\/css\/estilos\.css$/);
});

test('el contenido del archivo se acepta en cualquiera de sus formas', () => {
  assert.equal(
    extractFileContent('{"action":"write_file","path":"a.html"}\n<<<CONTENIDO\n<h1>hola</h1>\nCONTENIDO>>>', {}),
    '<h1>hola</h1>'
  );
  assert.equal(extractFileContent('nada', { content: '<h1>x</h1>' }), '<h1>x</h1>');
  assert.equal(extractFileContent('nada', { text: '<h1>x</h1>' }), '<h1>x</h1>');
  assert.equal(extractFileContent('nada', {}), '');
});

test('revisa un compañero con skills afines, nunca el propio autor', () => {
  const { store, company, workforce } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const bruno = team.find((a) => a.name === 'Bruno');

  const reviewer = workforce.pickReviewer(company.id, bruno, { text: 'crear la página web institucional' });
  assert.ok(reviewer, 'siempre hay alguien que pueda revisar');
  assert.notEqual(reviewer.id, bruno.id, 'nadie se revisa a sí mismo');
  assert.notEqual(reviewer.role, 'contratista', 'el contratista no revisa entregables');
});

test('al terminar un entregable se le pide revisión a un compañero', () => {
  const { store, company, workforce, events } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const bruno = team.find((a) => a.name === 'Bruno');
  const meeting = store.createMeeting({ companyId: company.id });
  const goal = store.createGoal({ companyId: company.id, meetingId: meeting.id, title: 'Sitio nuevo' });

  const taskId = store.insertTask(meeting.id, bruno.id, { text: 'crear la página web' });
  store.assignTaskToGoal(taskId, goal.id, { kind: 'entregable' });
  const task = store.getTask(taskId);

  workforce.requestReview(company.id, bruno, task, ['index.html']);

  const revisiones = store.tasksForGoal(goal.id).filter((t) => t.kind === 'revision');
  assert.equal(revisiones.length, 1, 'se creó la tarea de revisión');
  assert.equal(revisiones[0].parent_task_id, taskId);
  assert.equal(revisiones[0].status, 'pending', 'entra a la cola de trabajo');
  assert.notEqual(revisiones[0].agent_id, bruno.id);
  assert.equal(store.getTask(taskId).review_status, 'pendiente');
  assert.ok(events.some((e) => e.kind === 'review_requested'));

  // La cola la toma el revisor.
  assert.ok(store.workQueue(company.id).some((t) => t.id === revisiones[0].id));
});

test('no se revisa lo que no produjo archivos ni las correcciones (evita el ida y vuelta infinito)', () => {
  const { store, company, workforce } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const bruno = team.find((a) => a.name === 'Bruno');
  const meeting = store.createMeeting({ companyId: company.id });
  const goal = store.createGoal({ companyId: company.id, meetingId: meeting.id, title: 'Sitio nuevo' });

  const sinArchivos = store.getTask(
    (() => {
      const id = store.insertTask(meeting.id, bruno.id, { text: 'pensar el enfoque' });
      store.assignTaskToGoal(id, goal.id, { kind: 'entregable' });
      return id;
    })()
  );
  workforce.requestReview(company.id, bruno, sinArchivos, []);

  const correccion = store.getTask(
    (() => {
      const id = store.insertTask(meeting.id, bruno.id, { text: 'aplicar la revisión', parentTaskId: 'task-original' });
      store.assignTaskToGoal(id, goal.id, { kind: 'entregable' });
      return id;
    })()
  );
  workforce.requestReview(company.id, bruno, correccion, ['index.html']);

  assert.equal(store.tasksForGoal(goal.id).filter((t) => t.kind === 'revision').length, 0);
});

test('cada proyecto tiene su carpeta aunque se repita el título', () => {
  const { store, company } = newCompany();
  const a = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  const b = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  const c = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  assert.equal(a.slug, 'sitio-web');
  assert.equal(b.slug, 'sitio-web-2');
  assert.equal(c.slug, 'sitio-web-3');
});
