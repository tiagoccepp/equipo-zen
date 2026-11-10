import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { Store } from '../server/lib/store.js';
import { anotarEnBitacora, projectDir, Workforce } from '../server/lib/workforce.js';

// Agents working TOGETHER: the hallway consult, peer review, and the logbook
// passed from one run to the next.
//
// No network nor models: everything tested here happens BEFORE or AFTER the
// model call (who the consult reaches, who reviews, what stays written).
// Template names are never used: filter by role and read the real names the
// store returns.

const plantillas = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function escenario(t, { titulo = 'Sitio nuevo' } = {}) {
  const store = new Store(':memory:');
  const company = store.createCompanyFromTemplate(plantillas.templates.find((x) => x.id === 'web'), 'test');
  const eventos = [];
  const workforce = new Workforce(store, { hasKeys: () => true }, { onEvent: (_id, payload) => eventos.push(payload) });
  const goal = store.createProject({ companyId: company.id, title: titulo });
  const equipo = store.listAgents({ companyId: company.id });
  const dir = projectDir(company.id, goal.slug);
  t.after(() => {
    // The project folder and its company's: the test leaves nothing in workspace/.
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.dirname(dir), { recursive: true, force: true });
    store.close();
  });
  return { store, company, workforce, eventos, goal, equipo, dir };
}

// A task queued in the project, like the one a meeting leaves when closing.
function encargar(store, goal, agente, { texto, archivo = 'index.html', kind = 'entregable', padre = null }) {
  const id = store.insertTask(null, agente.id, { text: texto, kind, parentTaskId: padre });
  store.assignTaskToGoal(id, goal.id, { kind, targetFile: archivo });
  return store.getTask(id);
}

// How the model would write it when it does not copy the bare name.
const aMedias = (agente) => `${agente.name.toUpperCase()} (el que sabe del tema)`;

test('when the teammate is named halfway, the consult still reaches that person and nobody else', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const companeros = equipo.filter((a) => a.id !== quienPregunta.id);
  // Someone whose name cannot be confused with another's inside the same sentence.
  const destino = companeros.find((c) => companeros.every(
    (otro) => otro.id === c.id || !aMedias(c).toLowerCase().includes(otro.name.toLowerCase())
  ));
  assert.ok(destino, 'hay a quién preguntarle');
  const tarea = encargar(store, goal, quienPregunta, { texto: 'armar la home' });

  const respuesta = await workforce.consultarCompanero(company.id, {
    quienPregunta,
    aQuien: aMedias(destino),
    pregunta: '¿cuánto aire dejo entre bloques?',
    goal,
    slug: goal.slug,
    task: tarea
  });

  const consultas = eventos.filter((e) => e.kind === 'consulta');
  assert.equal(consultas.length, 1, 'se interrumpe a una sola persona, no a media empresa');
  assert.equal(consultas[0].agentName, destino.name, 'le llega a quien nombró, aunque lo haya escrito distinto');
  assert.equal(consultas[0].dePersona, quienPregunta.name, 'se ve quién preguntó');
  assert.equal(consultas[0].taskId, tarea.id, 'la consulta queda colgada de la tarea en la que estaba trabajando');
  assert.notEqual(respuesta.nota, 'person not found');
});

test('if they ask about someone who does not work at the company, nobody is bothered and they are told who is there', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const companeros = equipo.filter((a) => a.id !== quienPregunta.id);
  const tarea = encargar(store, goal, quienPregunta, { texto: 'armar la home' });

  const inventado = 'Zutano Mengánez';
  assert.ok(
    equipo.every((a) => !inventado.toLowerCase().includes(a.name.toLowerCase())),
    'el nombre inventado no se parece al de nadie del equipo'
  );
  const pregunta = '¿esto lo hacemos con banana o con papaya?';
  assert.equal(workforce.mejorParaLaPregunta(companeros, pregunta), null, 'la pregunta no es del palo de nadie');

  const respuesta = await workforce.consultarCompanero(company.id, {
    quienPregunta, aQuien: inventado, pregunta, goal, slug: goal.slug, task: tarea
  });

  assert.equal(respuesta.ok, false);
  assert.equal(eventos.filter((e) => e.kind === 'consulta').length, 0, 'no se interrumpió a nadie por un nombre que no existe');
  assert.ok(respuesta.observacion.includes(inventado), 'le dice cuál es el nombre que no encontró');
  for (const companero of companeros) {
    assert.ok(respuesta.observacion.includes(companero.name), `le dice que puede preguntarle a ${companero.name}`);
  }
  assert.equal(store.taskComments(tarea.id).length, 0, 'no queda registrada una charla que nunca pasó');
});

