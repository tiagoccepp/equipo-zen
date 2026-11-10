import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../server/lib/store.js';
import {
  anotarEnBitacora,
  applyEdit,
  extractFileContent,
  leerTokens,
  projectDir,
  readProjectState,
  safeWorkspacePath,
  splitBeforeHeredoc,
  Workforce
} from '../server/lib/workforce.js';
import { mkdirSync } from 'node:fs';

const companyTemplates = JSON.parse(readFileSync(new URL('../server/company-templates.json', import.meta.url), 'utf-8'));

function newCompany() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web');
  const company = store.createCompanyFromTemplate(template, 'test');
  const events = [];
  const workforce = new Workforce(store, { hasKeys: () => false }, {
    onEvent: (companyId, payload) => events.push(payload)
  });
  return { store, company, workforce, events };
}

test('the sandbox does not let escapes from the project folder', () => {
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '../otra/index.html'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '/etc/passwd'), /inválida/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', '.env'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', 'script.sh'), /Extensión no permitida/);
  assert.throws(() => safeWorkspacePath('emp1', 'proy', 'nested/../../fuera.html'), /fuera del proyecto/);

  const ok = safeWorkspacePath('emp1', 'proy', 'css/estilos.css');
  assert.match(ok, /emp1\/proy\/css\/estilos\.css$/);
});

test('file content is accepted in any of its shapes', () => {
  assert.equal(
    extractFileContent('{"action":"write_file","path":"a.html"}\n<<<CONTENIDO\n<h1>hola</h1>\nCONTENIDO>>>', {}),
    '<h1>hola</h1>'
  );
  assert.equal(extractFileContent('nada', { content: '<h1>x</h1>' }), '<h1>x</h1>');
  assert.equal(extractFileContent('nada', { text: '<h1>x</h1>' }), '<h1>x</h1>');
  assert.equal(extractFileContent('nada', {}), '');
});

test('a teammate with matching skills reviews, never the author themselves', () => {
  const { store, company, workforce } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const bruno = team.find((a) => a.name === 'Bruno');

  const reviewer = workforce.pickReviewer(company.id, bruno, { text: 'crear la página web institucional' });
  assert.ok(reviewer, 'siempre hay alguien que pueda revisar');
  assert.notEqual(reviewer.id, bruno.id, 'nadie se revisa a sí mismo');
  assert.notEqual(reviewer.role, 'contratista', 'el contratista no revisa entregables');
});

test('when a deliverable finishes, a teammate is asked to review', () => {
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

  // The queue is picked up by the reviewer.
  assert.ok(store.workQueue(company.id).some((t) => t.id === revisiones[0].id));
});

