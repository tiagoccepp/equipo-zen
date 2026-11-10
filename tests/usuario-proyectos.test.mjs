import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { companyTemplates } from '../server/lib/config.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { isMeetingLive, MeetingSession } from '../server/lib/meeting-session.js';
import { Store } from '../server/lib/store.js';
import { esProyectoMovil, projectDir } from '../server/lib/workforce.js';

// The journey of someone organizing their work: opens their company, creates
// projects, enters one, renames it, and deletes the ones no longer needed.
// None of this may run over what lives in the project next door.

// A template that is NOT web, to check the project inherits the company's
// niche. Picked by its stack: template names and their people's names change.
function plantillaDeNicho() {
  return companyTemplates.templates.find((item) => esProyectoMovil(item.stack))
    || companyTemplates.templates[0];
}

function nuevaEmpresa(t, plantilla = companyTemplates.templates[0], nombre = 'Mi empresa') {
  const store = new Store(':memory:');
  // Same as signing up from the app: the template with the name the owner gave.
  const company = store.createCompanyFromTemplate({ ...plantilla, name: nombre }, 'user');
  t.after(() => {
    store.close();
    // Everything the company wrote to disk lives under workspace/<company>/.
    rmSync(path.dirname(projectDir(company.id, 'general')), { recursive: true, force: true });
  });
  return { store, company };
}

function fakeSocket() {
  const enviados = [];
  return {
    enviados,
    readyState: 1,
    OPEN: 1,
    send(payload) {
      enviados.push(JSON.parse(payload));
    }
  };
}

// The project folder as it looks after the team worked.
function conArchivos(companyId, slug, archivos) {
  const dir = projectDir(companyId, slug);
  mkdirSync(dir, { recursive: true });
  for (const [nombre, contenido] of Object.entries(archivos)) {
    writeFileSync(path.join(dir, nombre), contenido);
  }
  return dir;
}

// A project with everything hung off it by using it: a meeting with what was
// said, a worked task, its run, and a comment between teammates.
function proyectoConTrabajo(store, company, titulo) {
  const project = store.createProject({ companyId: company.id, title: titulo, brief: `Lo de ${titulo}` });
  const meeting = store.createMeeting({ companyId: company.id, goalId: project.id });
  store.appendTurn(meeting.id, { kind: 'user', speaker: 'Nino', text: `quiero ${titulo}` });
  store.appendTurn(meeting.id, { kind: 'agent', speaker: 'alguien del equipo', text: 'Dale, lo armamos.' });

  const alguien = store.listAgents({ companyId: company.id }).find((agent) => agent.role === 'worker');
  const taskId = store.insertTask(meeting.id, alguien.id, { text: `Armar ${titulo}` });
  store.assignTaskToGoal(taskId, project.id, { kind: 'entregable', targetFile: 'index.html' });
  const runId = store.startWorkRun(taskId, alguien.id, company.id);
  store.finishWorkRun(runId, { status: 'ok', summary: 'Listo', artifacts: ['index.html'] });
  store.finishTask(taskId, { status: 'done', summary: 'Listo' });
  store.addTaskComment({ taskId, companyId: company.id, authorId: alguien.id, kind: 'nota', text: 'Le miré el contraste.' });

  return { project, meeting, taskId, alguien };
}

test('I open my company from a template: it comes with the team assembled, no projects, and the ones I create show in the list', (t) => {
  const plantilla = plantillaDeNicho();
  const { store, company } = nuevaEmpresa(t, plantilla, 'Estudio de Nino');

  assert.equal(company.name, 'Estudio de Nino');
  const equipo = store.listAgents({ companyId: company.id });
  assert.equal(equipo.filter((agent) => agent.role === 'ceo').length, 1, 'una sola persona a cargo');
  assert.equal(equipo.filter((agent) => agent.role === 'contratista').length, 1, 'alguien que refina al equipo');
  assert.ok(equipo.filter((agent) => agent.role === 'worker').length >= 2, 'y gente que produce');
  assert.ok(equipo.every((agent) => agent.name && agent.title), 'todos con nombre y puesto para poder hablarles');

  assert.deepEqual(store.listProjects(company.id), [], 'una empresa recién abierta no tiene trabajo encima');

  const uno = store.createProject({ companyId: company.id, title: 'App de turnos', brief: 'Reservar turnos desde el celu' });
  const dos = store.createProject({ companyId: company.id, title: 'Panel del dueño' });

  const lista = store.listProjects(company.id);
  assert.deepEqual(lista.map((p) => p.title).sort(), ['App de turnos', 'Panel del dueño']);
  assert.equal(lista.find((p) => p.id === uno.id).brief, 'Reservar turnos desde el celu');
  assert.equal(new Set(lista.map((p) => p.slug)).size, 2, 'cada proyecto con su carpeta');

  // The company's niche rules: a mobile studio does not start web projects.
  assert.equal(uno.stack, company.stack);
  assert.equal(dos.stack, company.stack);
  assert.equal(esProyectoMovil(uno.stack), esProyectoMovil(plantilla.stack));
});