test('a consult without a question reaches nobody and does not dirty the project activity', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const destino = equipo.find((a) => a.role === 'worker' && a.id !== quienPregunta.id);
  const tarea = encargar(store, goal, quienPregunta, { texto: 'armar la home' });

  const respuesta = await workforce.consultarCompanero(company.id, {
    quienPregunta, aQuien: destino.name, pregunta: '   \n  ', goal, slug: goal.slug, task: tarea
  });

  assert.equal(respuesta.ok, false);
  assert.equal(eventos.length, 0, `a ${destino.name} no le llegó nada`);
  assert.equal(store.taskComments(tarea.id).length, 0, 'no queda un comentario vacío en la tarea');
  assert.equal(store.commentsForProject(goal.id).length, 0, 'ni en la actividad del proyecto');
  assert.match(respuesta.observacion, /pregunta/i, 'le explican cómo se pregunta en vez de dejarlo colgado');
});

test('when nobody is named, whoever knows the topic answers, not the first on the list', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const companeros = equipo.filter((a) => a.id !== quienPregunta.id);

  // A trade word held by ONE single person on the team, and not exactly
  // the first on the list: otherwise the test would distinguish nothing.
  const cuantos = new Map();
  for (const companero of companeros) {
    for (const skill of companero.domains.filter((d) => /^[a-záéíóúñ]{5,}$/.test(d))) {
      cuantos.set(skill, (cuantos.get(skill) || 0) + 1);
    }
  }
  const skill = [...cuantos.keys()].find((d) => cuantos.get(d) === 1
    && companeros.find((c) => c.domains.includes(d)).id !== companeros[0].id);
  assert.ok(skill, 'el equipo tiene oficios distintos entre sí');
  const experto = companeros.find((c) => c.domains.includes(skill));
  const pregunta = `tengo una duda de ${skill} acá`;

  assert.equal(
    workforce.mejorParaLaPregunta(companeros, pregunta)?.id,
    experto.id,
    'el criterio para elegir a quién le toca está bien: es quien tiene ese oficio'
  );

  const tarea = encargar(store, goal, quienPregunta, { texto: 'armar la home' });
  // The model sent the consult without the "to" field (it happens: in workforce.js
  // it arrives as String(action.a || '') = ''). The question must land on whoever knows.
  await workforce.consultarCompanero(company.id, {
    quienPregunta, aQuien: '', pregunta, goal, slug: goal.slug, task: tarea
  });

  const consulta = eventos.find((e) => e.kind === 'consulta');
  assert.ok(consulta, 'alguien tiene que contestar');
  assert.equal(
    consulta.agentName,
    experto.name,
    `sin destinatario la pregunta de ${skill} tiene que ir a ${experto.name}, no a ${companeros[0].name}`
  );
});

test("everyone's work is reviewed by a teammate: never that same person, nor the contractor, nor the CEO", (t) => {
  const { store, company, workforce, goal, equipo } = escenario(t);

  for (const autor of equipo) {
    const tarea = encargar(store, goal, autor, { texto: 'terminar lo que quedó del jueves' });
    const revisor = workforce.pickReviewer(company.id, autor, tarea);
    assert.ok(revisor, `alguien tiene que poder revisar el trabajo de ${autor.name}`);
    assert.notEqual(revisor.id, autor.id, `${autor.name} no puede ser su propio revisor`);
    assert.notEqual(revisor.role, 'contratista', 'el contratista no revisa entregables: no es lo suyo');
    assert.equal(revisor.status, 'active');
    if (equipo.some((a) => a.id !== autor.id && a.role === 'worker')) {
      assert.notEqual(revisor.role, 'ceo', 'la CEO no termina revisando todo lo que produce la empresa');
    }
  }

  // And if that person is no longer at the company, the review does not stay
  // in a ghost's hands: it goes to someone who is.
  const autor = equipo.find((a) => a.role === 'worker');
  const tarea = encargar(store, goal, autor, { texto: 'terminar lo que quedó del jueves' });
  const natural = workforce.pickReviewer(company.id, autor, tarea);
  store.archiveAgent(natural.id, 'test');
  const reemplazo = workforce.pickReviewer(company.id, autor, tarea);
  assert.notEqual(reemplazo.id, natural.id, 'no se le pide revisar a alguien que ya no trabaja acá');
  assert.equal(store.getAgent(reemplazo.id).status, 'active');
});

