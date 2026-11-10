import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { projectDir, Workforce } from '../server/lib/workforce.js';

// The team producing: the queue, checkout, locks, and what the user sees
// when something goes wrong. No network, no model: executeTask is intercepted,
// which is exactly the piece that talks to the cloud.

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function nuevaEmpresa() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    companyTemplates.templates.find((t) => t.id === 'web'), 'test'
  );
  // By role, never by name: the template changes and the tests do not.
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  return { store, company, equipo };
}

function nuevoMotor(store) {
  const workforce = new Workforce(store, { hasKeys: () => true });
  const eventos = [];
  // The real engine reports via telemetry and leaves a trace in the company
  // journal (disk). Here it is collected in memory: it is the SAME payload the UI gets.
  workforce.emitEvent = (_companyId, event) => eventos.push(event);
  workforce.eventos = eventos;
  return workforce;
}

// Fixed, increasing dates: the queue orders by creation date and two tasks
// created in the same millisecond would leave the order to chance.
let reloj = 0;
function encargar(store, goal, agente, { archivo = null, kind = 'entregable', texto = null } = {}) {
  reloj += 1;
  const taskId = store.insertTask(null, agente.id, {
    text: texto || `escribir ${archivo || 'lo que haga falta'}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + reloj * 1000).toISOString()
  });
  store.assignTaskToGoal(taskId, goal.id, { kind, targetFile: archivo });
  return store.getTask(taskId);
}

// Each run stays IN FLIGHT until the test ends it by hand: the lock is held
// exactly as long as needed, with no sleeps or clocks.
function enVuelo(workforce) {
  const corridas = [];
  workforce.executeTask = async (companyId, agente, tarea) => {
    const corrida = { companyId, agente, tarea };
    corrida.fin = new Promise((resolve, reject) => {
      corrida.terminar = resolve;
      corrida.romper = reject;
    });
    corridas.push(corrida);
    await corrida.fin;
  };
  return corridas;
}

// Lets the engine finish settling what was left hanging: the `finally` blocks
// releasing locks run as microtasks, and setImmediate goes after all of them.
const asentar = () => new Promise((resolve) => setImmediate(resolve));

function limpiarCarpetas(t, companyId, ...goals) {
  t.after(() => {
    for (const goal of goals) {
      rmSync(projectDir(companyId, goal.slug), { recursive: true, force: true });
    }
  });
}

test('what was noted as an agreement in the meeting puts nobody to work', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const acuerdo = encargar(store, goal, equipo[0], { kind: 'decision', texto: 'quedamos en usar verde' });
  const seguimiento = encargar(store, goal, equipo[1], { kind: 'seguimiento', texto: 'ver cómo viene la semana que viene' });
  const entregable = encargar(store, goal, equipo[2], { archivo: 'index.html' });

  const enCola = store.workQueue(company.id).map((t2) => t2.id);
  assert.deepEqual(enCola, [entregable.id], 'a la cola solo entra lo que alguien tiene que construir');

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  assert.equal(corridas.length, 1, 'se pone a trabajar una sola persona: la del entregable');
  assert.equal(corridas[0].tarea.id, entregable.id);
  // And agreements stay visible on the board, with nobody "working" them.
  assert.equal(store.getTask(acuerdo.id).status, 'noted');
  assert.equal(store.getTask(seguimiento.id).status, 'noted');

  corridas[0].terminar();
  await asentar();
});

test('nobody starts a task someone else already took', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const tarea = encargar(store, goal, equipo[0], { archivo: 'index.html' });

  // Both engines look at the SAME snapshot of the queue (with the task still
  // pending). The only thing that can stop the work from being done — and paid —
  // twice is taking the task atomically.
  const foto = store.workQueue(company.id);
  store.workQueue = () => foto;

  const motorA = nuevoMotor(store);
  const motorB = nuevoMotor(store);
  const corridasA = enVuelo(motorA);
  const corridasB = enVuelo(motorB);

  await motorA.tick();
  await motorB.tick();

  assert.equal(corridasA.length + corridasB.length, 1, 'la tarea se hace una sola vez');
  assert.equal(store.getTask(tarea.id).run_count, 1, 'y se cuenta una sola corrida');
  assert.equal(store.getTask(tarea.id).status, 'in_progress');
  assert.equal(store.checkoutTask(tarea.id), false, 'el que llega tarde se va con las manos vacías');

  corridasA.concat(corridasB).forEach((c) => c.terminar());
  await asentar();
});

test('two people build the same site at once, each in their own file', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const home = encargar(store, goal, equipo[0], { archivo: 'index.html' });
  const estilos = encargar(store, goal, equipo[1], { archivo: 'estilos.css' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  assert.equal(corridas.length, 2, 'el proyecto no se hace de a uno: avanza en paralelo');
  assert.deepEqual(corridas.map((c) => c.tarea.target_file).sort(), ['estilos.css', 'index.html']);
  assert.equal(store.getTask(home.id).status, 'in_progress');
  assert.equal(store.getTask(estilos.id).status, 'in_progress');
  assert.equal(motor.busyFiles.get(goal.id).size, 2, 'cada uno tiene tomado lo suyo, no el proyecto entero');

  corridas.forEach((c) => c.terminar());
  await asentar();
});

test('if two end up with the same file they do not write it at once, and the second one is not lost', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const primera = encargar(store, goal, equipo[0], { archivo: 'index.html', texto: 'armar la home' });
  const segunda = encargar(store, goal, equipo[1], { archivo: 'index.html', texto: 'sumar el formulario a la home' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  assert.equal(corridas.length, 1, 'nadie escribe encima del que ya está en ese archivo');
  assert.equal(corridas[0].tarea.id, primera.id);
  assert.equal(store.getTask(segunda.id).status, 'pending', 'la segunda espera turno');

  // And it keeps waiting in the queue: not discarded, not taken as done.
  await motor.tick();
  assert.equal(corridas.length, 1, 'insistir no la hace entrar antes');
  assert.ok(store.workQueue(company.id).some((t2) => t2.id === segunda.id), 'el pedido no se perdió');

  corridas[0].terminar();
  await asentar();
  await motor.tick();

  assert.equal(corridas.length, 2, 'liberado el archivo, entra la que esperaba');
  assert.equal(corridas[1].tarea.id, segunda.id);
  corridas[1].terminar();
  await asentar();
});

test('one person does not start the second thing until finishing the first, even in different files', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const uno = encargar(store, goal, equipo[0], { archivo: 'index.html' });
  const dos = encargar(store, goal, equipo[0], { archivo: 'estilos.css' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  assert.equal(corridas.length, 1, 'aunque los archivos no choquen, la persona es una sola');
  assert.equal(corridas[0].tarea.id, uno.id);
  assert.equal(store.getTask(dos.id).status, 'pending');

  corridas[0].terminar();
  await asentar();
  await motor.tick();

  assert.equal(corridas.length, 2, 'recién cuando se desocupa agarra la siguiente');
  assert.equal(corridas[1].tarea.id, dos.id);
  corridas[1].terminar();
  await asentar();
});

test('while someone reviews a whole project that project pauses, but the one next door goes on', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const sitio = store.createProject({ companyId: company.id, title: 'Sitio' });
  const tienda = store.createProject({ companyId: company.id, title: 'Tienda' });
  limpiarCarpetas(t, company.id, sitio, tienda);

  const revision = encargar(store, sitio, equipo[0], { kind: 'revision', texto: 'revisar cómo quedó el sitio' });
  const enElSitio = encargar(store, sitio, equipo[1], { archivo: 'index.html' });
  const enLaTienda = encargar(store, tienda, equipo[2], { archivo: 'index.html' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  const trabajando = corridas.map((c) => c.tarea.id).sort();
  assert.deepEqual(trabajando, [revision.id, enLaTienda.id].sort(),
    'la revisión lee TODO el sitio: nadie más lo toca mientras tanto');
  assert.equal(store.getTask(enElSitio.id).status, 'pending', 'el sitio queda quieto hasta que termine la revisión');
  assert.equal(store.getTask(enLaTienda.id).status, 'in_progress', 'la tienda es otro proyecto: no la frena nada');

  corridas.forEach((c) => c.terminar());
  await asentar();
  await motor.tick();

  assert.ok(corridas.some((c) => c.tarea.id === enElSitio.id), 'terminada la revisión, el sitio sigue');
  corridas.forEach((c) => c.terminar());
  await asentar();
});

test("if someone's task breaks, the person and the file stay free for the next one", async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const rota = encargar(store, goal, equipo[0], { archivo: 'index.html', texto: 'armar la home' });
  // The next one belongs to the SAME person and touches the SAME file: if
  // anything stayed taken, this one never starts.
  const siguiente = encargar(store, goal, equipo[0], { archivo: 'index.html', texto: 'sumar el formulario' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  assert.equal(corridas[0].tarea.id, rota.id);
  corridas[0].romper(new Error('se cayó el servicio a mitad de camino'));
  await asentar();

  assert.equal(motor.busyAgents.size, 0, 'la persona no queda ocupada para siempre');
  assert.equal(motor.busyFiles.size, 0, 'el archivo no queda tomado por un fantasma');
  assert.equal(motor.busyProjects.size, 0);

  await motor.tick();
  assert.equal(corridas.length, 2, 'el trabajo del proyecto sigue después de un tropiezo');
  assert.equal(corridas[1].tarea.id, siguiente.id);
  corridas[1].terminar();
  await asentar();
});

test('when a task gets stuck the user can read why, and nobody retries it forever', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const tarea = encargar(store, goal, equipo[0], { archivo: 'index.html' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();
  corridas[0].romper(new Error('la clave de API no tiene saldo'));
  await asentar();

  const trabada = store.getTask(tarea.id);
  assert.equal(trabada.status, 'blocked');
  assert.ok(trabada.blocked_reason, 'una tarea trabada sin motivo no le sirve a nadie');
  assert.match(trabada.blocked_reason, /saldo/, 'dice qué pasó, con las palabras del error real');

  // And it does not return to the queue on its own: without this, the team
  // would loop-retry the same broken task burning the key.
  assert.equal(store.workQueue(company.id).length, 0);
  await motor.tick();
  assert.equal(corridas.length, 1, 'no se reintenta sola');
  assert.equal(store.getTask(tarea.id).run_count, 1);
});

test('a project where everything got stuck is neither announced as done nor left frozen', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const sitio = store.createProject({ companyId: company.id, title: 'Sitio' });
  const tienda = store.createProject({ companyId: company.id, title: 'Tienda' });
  limpiarCarpetas(t, company.id, sitio, tienda);

  const rota = encargar(store, sitio, equipo[0], { archivo: 'index.html' });
  const enLaTienda = encargar(store, tienda, equipo[1], { archivo: 'index.html' });

  const motor = nuevoMotor(store);
  const corridas = enVuelo(motor);
  await motor.tick();

  corridas.find((c) => c.tarea.id === rota.id).romper(new Error('se cayó el servicio'));
  await asentar();

  // The neighbor's stuff is untouched: one project breaking does not drag the other.
  assert.equal(store.getGoal(tienda.id).status, 'active');
  assert.equal(store.getTask(enLaTienda.id).status, 'in_progress', 'la tienda sigue trabajando como si nada');

  // As for the broken project: the user must see clearly that it got stuck.
  assert.equal(motor.eventos.filter((e) => e.kind === 'goal_done' && e.goalId === sitio.id).length, 0,
    'no se le avisa "meta cumplida" por un proyecto donde no se entregó nada');
  assert.notEqual(store.getGoal(sitio.id).status, 'done', 'el proyecto quedó trabado, no terminado');

  // And whatever is asked later in that project still gets worked on.
  const pedidoNuevo = encargar(store, sitio, equipo[2], { archivo: 'estilos.css', texto: 'y ahora los estilos' });
  assert.ok(store.workQueue(company.id).some((t2) => t2.id === pedidoNuevo.id),
    'lo que pedís después de un error no puede quedar en el limbo');

  corridas.filter((c) => c.tarea.id !== rota.id).forEach((c) => c.terminar());
  await asentar();
});