test('I enter a project and what I say stays inside; while the meeting stays open the project cannot be deleted', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const landing = store.createProject({ companyId: company.id, title: 'Landing del bar' });
  const otro = store.createProject({ companyId: company.id, title: 'Panel interno' });

  const socket = fakeSocket();
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  t.after(() => session.close());
  session.initMeeting(null, company.id, landing.id);

  const listo = socket.enviados.find((mensaje) => mensaje.type === 'meeting_ready');
  assert.equal(listo.project.id, landing.id, 'la reunión abre adentro del proyecto que elegí');
  assert.equal(store.getMeeting(session.meeting.id).goal_id, landing.id);
  assert.deepEqual(store.meetingsForProject(landing.id).map((m) => m.id), [session.meeting.id]);
  assert.deepEqual(store.meetingsForProject(otro.id), [], 'el proyecto de al lado no se entera');

  store.appendTurn(session.meeting.id, { kind: 'user', speaker: 'Nino', text: 'quiero la carta del bar con fotos' });
  assert.deepEqual(store.userRequestForGoal(landing.id), ['quiero la carta del bar con fotos']);
  assert.deepEqual(store.userRequestForGoal(otro.id), [], 'mi pedido no se filtra al otro proyecto');

  // The rule that protects against deleting the floor while someone stands on it.
  const conGenteAdentro = (goalId) => store.meetingsForProject(goalId).some((m) => isMeetingLive(m.id));
  assert.equal(conGenteAdentro(landing.id), true, 'con la reunión abierta, borrar el proyecto queda bloqueado');
  assert.equal(conGenteAdentro(otro.id), false);

  // And closing it frees it: the project does not stay stuck forever.
  const meetingId = session.meeting.id;
  session.closeCurrentMeeting('la terminé');
  assert.equal(isMeetingLive(meetingId), false);
  assert.equal(conGenteAdentro(landing.id), false);
  assert.equal(store.deleteProject(landing.id).reuniones, 1, 'ahora sí lo puedo borrar');
});

test("I fix the project's name and it is still the same one: the folder and files stay where they were", (t) => {
  const { store, company } = nuevaEmpresa(t);
  const project = store.createProject({ companyId: company.id, title: 'Landin del bar' });
  const dir = conArchivos(company.id, project.slug, { 'index.html': '<h1>Bar</h1>' });

  const renombrado = store.updateProject(project.id, { title: 'Landing del bar', brief: 'ahora con la carta' });

  assert.equal(renombrado.title, 'Landing del bar');
  assert.equal(renombrado.slug, project.slug, 'la carpeta no se muda: el enlace al entregable sigue sirviendo');
  assert.equal(projectDir(company.id, renombrado.slug), dir);
  assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf-8'), '<h1>Bar</h1>', 'lo que ya se había hecho sigue ahí');

  const [fila] = store.listProjects(company.id);
  assert.equal(fila.title, 'Landing del bar', 'en la lista ya se ve el nombre nuevo');
  assert.equal(fila.brief, 'ahora con la carta');

  // Clearing the name and saving (the PATCH sends title.trim(), i.e. '') must not
  // leave the project nameless in the list: signup already rejects the empty name,
  // renaming must be just as firm.
  const enBlanco = store.updateProject(project.id, { title: '   ', brief: 'ahora con la carta' });
  assert.equal(enBlanco.title, 'Landing del bar', 'un nombre en blanco no pisa el que tenía');
  assert.equal(store.listProjects(company.id)[0].title, 'Landing del bar');
});