test('nobody is asked to review what left no files, nor to review the same thing twice', (t) => {
  const { store, company, workforce, goal, equipo } = escenario(t);
  const autor = equipo.find((a) => a.role === 'worker');
  const revisiones = () => store.tasksForGoal(goal.id).filter((x) => x.kind === 'revision');

  // A task that produced nothing has nothing to look at: requesting that review
  // burns a run from a teammate for nothing.
  const sinArchivos = encargar(store, goal, autor, { texto: 'pensar el enfoque de la home', archivo: null });
  workforce.requestReview(company.id, autor, sinArchivos, []);
  assert.equal(revisiones().length, 0, 'sin archivos no hay nada que revisar');

  // With files yes, and what the machine already measured reaches the reviewer
  // annotated so they do not search for the same thing again.
  const entregable = encargar(store, goal, autor, { texto: 'armar la home' });
  workforce.requestReview(company.id, autor, entregable, ['index.html'], [
    { archivo: 'index.html', que: 'el enlace a contacto.html apunta a un archivo que no existe' }
  ]);
  assert.equal(revisiones().length, 1, 'se le pidió la revisión a alguien');
  assert.equal(revisiones()[0].parent_task_id, entregable.id);
  assert.equal(revisiones()[0].status, 'pending', 'entra a la cola de trabajo');
  assert.ok(store.workQueue(company.id).some((x) => x.id === revisiones()[0].id), 'el revisor la va a agarrar');
  assert.equal(store.getTask(entregable.id).review_status, 'pendiente');
  assert.equal(store.getTask(entregable.id).reviewer_id, revisiones()[0].agent_id, 'queda escrito quién revisa a quién');

  const medido = store.taskComments(entregable.id).find((c) => c.author_id === 'verificacion');
  assert.ok(medido, 'lo que ya detectó la verificación queda anotado en la tarea');
  assert.match(medido.text, /contacto\.html/);
  assert.ok(store.commentsForProject(goal.id).some((c) => c.id === medido.id), 'y se ve en la actividad del proyecto');

  // The same retried task does not fall on the reviewer again.
  workforce.requestReview(company.id, autor, store.getTask(entregable.id), ['index.html']);
  assert.equal(revisiones().length, 1, 'a nadie le llega dos veces la misma revisión');

  // The fix coming out of a review is not reviewed either: the back-and-forth
  // ends there instead of going on forever.
  const correccion = encargar(store, goal, autor, {
    texto: 'aplicar lo que pidió la revisión', padre: entregable.id
  });
  workforce.requestReview(company.id, autor, correccion, ['index.html']);
  assert.equal(revisiones().length, 1, 'la corrección de una revisión no dispara otra revisión');
});

test('whoever picks up the project later learns what the previous one left pending', async (t) => {
  const { goal, equipo, dir } = escenario(t);
  const [primero, segundo] = equipo.filter((a) => a.role === 'worker');
  mkdirSync(dir, { recursive: true });
  const bitacora = () => readFileSync(path.join(dir, 'BITACORA.md'), 'utf-8');

  await anotarEnBitacora(dir, {
    agente: primero.name,
    tarea: 'armar la home',
    resumen: 'Dejé index.html con el hero y la grilla de servicios.',
    pendiente: 'falta el formulario de contacto'
  });
  await anotarEnBitacora(dir, {
    agente: segundo.name,
    tarea: 'unificar los estilos',
    resumen: 'Unifiqué la paleta en tokens.css.'
  });

  // It lives in the project folder, which is where the next run looks for it.
  const texto = bitacora();
  assert.ok(texto.includes(primero.name), 'está quién trabajó antes');
  assert.ok(texto.includes(segundo.name), 'y quién trabajó después');
  assert.match(texto, /falta el formulario de contacto/, 'el pendiente se lo lleva el que sigue');
  assert.ok(
    texto.indexOf('Unifiqué la paleta') > texto.indexOf('falta el formulario de contacto'),
    'se lee en orden: lo último, abajo'
  );
  assert.equal(texto.match(/# Project log/g).length, 1, 'una sola cabecera');

  // Over the months the logbook grows. It gets trimmed, but what survives must
  // be the recent stuff: that is what serves whoever comes in now.
  for (let i = 0; i < 60; i += 1) {
    await anotarEnBitacora(dir, {
      agente: segundo.name,
      tarea: `vuelta ${i}`,
      resumen: `traspaso número ${i}. ${'detalle '.repeat(45)}`
    });
  }

  const larga = bitacora();
  assert.ok(larga.length < 22000, `la bitácora no crece sin techo (quedó en ${larga.length})`);
  assert.match(larga, /traspaso número 59\./, 'lo último que pasó sigue estando');
  assert.doesNotMatch(larga, /falta el formulario de contacto/, 'lo viejo se cae antes que lo nuevo');
  assert.equal(larga.match(/# Project log/g).length, 1, 'sigue teniendo una sola cabecera');
});
