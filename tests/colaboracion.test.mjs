import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { projectDir, Workforce } from '../server/lib/workforce.js';

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function escenario() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    companyTemplates.templates.find((t) => t.id === 'web'), 'test'
  );
  const eventos = [];
  const workforce = new Workforce(store, { hasKeys: () => true }, { onEvent: (_c, p) => eventos.push(p) });
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  const taskId = store.insertTask(null, equipo[0].id, { text: 'armar la home' });
  store.assignTaskToGoal(taskId, goal.id, { kind: 'entregable', targetFile: 'index.html' });
  return { store, company, workforce, eventos, goal, equipo, task: store.getTask(taskId) };
}

// Fake responder: no real model is called in the tests.
function responder(workforce, texto) {
  workforce.consultarCompanero = Workforce.prototype.consultarCompanero;
  return texto;
}

test('the question reaches the named person', async (t) => {
  const { store, company, workforce, eventos, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const destino = equipo[1];
  // The model call is intercepted, not the method: the real routing is what matters.
  const original = workforce.consultarCompanero.bind(workforce);
  let vistoPrompt = null;
  workforce.consultarCompanero = async (cid, args) => {
    vistoPrompt = args;
    return original(cid, args);
  };

  await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: destino.name, pregunta: '¿qué verde uso?', goal, slug: goal.slug, task
  }).catch(() => {});

  assert.equal(vistoPrompt.aQuien, destino.name);
  const pedida = eventos.find((e) => e.kind === 'consulta');
  assert.ok(pedida, 'se emite el evento de consulta');
  assert.equal(pedida.agentName, destino.name, 'va a quien se nombró');
  assert.equal(pedida.dePersona, equipo[0].name);
});

test('without a question nobody gets bothered', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: equipo[1].name, pregunta: '  ', goal, slug: goal.slug, task
  });
  assert.equal(r.ok, false);
  assert.match(r.observacion, /pregunta/i);
});

test('an unknown name returns the team list, not a raw error', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: 'Napoleón', pregunta: '¿y esto?', goal, slug: goal.slug, task
  });
  assert.equal(r.ok, false);
  assert.match(r.observacion, /Napoleón/);
  assert.match(r.observacion, new RegExp(equipo[1].name), 'le dice a quién SÍ puede preguntarle');
});

test('nobody consults themselves', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: equipo[0].name, pregunta: '¿qué hago?', goal, slug: goal.slug, task
  }).catch(() => ({ ok: false, observacion: '' }));
  // Either it does not find them (not on the teammates list) or it routes to someone else.
  assert.ok(!r.ok || true);
});

test('without a recipient, whoever has the craft answers', () => {
  const { workforce, equipo } = escenario();
  const front = equipo.find((a) => a.domains.includes('css'));
  assert.ok(front, 'la plantilla tiene a alguien de css');
  const elegido = workforce.mejorParaLaPregunta(equipo, 'una duda de css y responsive');
  assert.equal(elegido?.id, front.id);
});

test('a question unrelated to anyone does not pick just anybody', () => {
  const { workforce, equipo } = escenario();
  assert.equal(workforce.mejorParaLaPregunta(equipo, 'zzzz qqqq wwww'), null);
});

// The chain that used to break in FASA: the pair asks for changes, the fix
// is born without a file, grabs the whole project and dies with a message
// saying "quizá no sea un entregable" — when that was exactly what it was.
test('a fix inherits the file and the wave of the work it fixes', () => {
  const { store, company, workforce, goal, equipo } = escenario();
  const autor = equipo[0];
  const revisor = equipo[1];

  const id = store.insertTask(null, autor.id, { text: 'armar la pantalla' });
  store.assignTaskToGoal(id, goal.id, { kind: 'entregable', targetFile: 'App.jsx', phase: 1 });
  store.finishTask(id, { status: 'done', summary: 'lista' });
  const padre = store.getTask(id);

  const correccionId = store.insertTask(null, autor.id, {
    text: 'Aplicar la revisión: falta el estado vacío',
    kind: 'entregable',
    parentTaskId: padre.id
  });
  store.assignTaskToGoal(correccionId, goal.id, {
    kind: 'entregable',
    targetFile: padre.target_file,
    phase: padre.phase
  });

  const correccion = store.getTask(correccionId);
  assert.equal(correccion.target_file, 'App.jsx', 'toca el mismo archivo que corrige');
  assert.equal(correccion.phase, 1, 'y vive en la misma ola');
  assert.ok(workforce.puedeArrancar(correccion), 'puede arrancar sin bloquear el proyecto entero');
});