test('I delete a project and everything of its goes: the meeting, what was said, the tasks, comments, and runs', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const { project, meeting, taskId } = proyectoConTrabajo(store, company, 'Menú digital');
  const dir = conArchivos(company.id, project.slug, { 'index.html': '<h1>Menú</h1>' });

  const resultado = store.deleteProject(project.id);

  assert.equal(resultado.reuniones, 1);
  assert.equal(resultado.tareas, 1);
  assert.equal(resultado.corridas, 1);
  assert.equal(store.getGoal(project.id), null);
  assert.equal(store.getMeeting(meeting.id), null);
  assert.equal(store.recentTurns(meeting.id).length, 0, 'la conversación se va con el proyecto');
  assert.equal(store.getTask(taskId), null);
  assert.equal(store.taskComments(taskId).length, 0);
  assert.equal(store.recentWorkRuns(company.id).length, 0);
  assert.deepEqual(store.listProjects(company.id), [], 'ya no aparece en mi lista');

  // The app deletes the folder, and for that it needs to know which one and that
  // nobody else uses it. If this data were wrong, other people's files would be deleted.
  assert.equal(resultado.carpetaCompartida, false);
  assert.equal(projectDir(resultado.companyId, resultado.slug), dir);
  assert.ok(existsSync(path.join(dir, 'index.html')), 'los archivos siguen hasta que la app borre esa carpeta');
});

test('deleting a project touches nothing in the project next door', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const viejo = proyectoConTrabajo(store, company, 'Landing vieja');
  const queSigue = proyectoConTrabajo(store, company, 'Tienda nueva');
  const dirViejo = conArchivos(company.id, viejo.project.slug, { 'index.html': '<h1>Vieja</h1>' });
  const dirQueSigue = conArchivos(company.id, queSigue.project.slug, { 'index.html': '<h1>Tienda</h1>' });
  assert.notEqual(dirViejo, dirQueSigue);

  const resultado = store.deleteProject(viejo.project.id);
  assert.equal(resultado.carpetaCompartida, false, 'borrar esa carpeta no alcanza a la del otro');

  assert.deepEqual(store.listProjects(company.id).map((p) => p.title), ['Tienda nueva']);
  assert.equal(store.getMeeting(queSigue.meeting.id)?.id, queSigue.meeting.id);
  assert.equal(store.recentTurns(queSigue.meeting.id).length, 2, 'lo que hablé en el otro proyecto sigue estando');
  assert.deepEqual(store.tasksForGoal(queSigue.project.id).map((task) => task.id), [queSigue.taskId]);
  assert.equal(store.taskComments(queSigue.taskId).length, 1);
  assert.equal(store.recentWorkRuns(company.id).length, 1);
  assert.deepEqual(store.userRequestForGoal(queSigue.project.id), ['quiero Tienda nueva']);
  assert.equal(readFileSync(path.join(dirQueSigue, 'index.html'), 'utf-8'), '<h1>Tienda</h1>');
});

test("two projects with the same name do not step on each other's files", (t) => {
  const { store, company } = nuevaEmpresa(t);
  const delBar = store.createProject({ companyId: company.id, title: 'Landing' });
  const deLaPeluqueria = store.createProject({ companyId: company.id, title: 'Landing' });

  assert.notEqual(delBar.slug, deLaPeluqueria.slug, 'mismo nombre, carpetas distintas');
  const dirBar = conArchivos(company.id, delBar.slug, { 'index.html': '<h1>Bar</h1>' });
  const dirPelu = conArchivos(company.id, deLaPeluqueria.slug, { 'index.html': '<h1>Peluquería</h1>' });
  assert.notEqual(dirBar, dirPelu);
  assert.equal(readFileSync(path.join(dirBar, 'index.html'), 'utf-8'), '<h1>Bar</h1>');
  assert.equal(readFileSync(path.join(dirPelu, 'index.html'), 'utf-8'), '<h1>Peluquería</h1>');

  assert.equal(store.slugSharedWithOthers(delBar.id), false);
  const resultado = store.deleteProject(delBar.id);
  assert.equal(resultado.carpetaCompartida, false);
  assert.equal(resultado.slug, delBar.slug, 'se borra la carpeta del que borré, no la del homónimo');
  assert.equal(readFileSync(path.join(dirPelu, 'index.html'), 'utf-8'), '<h1>Peluquería</h1>');
  assert.deepEqual(store.listProjects(company.id).map((p) => p.id), [deLaPeluqueria.id]);
});

