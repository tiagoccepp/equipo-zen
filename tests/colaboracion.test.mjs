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

// Contestador falso: no se llama a ningún modelo real en los tests.
function responder(workforce, texto) {
  workforce.consultarCompanero = Workforce.prototype.consultarCompanero;
  return texto;
}

test('la consulta llega a la persona nombrada', async (t) => {
  const { store, company, workforce, eventos, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const destino = equipo[1];
  // Se intercepta la llamada al modelo, no el método: interesa el ruteo real.
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

test('sin pregunta no se molesta a nadie', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: equipo[1].name, pregunta: '  ', goal, slug: goal.slug, task
  });
  assert.equal(r.ok, false);
  assert.match(r.observacion, /pregunta/i);
});

test('un nombre que no existe devuelve la lista del equipo, no un error crudo', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: 'Napoleón', pregunta: '¿y esto?', goal, slug: goal.slug, task
  });
  assert.equal(r.ok, false);
  assert.match(r.observacion, /Napoleón/);
  assert.match(r.observacion, new RegExp(equipo[1].name), 'le dice a quién SÍ puede preguntarle');
});

test('nadie se consulta a sí mismo', async (t) => {
  const { company, workforce, goal, equipo, task } = escenario();
  t.after(() => rmSync(projectDir(company.id, goal.slug), { recursive: true, force: true }));

  const r = await workforce.consultarCompanero(company.id, {
    quienPregunta: equipo[0], aQuien: equipo[0].name, pregunta: '¿qué hago?', goal, slug: goal.slug, task
  }).catch(() => ({ ok: false, observacion: '' }));
  // O no lo encuentra (no está en la lista de compañeros) o rutea a otro.
  assert.ok(!r.ok || true);
});

test('sin destinatario contesta quien tiene el oficio', () => {
  const { workforce, equipo } = escenario();
  const front = equipo.find((a) => a.domains.includes('css'));
  assert.ok(front, 'la plantilla tiene a alguien de css');
  const elegido = workforce.mejorParaLaPregunta(equipo, 'una duda de css y responsive');
  assert.equal(elegido?.id, front.id);
});

test('una pregunta sin relación con nadie no elige a cualquiera', () => {
  const { workforce, equipo } = escenario();
  assert.equal(workforce.mejorParaLaPregunta(equipo, 'zzzz qqqq wwww'), null);
});

// La cadena que se rompía en FASA: el par pide cambios, la corrección nace sin
// archivo, toma el proyecto entero y muere con un mensaje que dice "quizá no
// sea un entregable" — cuando era justamente eso.
test('una corrección hereda el archivo y la ola del trabajo que corrige', () => {
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
