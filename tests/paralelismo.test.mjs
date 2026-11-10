import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { projectDir, Workforce } from '../server/lib/workforce.js';

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function nuevaEmpresa() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    companyTemplates.templates.find((t) => t.id === 'web'), 'test'
  );
  const eventos = [];
  const workforce = new Workforce(store, { hasKeys: () => true }, {
    onEvent: (_c, p) => eventos.push(p)
  });
  return { store, company, workforce, eventos };
}

// Each task with its file and its owner. `desde` shifts the team index
// so two calls do not give everything to the same person: an agent still
// does ONE thing at a time, like a person.
function repartir(store, company, goal, reparto, desde = 0) {
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  return reparto.map(({ archivo, kind = 'entregable' }, i) => {
    const agente = equipo[(desde + i) % equipo.length];
    const id = store.insertTask(null, agente.id, { text: `escribir ${archivo || 'algo'}` });
    store.assignTaskToGoal(id, goal.id, { kind, targetFile: archivo });
    return store.getTask(id);
  });
}

test('two agents build the SAME project at once if the files differ', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  repartir(store, company, goal, [{ archivo: 'index.html' }, { archivo: 'estilos.css' }]);

  const arrancadas = [];
  workforce.executeTask = async (_c, agent, task) => {
    arrancadas.push(task.target_file);
    await new Promise((r) => setTimeout(r, 60));
  };

  await workforce.tick();
  assert.equal(arrancadas.length, 2, 'los dos entran a la vez: es el paralelismo real');
  assert.deepEqual([...arrancadas].sort(), ['estilos.css', 'index.html']);
});

test('two tasks on the SAME file serialize', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  repartir(store, company, goal, [{ archivo: 'index.html' }, { archivo: 'index.html' }]);

  const arrancadas = [];
  workforce.executeTask = async (_c, agent, task) => {
    arrancadas.push(task.id);
    await new Promise((r) => setTimeout(r, 60));
  };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'nadie escribe encima del que ya está en ese archivo');

  await new Promise((r) => setTimeout(r, 90));
  await workforce.tick();
  assert.equal(arrancadas.length, 2, 'liberado el archivo, entra el segundo');
});

test('a review takes the whole project: it reads everything, it cannot read it half-written', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  repartir(store, company, goal, [{ archivo: null, kind: 'revision' }, { archivo: 'index.html' }]);

  const arrancadas = [];
  workforce.executeTask = async (_c, agent, task) => {
    arrancadas.push(task.kind);
    await new Promise((r) => setTimeout(r, 60));
  };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'con una revisión adentro no entra nadie más');
  assert.equal(arrancadas[0], 'revision');
});

test('a task without a declared file also takes the whole project', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  repartir(store, company, goal, [{ archivo: null }, { archivo: 'estilos.css' }]);

  const arrancadas = [];
  workforce.executeTask = async () => { arrancadas.push(1); await new Promise((r) => setTimeout(r, 60)); };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'sin saber qué va a tocar, se es conservador');
});

test("different projects never get in each other's way", async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const uno = store.createProject({ companyId: company.id, title: 'Uno' });
  const dos = store.createProject({ companyId: company.id, title: 'Dos' });
  t.after(() => {
    rmSync(projectDir(company.id, uno.slug), { recursive: true, force: true });
    rmSync(projectDir(company.id, dos.slug), { recursive: true, force: true });
  });

  repartir(store, company, uno, [{ archivo: 'index.html' }], 0);
  repartir(store, company, dos, [{ archivo: 'index.html' }], 1);

  const arrancadas = [];
  workforce.executeTask = async () => { arrancadas.push(1); await new Promise((r) => setTimeout(r, 60)); };

  await workforce.tick();
  assert.equal(arrancadas.length, 2, 'mismo nombre de archivo, proyectos distintos: sin conflicto');
});

test('the lock releases even if the task blows up', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  repartir(store, company, goal, [{ archivo: 'index.html' }]);
  workforce.executeTask = async () => { throw new Error('se rompió'); };
  await workforce.tick();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(workforce.busyFiles.size, 0, 'no queda un archivo tomado para siempre');
  assert.equal(workforce.busyAgents.size, 0);
});

test('an agent does ONE thing at a time, like a person', async (t) => {
  const { store, company, workforce } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  // The two files differ, but the owner is the same.
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  for (const archivo of ['index.html', 'estilos.css']) {
    const id = store.insertTask(null, equipo[0].id, { text: `escribir ${archivo}` });
    store.assignTaskToGoal(id, goal.id, { kind: 'entregable', targetFile: archivo });
  }

  const arrancadas = [];
  workforce.executeTask = async () => { arrancadas.push(1); await new Promise((r) => setTimeout(r, 60)); };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'aunque los archivos no choquen, la persona es una sola');
});
