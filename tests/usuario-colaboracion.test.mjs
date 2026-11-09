import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { Store } from '../server/lib/store.js';
import { anotarEnBitacora, projectDir, Workforce } from '../server/lib/workforce.js';

// Los agentes trabajando JUNTOS: la consulta de pasillo, la revisión entre
// pares y la bitácora que se pasan de una corrida a la otra.
//
// Nada de red ni de modelos: todo lo que se prueba acá pasa ANTES o DESPUÉS de
// la llamada al modelo (a quién le llega la consulta, quién revisa, qué queda
// escrito). Los nombres de la plantilla no se usan nunca: se filtra por rol y
// se leen los nombres reales que devuelve el store.

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
    // La carpeta del proyecto y la de su empresa: el test no deja nada en workspace/.
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.dirname(dir), { recursive: true, force: true });
    store.close();
  });
  return { store, company, workforce, eventos, goal, equipo, dir };
}

// Una tarea encolada en el proyecto, como la que deja una reunión al cerrarse.
function encargar(store, goal, agente, { texto, archivo = 'index.html', kind = 'entregable', padre = null }) {
  const id = store.insertTask(null, agente.id, { text: texto, kind, parentTaskId: padre });
  store.assignTaskToGoal(id, goal.id, { kind, targetFile: archivo });
  return store.getTask(id);
}

// Cómo lo escribiría el modelo cuando no copia el nombre pelado.
const aMedias = (agente) => `${agente.name.toUpperCase()} (el que sabe del tema)`;

test('cuando nombran al compañero a medias, la consulta le llega igual a esa persona y a nadie más', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const companeros = equipo.filter((a) => a.id !== quienPregunta.id);
  // Alguien cuyo nombre no se confunda con el de otro dentro de la misma frase.
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
  assert.notEqual(respuesta.nota, 'no encontré a esa persona');
});

test('si preguntan por alguien que no trabaja en la empresa, no se molesta a nadie y les dicen quiénes están', async (t) => {
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

test('una consulta sin pregunta no le llega a nadie ni ensucia la actividad del proyecto', async (t) => {
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

test('cuando no nombran a nadie, contesta quien sabe del tema y no el primero de la lista', async (t) => {
  const { store, company, workforce, eventos, goal, equipo } = escenario(t);
  const quienPregunta = equipo.find((a) => a.role === 'worker');
  const companeros = equipo.filter((a) => a.id !== quienPregunta.id);

  // Una palabra de oficio que tenga UNA sola persona del equipo, y que no sea
  // justo la primera de la lista: si no, el test no distinguiría nada.
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
  // El modelo mandó la consulta sin el campo "a" (pasa: en workforce.js llega
  // como String(action.a || '') = ''). La pregunta tiene que caer en quien sabe.
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

test('el trabajo de cada uno lo revisa un compañero: nunca esa misma persona, ni el contratista, ni la CEO', (t) => {
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

  // Y si esa persona ya no está en la empresa, la revisión no queda en manos
  // de un fantasma: le toca a otro que sí esté.
  const autor = equipo.find((a) => a.role === 'worker');
  const tarea = encargar(store, goal, autor, { texto: 'terminar lo que quedó del jueves' });
  const natural = workforce.pickReviewer(company.id, autor, tarea);
  store.archiveAgent(natural.id, 'test');
  const reemplazo = workforce.pickReviewer(company.id, autor, tarea);
  assert.notEqual(reemplazo.id, natural.id, 'no se le pide revisar a alguien que ya no trabaja acá');
  assert.equal(store.getAgent(reemplazo.id).status, 'active');
});

test('no se le pide a nadie revisar lo que no dejó archivos, ni revisar dos veces lo mismo', (t) => {
  const { store, company, workforce, goal, equipo } = escenario(t);
  const autor = equipo.find((a) => a.role === 'worker');
  const revisiones = () => store.tasksForGoal(goal.id).filter((x) => x.kind === 'revision');

  // Una tarea que no produjo nada no tiene qué mirar: pedir esa revisión le
  // quema una corrida a un compañero para nada.
  const sinArchivos = encargar(store, goal, autor, { texto: 'pensar el enfoque de la home', archivo: null });
  workforce.requestReview(company.id, autor, sinArchivos, []);
  assert.equal(revisiones().length, 0, 'sin archivos no hay nada que revisar');

  // Con archivos sí, y lo que la máquina ya midió le llega anotado al revisor
  // para que no vuelva a buscar lo mismo.
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

  // La misma tarea reintentada no le vuelve a caer al revisor.
  workforce.requestReview(company.id, autor, store.getTask(entregable.id), ['index.html']);
  assert.equal(revisiones().length, 1, 'a nadie le llega dos veces la misma revisión');

  // La corrección que sale de una revisión tampoco se revisa: ahí termina el
  // ida y vuelta, en vez de seguir para siempre.
  const correccion = encargar(store, goal, autor, {
    texto: 'aplicar lo que pidió la revisión', padre: entregable.id
  });
  workforce.requestReview(company.id, autor, correccion, ['index.html']);
  assert.equal(revisiones().length, 1, 'la corrección de una revisión no dispara otra revisión');
});

test('el que agarra el proyecto después se entera de lo que dejó pendiente el anterior', async (t) => {
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

  // Vive en la carpeta del proyecto, que es donde la busca la próxima corrida.
  const texto = bitacora();
  assert.ok(texto.includes(primero.name), 'está quién trabajó antes');
  assert.ok(texto.includes(segundo.name), 'y quién trabajó después');
  assert.match(texto, /falta el formulario de contacto/, 'el pendiente se lo lleva el que sigue');
  assert.ok(
    texto.indexOf('Unifiqué la paleta') > texto.indexOf('falta el formulario de contacto'),
    'se lee en orden: lo último, abajo'
  );
  assert.equal(texto.match(/# Project log/g).length, 1, 'una sola cabecera');

  // Con los meses la bitácora crece. Se recorta, pero lo que sobrevive tiene
  // que ser lo reciente: es lo que le sirve al que entra ahora.
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
