import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Store } from '../server/lib/store.js';
import { renderConciencia, estadoVivo, TOPE_CONCIENCIA } from '../server/lib/conciencia.js';

const plantillas = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

// Filter by role, never by template name: templates change.
function escenario() {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(
    plantillas.templates.find((t) => t.id === 'web'), 'test'
  );
  const goal = store.createProject({ companyId: company.id, title: 'Sitio del club' });
  const equipo = store.listAgents({ companyId: company.id }).filter((a) => a.role === 'worker');
  return { store, company, goal, equipo };
}

// A task with its file and its owner, in whatever state the case needs.
function tarea(store, goal, agente, { archivo = null, estado = 'pending', kind = 'entregable', phase = 2, texto = null, padre = null } = {}) {
  const id = store.insertTask(null, agente.id, {
    text: texto || `escribir ${archivo || 'algo'}`,
    kind,
    parentTaskId: padre
  });
  store.assignTaskToGoal(id, goal.id, { kind, targetFile: archivo, phase });
  if (estado === 'in_progress') {
    store.checkoutTask(id);
  } else if (estado !== 'pending') {
    store.finishTask(id, { status: estado, summary: 'listo' });
  }
  return store.getTask(id);
}

test('sees the teammate writing RIGHT NOW, with name and file', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const otro = equipo[1];
  const mia = tarea(store, goal, yo, { archivo: 'app.js', estado: 'in_progress' });
  tarea(store, goal, otro, { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: mia.target_file
  });

  assert.match(bloque, /AHORA/);
  assert.match(bloque, new RegExp(otro.name), 'dice quién está trabajando');
  assert.match(bloque, /index\.html/, 'y en qué archivo');
});

test('does not see itself working: that would read as someone else having taken the file', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const mia = tarea(store, goal, yo, { archivo: 'app.js', estado: 'in_progress' });
  tarea(store, goal, equipo[1], { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: mia.target_file
  });

  const enCurso = bloque.split('\n').find((l) => l.startsWith('AHORA'));
  assert.ok(enCurso, 'hay línea de AHORA');
  assert.ok(!enCurso.includes('app.js'), 'su propio archivo no figura como tomado por otro');
  assert.ok(!enCurso.includes(yo.name), 'no aparece a sí mismo por nombre');
});

test('knows what is already DONE, by whom, and that it gets edited instead of redone', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const autora = equipo[1];
  tarea(store, goal, autora, { archivo: 'index.html', estado: 'done' });
  const mia = tarea(store, goal, yo, { archivo: 'app.js', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: mia.target_file
  });

  assert.match(bloque, /LISTO: index\.html/);
  assert.match(bloque, new RegExp(autora.name));
  assert.match(bloque, /edit_file/, 'la regla de editar lo entregado viaja con el dato');
  assert.match(bloque, /no lo rehagas|no rehagas/i);
});

test('what you delivered yourself says "vos", so it is not attributed to a teammate', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  tarea(store, goal, yo, { archivo: 'tokens.css', estado: 'done' });
  const mia = tarea(store, goal, yo, { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: mia.target_file
  });

  assert.match(bloque, /tokens\.css \(vos\)/);
});

test('the queue says who each waiting thing depends on', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const otro = equipo[1];
  const tercero = equipo[2] || equipo[1];
  // The other one holds index.html RIGHT NOW; whatever waits on that same file
  // depends on them, not on luck.
  tarea(store, goal, otro, { archivo: 'index.html', estado: 'in_progress' });
  tarea(store, goal, tercero, { archivo: 'index.html', estado: 'pending' });
  const mia = tarea(store, goal, yo, { archivo: 'app.js', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: mia.target_file
  });

  const enCola = bloque.split('\n').find((l) => l.startsWith('EN COLA'));
  assert.ok(enCola, 'hay línea de cola');
  assert.match(enCola, new RegExp(otro.name), 'nombra a quien tiene el archivo');
});

test('a queued review waits for the author of the deliverable it reviews', () => {
  const { store, goal, equipo } = escenario();
  const autor = equipo[0];
  const qa = equipo[1];
  const entregable = tarea(store, goal, autor, { archivo: 'index.html', estado: 'done' });
  tarea(store, goal, qa, { kind: 'revision', estado: 'pending', texto: 'revisar la home', padre: entregable.id });
  const mia = tarea(store, goal, equipo[2] || autor, { archivo: 'app.js', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: (equipo[2] || autor).id, taskId: mia.id, miArchivo: 'app.js'
  });

  assert.match(bloque, /EN COLA/);
  assert.match(bloque, new RegExp(`tras ${autor.name}`), 'la revisión cuelga de quien entregó');
});

