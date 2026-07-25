import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../server/lib/store.js';
import { extractFileContent, readProjectState, safeWorkspacePath, Workforce } from '../server/lib/workforce.js';

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

test('quien entra a un proyecto ya empezado ve el contenido y su identidad visual', async () => {
  // El caso real: Bruno hizo la web y Delia entró después. Sin esto, Delia
  // regeneraba index.html con su propio estilo y borraba el trabajo.
  const dir = mkdtempSync(path.join(tmpdir(), 'equipo-proy-'));
  writeFileSync(path.join(dir, 'index.html'), [
    '<!doctype html><html lang="es"><head><style>',
    ':root { --tinta: #1c1b19; --acento: #31655a; --papel: #f4f1ea; }',
    'body { font-family: "Inter", system-ui, sans-serif; }',
    '</style></head><body>',
    '<header class="hero"><h1 class="titulo">NovaTech</h1></header>',
    '<section id="servicios" class="bloque"><h2>Nuestras soluciones</h2></section>',
    '<footer id="contacto" class="pie"></footer>',
    '</body></html>'
  ].join('\n'));

  const estado = await readProjectState(dir, ['index.html']);
  assert.equal(estado.principal, 'index.html');
  assert.ok(estado.contenido.includes('NovaTech'), 'el contenido real viaja al prompt');

  const identidad = estado.identidad.join('\n');
  assert.match(identidad, /--acento: #31655a/, 'la paleta existente se le muestra');
  assert.match(identidad, /Inter/, 'la tipografía existente se le muestra');
  assert.match(identidad, /hero|titulo|bloque/, 'las clases existentes, para reusarlas');
  assert.match(identidad, /servicios|contacto/, 'las secciones ya armadas');

  rmSync(dir, { recursive: true, force: true });
});

test('un proyecto vacío no arrastra identidad de nadie', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'equipo-vacio-'));
  assert.equal(await readProjectState(dir, []), null);
  rmSync(dir, { recursive: true, force: true });
});

test('dos empleados no trabajan a la vez sobre el mismo proyecto', async () => {
  // Bruno y Delia escribiendo index.html en paralelo se sobreescribían.
  const { store, company, workforce } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const meeting = store.createMeeting({ companyId: company.id });
  const goal = store.createGoal({ companyId: company.id, meetingId: meeting.id, title: 'Web nueva' });

  for (const nombre of ['Bruno', 'Sofía']) {
    const agente = team.find((a) => a.name === nombre);
    const id = store.insertTask(meeting.id, agente.id, { text: `parte de ${nombre}` });
    store.assignTaskToGoal(id, goal.id, { kind: 'entregable' });
  }

  // Se intercepta la ejecución: interesa el arbitraje, no el trabajo real.
  const arrancadas = [];
  workforce.executeTask = async (companyId, agent) => {
    arrancadas.push(agent.name);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  workforce.keyRing = { hasKeys: () => true };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'entra uno solo; el otro espera su turno');

  // Liberado el proyecto, entra el segundo.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await workforce.tick();
  assert.equal(arrancadas.length, 2);
  assert.notEqual(arrancadas[0], arrancadas[1]);
});
