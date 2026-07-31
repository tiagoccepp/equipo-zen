import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyTemplates } from '../server/lib/config.js';
import { inferirArchivo } from '../server/lib/inferir-archivo.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { Store } from '../server/lib/store.js';

function enProyecto(stack = 'web') {
  const enviados = [];
  const socket = { readyState: 1, OPEN: 1, send: (p) => enviados.push(JSON.parse(p)) };
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    companyTemplates.templates.find((t) => t.id === (stack === 'web' ? 'web' : 'movil-rn')), 'test'
  );
  const project = store.createProject({ companyId: company.id, title: 'Sitio' });
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null, company.id, project.id);
  return { store, company, project, session, enviados };
}

test('una tarea repartida en la reunión entra a la cola sola', () => {
  const { store, project, session } = enProyecto();
  const alguien = session.sessionAgents.find((a) => a.role === 'worker');

  assert.equal(session.autoWork, true, 'el arranque automático viene prendido');
  session.assignTaskToAgent(alguien, 'armar la home del menú');

  const enCola = store.tasksForGoal(project.id);
  assert.equal(enCola.length, 1, 'quedó encolada sin cerrar la reunión');
  assert.equal(enCola[0].status, 'pending');
});

test('con el arranque apagado, nadie se mueve hasta que lo pidas', () => {
  const { store, project, session } = enProyecto();
  session.autoWork = false;
  const alguien = session.sessionAgents.find((a) => a.role === 'worker');

  session.assignTaskToAgent(alguien, 'armar la home');
  assert.equal(store.tasksForGoal(project.id).length, 0, 'la tarea existe pero no está en la cola');
});

test('el usuario puede apagar y prender el arranque automático', async () => {
  const { session, enviados } = enProyecto();

  await session.handleClientMessage({ type: 'set_auto_work', enabled: false });
  assert.equal(session.autoWork, false);
  assert.ok(enviados.some((m) => m.type === 'auto_work_changed' && m.enabled === false), 'se le confirma al cliente');

  await session.handleClientMessage({ type: 'set_auto_work', enabled: true });
  assert.equal(session.autoWork, true);
});

// El defecto que anulaba el paralelismo: encolar sin archivo hace que la
// tarea tome el proyecto entero y el equipo vuelva a trabajar de a uno.
test('cada entregable se lleva SU archivo, no el proyecto entero', () => {
  const { store, project, session } = enProyecto();
  // Solo quienes producen código: el QA revisa y el de talento refina, y esas
  // tareas NO llevan archivo a propósito.
  const productores = session.sessionAgents.filter((a) =>
    a.role === 'worker' && !/qa|calidad|testing/i.test(`${a.title} ${a.domains.join(' ')}`)
    && !/dise[ñn]|arte|ux|ui/i.test(a.title));
  assert.ok(productores.length >= 2, 'la plantilla tiene al menos dos que escriben código');

  session.assignTaskToAgent(productores[0], 'armar la home del menú');
  session.assignTaskToAgent(productores[1], 'escribir la lógica de los datos');

  const entregables = store.tasksForGoal(project.id).filter((t) => t.kind === 'entregable');
  assert.equal(entregables.length, 2);
  for (const t of entregables) {
    assert.ok(t.target_file, `"${t.text}" quedó sin archivo: bloquearía a todo el equipo`);
  }
  assert.equal(new Set(entregables.map((t) => t.target_file)).size, 2, 'no se le da el mismo archivo a dos personas');
});

// La causa de las tareas trabadas en FASA: al QA y al de talento se les daba un
// archivo que escribir, y agotaban los pasos buscando qué escribir.
test('el QA y el de talento no reciben un archivo para escribir', () => {
  const { store, project, session } = enProyecto();
  const qa = session.sessionAgents.find((a) => /qa|calidad|testing/i.test(`${a.title} ${a.domains.join(' ')}`));
  const talento = session.sessionAgents.find((a) => a.role === 'contratista');

  if (qa) {
    session.assignTaskToAgent(qa, 'probar que el juego ande bien');
  }
  if (talento) {
    session.assignTaskToAgent(talento, 'revisar los perfiles del equipo');
  }

  for (const t of store.tasksForGoal(project.id)) {
    assert.notEqual(t.kind, 'entregable', `"${t.text}" no es un entregable: es ${t.kind}`);
    assert.equal(t.target_file, null, 'y no se le asigna un archivo que escribir');
  }
});

test('el aviso de que alguien se llevó una tarea llega al cliente', () => {
  const { session, enviados } = enProyecto();
  const alguien = session.sessionAgents.find((a) => a.role === 'worker');

  session.assignTaskToAgent(alguien, 'armar la home');
  const aviso = enviados.find((m) => m.type === 'work_event' && m.kind === 'task_queued');
  assert.ok(aviso, 'se emite task_queued');
  assert.equal(aviso.agentName, alguien.name);
});

test('la misma tarea repartida dos veces no se encola dos veces', () => {
  const { store, project, session } = enProyecto();
  const alguien = session.sessionAgents.find((a) => a.role === 'worker');

  session.assignTaskToAgent(alguien, 'armar la home');
  session.assignTaskToAgent(alguien, 'armar la home');
  assert.equal(store.tasksForGoal(project.id).length, 1);
});

test('la inferencia respeta un archivo que ya existe en el proyecto', () => {
  assert.equal(
    inferirArchivo('mejorar el contraste en src/theme.js', 'movil-rn', ['src/theme.js', 'App.jsx']),
    'src/theme.js'
  );
});

test('la inferencia nunca devuelve vacío para una tarea con texto', () => {
  for (const stack of ['web', 'automatizacion', 'movil-rn', 'android']) {
    const r = inferirArchivo('hacer una cosa rara sin palabras clave', stack, []);
    assert.ok(r && r.length > 0, `${stack} tiene que devolver algo, no null`);
  }
  assert.equal(inferirArchivo('   ', 'web', []), null, 'sin texto sí devuelve null');
});