test('what produced no files is not reviewed, nor are fixes (avoids the infinite back-and-forth)', () => {
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

test('each project gets its folder even if the title repeats', () => {
  const { store, company } = newCompany();
  const a = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  const b = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  const c = store.createGoal({ companyId: company.id, title: 'Sitio web' });
  assert.equal(a.slug, 'sitio-web');
  assert.equal(b.slug, 'sitio-web-2');
  assert.equal(c.slug, 'sitio-web-3');
});

test('whoever joins a project already started sees the content and its visual identity', async () => {
  // The real case: Bruno made the web and Delia joined later. Without this,
  // Delia regenerated index.html in her own style and wiped the work.
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

test('an empty project carries no identity from anyone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'equipo-vacio-'));
  assert.equal(await readProjectState(dir, []), null);
  rmSync(dir, { recursive: true, force: true });
});

test('two employees do not work at once on the same project', async (t) => {
  // Bruno and Delia writing index.html in parallel overwrote each other.
  const { store, company, workforce } = newCompany();
  const team = store.listAgents({ companyId: company.id });
  const meeting = store.createMeeting({ companyId: company.id });
  const goal = store.createGoal({ companyId: company.id, meetingId: meeting.id, title: 'Web nueva' });

  // Two producing ones, without depending on the names of any concrete template.
  const productores = team.filter((a) => a.role === 'worker').slice(0, 2);
  assert.equal(productores.length, 2, 'la plantilla tiene que traer al menos dos personas que produzcan');
  for (const agente of productores) {
    const id = store.insertTask(meeting.id, agente.id, { text: `parte de ${agente.name}` });
    store.assignTaskToGoal(id, goal.id, { kind: 'entregable' });
  }

  // The contract is already written: otherwise the phase-1 spec would block
  // construction and what gets measured would be that gate, not the arbitration.
  const dir = projectDir(company.id, goal.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'PROYECTO.md'), '## Qué construimos\nUna web.\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Execution is intercepted: the arbitration matters, not the real work.
  const arrancadas = [];
  workforce.executeTask = async (companyId, agent) => {
    arrancadas.push(agent.name);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  workforce.keyRing = { hasKeys: () => true };

  await workforce.tick();
  assert.equal(arrancadas.length, 1, 'entra uno solo; el otro espera su turno');

  // With the project released, the second one comes in.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await workforce.tick();
  assert.equal(arrancadas.length, 2);
  assert.notEqual(arrancadas[0], arrancadas[1]);
});

test('the action JSON is split off from ANY content marker', () => {
  // Without this, a response with edit_file mixed the JSON with the HTML (full
  // of braces) and the action was dropped: 10 steps burned, zero progress.
  const conEdit = [
    '{"action":"edit_file","path":"index.html"}',
    '<<<BUSCAR',
    '<style>.hero { color: #fff; }</style>',
    'BUSCAR>>>',
    '<<<REEMPLAZAR',
    '<style>.hero { color: #eee; }</style>',
    'REEMPLAZAR>>>'
  ].join('\n');
  assert.equal(splitBeforeHeredoc(conEdit).trim(), '{"action":"edit_file","path":"index.html"}');

  const conWrite = '{"action":"write_file","path":"a.html"}\n<<<CONTENIDO\n<h1>x</h1>\nCONTENIDO>>>';
  assert.equal(splitBeforeHeredoc(conWrite).trim(), '{"action":"write_file","path":"a.html"}');

  assert.equal(splitBeforeHeredoc('{"action":"finish","summary":"listo"}').trim(), '{"action":"finish","summary":"listo"}');
});

test('edit tolerates the model not reproducing the exact indentation', () => {
  const archivo = [
    '<body>',
    '  <section id="servicios">',
    '    <h2>Nuestras soluciones</h2>',
    '  </section>',
    '</body>'
  ].join('\n');

  // Copied "from memory": same text, different spacing.
  const editado = applyEdit(
    archivo,
    '<section id="servicios">\n<h2>Nuestras soluciones</h2>\n</section>',
    '<section id="servicios">\n    <h2>Nuestras soluciones</h2>\n    <p>Tres líneas de trabajo.</p>\n  </section>'
  );
  assert.match(editado, /Tres líneas de trabajo/);
  assert.match(editado, /<body>/, 'el resto del archivo queda intacto');
});

test('edit warns precisely when it cannot apply the change', () => {
  const archivo = '<p>uno</p>\n<p>dos</p>\n<p>uno</p>';
  assert.throws(() => applyEdit(archivo, '<p>tres</p>', 'x'), /no está en el archivo/);
  assert.throws(() => applyEdit(archivo, '<p>uno</p>', 'x'), /aparece 2 veces/);
  assert.throws(() => applyEdit(archivo, '   ', 'x'), /vacío/);
});

test('the log accumulates what each one left', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'equipo-bitacora-'));

  await anotarEnBitacora(dir, { agente: 'Bruno', tarea: 'Armar la home', resumen: 'Hice el hero y el pie.' });
  await anotarEnBitacora(dir, {
    agente: 'Delfina', tarea: 'Ajustar el color', resumen: 'Unifiqué la paleta.', pendiente: 'falta el modo oscuro'
  });

  const texto = readFileSync(path.join(dir, 'BITACORA.md'), 'utf-8');
  assert.match(texto, /Bruno/);
  assert.match(texto, /Hice el hero/);
  assert.match(texto, /Delfina/);
  assert.match(texto, /falta el modo oscuro/);
  assert.equal(texto.match(/# Project log/g).length, 1, 'una sola cabecera');

  rmSync(dir, { recursive: true, force: true });
});