test('the file I need goes FIRST if someone else is writing it', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  // Three teammates working; the one that matters is whoever holds MY file.
  const otros = equipo.filter((a) => a.id !== yo.id);
  tarea(store, goal, otros[0], { archivo: 'datos.json', estado: 'in_progress' });
  tarea(store, goal, otros[1] || otros[0], { archivo: 'estilos.css', estado: 'in_progress' });
  const duenoDelMio = otros[2] || otros[0];
  tarea(store, goal, duenoDelMio, { archivo: 'index.html', estado: 'in_progress' });
  const mia = tarea(store, goal, yo, { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'index.html'
  });

  const enCurso = bloque.split('\n').find((l) => l.startsWith('AHORA'));
  assert.ok(enCurso.indexOf('index.html') < enCurso.indexOf('datos.json'), 'mi archivo primero');
  assert.match(bloque, /consultar/, 'y le dice qué hacer: preguntar en vez de duplicar');
});

test('without a team it makes no noise: the block stays empty', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const mia = tarea(store, goal, yo, { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'index.html'
  });

  assert.equal(bloque, '', 'un agente solo en su proyecto no lee un cartel vacío');
});

test('decisions and follow-ups do not pollute the team present', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  tarea(store, goal, equipo[1], { kind: 'decision', texto: 'usar verde oscuro como color base' });
  tarea(store, goal, equipo[1], { kind: 'seguimiento', texto: 'preguntarle al usuario por el logo' });
  const mia = tarea(store, goal, yo, { archivo: 'index.html', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'index.html'
  });

  assert.equal(bloque, '', 'nadie trabaja un acuerdo: en el estado vivo no existe');
});

test('without a project there is no block (and nothing blows up)', () => {
  const { store, equipo } = escenario();
  assert.equal(renderConciencia(store, { goalId: null, agentId: equipo[0].id }), '');
  assert.deepEqual(estadoVivo(store, null), { ahora: [], listos: [], cola: [] });
});

test('with 20 tasks the block does not grow: it stays under the 900 cap', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  for (let i = 0; i < 20; i += 1) {
    const agente = equipo[i % equipo.length];
    const estados = ['in_progress', 'done', 'pending'];
    tarea(store, goal, agente, {
      archivo: `src/pantallas/PantallaMuyLargaDeNombre${i}.jsx`,
      estado: estados[i % 3],
      phase: 2 + (i % 3),
      texto: `escribir la pantalla numero ${i} con un texto de tarea deliberadamente largo para inflar el bloque`
    });
  }
  const mia = tarea(store, goal, yo, { archivo: 'App.jsx', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'App.jsx'
  });

  assert.ok(bloque.length <= TOPE_CONCIENCIA, `mide ${bloque.length}, tope ${TOPE_CONCIENCIA}`);
  assert.match(bloque, /AHORA/, 'lo que se recorta es la cola, no quién puede chocar con vos');
  assert.match(bloque, /\+\d+/, 'lo que no entró se cuenta en vez de desaparecer sin más');
  assert.match(bloque, /es tuyo/, 'la regla que lo desbloquea nunca se cae');
});

test('a long path keeps the file name, not the folder', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  const largo = 'app/src/main/java/com/equipo/app/ui/PantallaDelAhorcado.kt';
  tarea(store, goal, equipo[1], { archivo: largo, estado: 'in_progress' });
  const mia = tarea(store, goal, yo, { archivo: 'App.kt', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'App.kt'
  });

  assert.match(bloque, /PantallaDelAhorcado\.kt/, 'lo que distingue una pantalla de otra sobrevive');
  assert.ok(!bloque.includes('app/src/main/java/com/equipo/app/ui/PantallaDelAhorcado.kt'), 'y la ruta entera no se paga');
});

test('the cap is hard even when squeezed to the absurd', () => {
  const { store, goal, equipo } = escenario();
  const yo = equipo[0];
  for (let i = 0; i < 12; i += 1) {
    tarea(store, goal, equipo[i % equipo.length], { archivo: `archivo-${i}.js`, estado: i % 2 ? 'done' : 'in_progress' });
  }
  const mia = tarea(store, goal, yo, { archivo: 'App.jsx', estado: 'in_progress' });

  const bloque = renderConciencia(store, {
    goalId: goal.id, agentId: yo.id, taskId: mia.id, miArchivo: 'App.jsx', tope: 200
  });
  assert.ok(bloque.length <= 200, `mide ${bloque.length}`);
});

test('the engine injects it into BOTH paths of the work prompt', () => {
  const fuente = readFileSync(new URL('../server/lib/workforce.js', import.meta.url), 'utf-8');
  const trabajo = fuente.slice(fuente.indexOf('async executeWork('));
  const header = trabajo.slice(trabajo.indexOf('const header = ['), trabajo.indexOf('let lastObservation'));
  const liviano = trabajo.slice(trabajo.indexOf('const headerLiviano'), trabajo.indexOf('for (let step = 1'));

  assert.match(trabajo, /renderConciencia\(/, 'la corrida arma el bloque');
  assert.match(header, /bloqueConciencia/, 'va en el paso 1');
  assert.match(liviano, /bloqueConciencia/, 'y en los pasos livianos');
});
