import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { projectDir, Workforce } from '../server/lib/workforce.js';

// El equipo produciendo: la cola, el checkout, los cerrojos y qué ve el usuario
// cuando algo sale mal. Nada de red ni de modelo: se intercepta executeTask, que
// es justo el pedazo que habla con la nube.

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function nuevaEmpresa() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    companyTemplates.templates.find((t) => t.id === 'web'), 'test'
  );
  // Por rol, nunca por nombre: la plantilla cambia y los tests no.
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  return { store, company, equipo };
}

function nuevoMotor(store) {
  const workforce = new Workforce(store, { hasKeys: () => true });
  const eventos = [];
  // El motor real avisa por telemetría y deja rastro en el diario de la empresa
  // (disco). Acá se junta en memoria: es el MISMO payload que le llega a la UI.
  workforce.emitEvent = (_companyId, event) => eventos.push(event);
  workforce.eventos = eventos;
  return workforce;
}

// Fechas fijas y crecientes: la cola ordena por fecha de creación y dos tareas
// creadas en el mismo milisegundo dejarían el orden librado al azar.
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

// Cada corrida queda EN VUELO hasta que el test la termina a mano: el cerrojo se
// sostiene exactamente el tiempo que hace falta, sin sleeps ni relojes.
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

// Deja que el motor termine de acomodar lo que quedó colgado: los `finally` que
// sueltan cerrojos corren como microtareas, y setImmediate va después de todas.
const asentar = () => new Promise((resolve) => setImmediate(resolve));

function limpiarCarpetas(t, companyId, ...goals) {
  t.after(() => {
    for (const goal of goals) {
      rmSync(projectDir(companyId, goal.slug), { recursive: true, force: true });
    }
  });
}

test('lo que quedó anotado como acuerdo en la reunión no pone a nadie a trabajar', async (t) => {
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
  // Y los acuerdos siguen visibles en el tablero, sin que nadie los "trabaje".
  assert.equal(store.getTask(acuerdo.id).status, 'noted');
  assert.equal(store.getTask(seguimiento.id).status, 'noted');

  corridas[0].terminar();
  await asentar();
});

test('nadie se pone a hacer una tarea que otro ya tomó', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const tarea = encargar(store, goal, equipo[0], { archivo: 'index.html' });

  // Los dos motores miran la MISMA foto de la cola (con la tarea todavía
  // pendiente). Lo único que puede evitar que el trabajo se haga —y se pague—
  // dos veces es que quedarse con la tarea sea atómico.
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

test('dos personas construyen el mismo sitio a la vez, cada una en su archivo', async (t) => {
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

test('si dos quedaron con el mismo archivo no lo escriben a la vez, y el segundo no se pierde', async (t) => {
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

  // Y sigue esperando en la cola: no se descarta ni se da por hecha.
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

test('una persona no arranca lo segundo hasta terminar lo primero, aunque sean archivos distintos', async (t) => {
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

test('mientras alguien revisa un proyecto entero ese proyecto se frena, pero el de al lado sigue', async (t) => {
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

test('si a alguien se le rompe la tarea, la persona y el archivo quedan libres para la que sigue', async (t) => {
  const { store, company, equipo } = nuevaEmpresa();
  const goal = store.createProject({ companyId: company.id, title: 'Sitio' });
  limpiarCarpetas(t, company.id, goal);

  const rota = encargar(store, goal, equipo[0], { archivo: 'index.html', texto: 'armar la home' });
  // La siguiente es de la MISMA persona y sobre el MISMO archivo: si algo quedó
  // tomado, esta no arranca nunca.
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

test('cuando una tarea queda trabada el usuario puede leer por qué, y nadie la reintenta para siempre', async (t) => {
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

  // Y no vuelve sola a la cola: sin esto, el equipo reintentaría en loop la
  // misma tarea rota quemando la clave.
  assert.equal(store.workQueue(company.id).length, 0);
  await motor.tick();
  assert.equal(corridas.length, 1, 'no se reintenta sola');
  assert.equal(store.getTask(tarea.id).run_count, 1);
});

test('un proyecto donde todo se trabó no se anuncia como cumplido ni queda congelado', async (t) => {
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

  // Lo del vecino no se toca: que un proyecto se rompa no arrastra al otro.
  assert.equal(store.getGoal(tienda.id).status, 'active');
  assert.equal(store.getTask(enLaTienda.id).status, 'in_progress', 'la tienda sigue trabajando como si nada');

  // Lo del proyecto roto: al usuario le tiene que quedar claro que quedó trabado.
  assert.equal(motor.eventos.filter((e) => e.kind === 'goal_done' && e.goalId === sitio.id).length, 0,
    'no se le avisa "meta cumplida" por un proyecto donde no se entregó nada');
  assert.notEqual(store.getGoal(sitio.id).status, 'done', 'el proyecto quedó trabado, no terminado');

  // Y lo que se pida después en ese proyecto tiene que trabajarse igual.
  const pedidoNuevo = encargar(store, sitio, equipo[2], { archivo: 'estilos.css', texto: 'y ahora los estilos' });
  assert.ok(store.workQueue(company.id).some((t2) => t2.id === pedidoNuevo.id),
    'lo que pedís después de un error no puede quedar en el limbo');

  corridas.filter((c) => c.tarea.id !== rota.id).forEach((c) => c.terminar());
  await asentar();
});