test('a project I opened and never used shows in the list and deletes without drama', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const vacio = store.createProject({ companyId: company.id, title: 'Idea suelta' });

  const [fila] = store.listProjects(company.id);
  assert.equal(fila.id, vacio.id);
  assert.equal(fila.meeting_count, 0);
  assert.equal(fila.task_count, 0);
  assert.equal(fila.done_count, 0);
  assert.equal(fila.last_run_at, null);
  assert.deepEqual(store.meetingsForProject(vacio.id), []);
  assert.deepEqual(store.userRequestForGoal(vacio.id), []);
  assert.equal(existsSync(projectDir(company.id, vacio.slug)), false, 'sin trabajo no hay carpeta que limpiar');

  const resultado = store.deleteProject(vacio.id);
  assert.deepEqual(
    { reuniones: resultado.reuniones, tareas: resultado.tareas, corridas: resultado.corridas },
    { reuniones: 0, tareas: 0, corridas: 0 }
  );
  assert.equal(store.getGoal(vacio.id), null);
  assert.deepEqual(store.listProjects(company.id), []);
  assert.equal(store.deleteProject(vacio.id), null, 'si le doy borrar dos veces no se rompe nada');
});

// Goals from before projects ALL ended up in the 'general' folder
// (migration v5). Deleting the one that is now a project must not take the
// others' files.
test('if the project shares the "general" folder with old work, deletion warns so it does not take it down', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const proyecto = store.createProject({ companyId: company.id, title: 'General' });
  assert.equal(proyecto.slug, 'general');

  const trabajoViejo = store.createGoal({ companyId: company.id, title: 'Lo de marzo' });
  store.db.prepare('UPDATE goals SET slug = NULL WHERE id = ?').run(trabajoViejo.id);
  assert.equal(store.ensureGoalSlugs(), 1, 'la migración manda lo viejo a general');
  assert.equal(store.getGoal(trabajoViejo.id).slug, 'general');

  const dir = conArchivos(company.id, 'general', { 'index.html': '<h1>Lo de marzo</h1>' });
  assert.equal(projectDir(company.id, proyecto.slug), dir, 'los dos apuntan a la misma carpeta');

  assert.equal(store.slugSharedWithOthers(proyecto.id), true);
  const resultado = store.deleteProject(proyecto.id);
  assert.equal(resultado.carpetaCompartida, true, 'sin este aviso, borrar el proyecto se llevaba el trabajo viejo');
  assert.ok(store.getGoal(trabajoViejo.id), 'lo de marzo sigue existiendo');
  assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf-8'), '<h1>Lo de marzo</h1>');
});

// A meeting that produces no deliverables leaves its agreement record aside
// (what closing does when there is nothing to build). That record survives the
// project on purpose: it is company history.
test('deleting the project cannot empty the agreements recorded in its meeting', (t) => {
  const { store, company } = nuevaEmpresa(t);
  const landing = store.createProject({ companyId: company.id, title: 'Landing del bar' });
  const meeting = store.createMeeting({ companyId: company.id, goalId: landing.id });
  const alguien = store.listAgents({ companyId: company.id }).find((agent) => agent.role === 'worker');

  const acuerdos = store.createGoal({
    companyId: company.id,
    meetingId: meeting.id,
    title: 'Acuerdos del lunes',
    kind: 'acuerdo'
  });
  const decision = store.insertTask(meeting.id, alguien.id, { text: 'la marca va en verde, no en azul' });
  store.assignTaskToGoal(decision, acuerdos.id, { kind: 'decision' });

  store.deleteProject(landing.id);

  assert.ok(store.getGoal(acuerdos.id), 'el registro de acuerdos sobrevive al proyecto');
  assert.deepEqual(
    store.tasksForGoal(acuerdos.id).map((task) => task.text),
    ['la marca va en verde, no en azul'],
    'los acuerdos no eran del proyecto borrado: no se pueden ir con él y dejar el registro vacío'
  );
});
