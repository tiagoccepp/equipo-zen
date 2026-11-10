import { test } from 'node:test';
import assert from 'node:assert/strict';

// The on-disk journal is not part of what is tested here and resolves its
// destination at import time: it is switched off BEFORE loading modules so
// running the tests leaves no stray files under server/data/logs.
process.env.SESSION_LOG = '0';

const { companyTemplates } = await import('../server/lib/config.js');
const { ApiKeyRing } = await import('../server/lib/key-ring.js');
const { MeetingSession } = await import('../server/lib/meeting-session.js');
const { Store } = await import('../server/lib/store.js');

function nuevaEmpresa() {
  const store = new Store(':memory:');
  store.ensureCompanies(companyTemplates);
  return { store, company: store.listCompanies()[0] };
}

function socketFalso() {
  const enviados = [];
  return {
    enviados,
    readyState: 1,
    OPEN: 1,
    send: (payload) => enviados.push(JSON.parse(payload))
  };
}

// Sitting down in a meeting: whichever one is asked for, in whichever
// project is asked for. Without keys no model is ever called.
function abrirReunion(t, store, { companyId, goalId = null, meetingId = null } = {}) {
  const socket = socketFalso();
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(meetingId, companyId, goalId);
  t.after(() => session.close());
  return { session, socket };
}

// Talking as the user: the message enters the meeting on the spot. The
// patience wait is cancelled so the test does not depend on the clock nor
// drag a routing behind it.
function decir(session, texto) {
  session.enqueueUserTurn(texto, 'text');
  clearTimeout(session.pendingUser.timer);
  session.pendingUser = null;
}

test('a meeting opened while standing on a project is saved inside that project', async (t) => {
  const { store, company } = nuevaEmpresa();
  const catalogo = store.createProject({ companyId: company.id, title: 'Catálogo de la ferretería' });
  const blog = store.createProject({ companyId: company.id, title: 'Blog de novedades' });

  const { session, socket } = abrirReunion(t, store, { companyId: company.id, goalId: catalogo.id });

  assert.equal(session.meeting.goal_id, catalogo.id);
  assert.equal(session.project.id, catalogo.id);
  assert.deepEqual(store.meetingsForProject(catalogo.id).map((m) => m.id), [session.meeting.id]);
  assert.equal(store.meetingsForProject(blog.id).length, 0, 'el proyecto de al lado no se entera');

  const ready = socket.enviados.find((m) => m.type === 'meeting_ready');
  assert.equal(ready.project.id, catalogo.id);
  assert.equal(ready.project.title, 'Catálogo de la ferretería');

  // Restarting the meeting does not kick you out of the project: the new one stays inside.
  const primera = session.meeting.id;
  await session.handleClientMessage({ type: 'reset' });
  assert.notEqual(session.meeting.id, primera);
  assert.equal(session.meeting.goal_id, catalogo.id);
  assert.equal(store.meetingsForProject(catalogo.id).length, 2);
});

test('an old meeting with no project is adopted by the project where you resume it, with everything discussed', (t) => {
  const { store, company } = nuevaEmpresa();

  // Like meetings from before projects existed ended up.
  const { session: suelta } = abrirReunion(t, store, { companyId: company.id });
  assert.equal(suelta.meeting.goal_id, null);
  decir(suelta, 'necesito una landing para la panadería, con las fotos de las facturas');
  const reunionVieja = suelta.meeting.id;
  suelta.close();

  const panaderia = store.createProject({ companyId: company.id, title: 'Landing de la panadería' });
  const { session, socket } = abrirReunion(t, store, {
    companyId: company.id,
    goalId: panaderia.id,
    meetingId: reunionVieja
  });

  assert.equal(session.meeting.id, reunionVieja, 'se retoma la misma charla');
  assert.equal(session.meeting.goal_id, panaderia.id, 'y ahora vive dentro del proyecto');
  assert.equal(session.project.id, panaderia.id);
  assert.deepEqual(store.meetingsForProject(panaderia.id).map((m) => m.id), [reunionVieja]);
  assert.deepEqual(
    store.userRequestForGoal(panaderia.id),
    ['necesito una landing para la panadería, con las fotos de las facturas'],
    'lo que pediste antes de la adopción cuenta para este proyecto'
  );

  const ready = socket.enviados.find((m) => m.type === 'meeting_ready');
  assert.equal(ready.resumed, true);
  assert.equal(ready.project.id, panaderia.id);
});

test('a meeting from another project is not resumed here: a new one opens and nothing gets mixed', (t) => {
  const { store, company } = nuevaEmpresa();
  const menu = store.createProject({ companyId: company.id, title: 'Menú del bodegón' });
  const reservas = store.createProject({ companyId: company.id, title: 'Reservas online' });

  const { session: enMenu } = abrirReunion(t, store, { companyId: company.id, goalId: menu.id });
  decir(enMenu, 'el menú va con fotos grandes de cada plato');
  const reunionDelMenu = enMenu.meeting.id;
  enMenu.close();

  // Standing on Reservas, asking for that meeting: it cannot take it along.
  const { session: enReservas, socket } = abrirReunion(t, store, {
    companyId: company.id,
    goalId: reservas.id,
    meetingId: reunionDelMenu
  });
  assert.notEqual(enReservas.meeting.id, reunionDelMenu);
  assert.equal(enReservas.meeting.goal_id, reservas.id);
  assert.equal(socket.enviados.find((m) => m.type === 'meeting_ready').resumed, false);
  assert.equal(store.getMeeting(reunionDelMenu).goal_id, menu.id, 'la charla anterior sigue siendo del menú');

  decir(enReservas, 'la reserva se confirma por mail');
  assert.deepEqual(store.userRequestForGoal(menu.id), ['el menú va con fotos grandes de cada plato']);

  // And from its own project it does resume: what blocked it was the
  // wrong project, not that the meeting was closed forever.
  const { session: devuelta } = abrirReunion(t, store, {
    companyId: company.id,
    goalId: menu.id,
    meetingId: reunionDelMenu
  });
  assert.equal(devuelta.meeting.id, reunionDelMenu);
});

test('what you asked the team arrives whole and in the order you said it', (t) => {
  const { store, company } = nuevaEmpresa();
  const proyecto = store.createProject({ companyId: company.id, title: 'Menú del bodegón' });
  const { session } = abrirReunion(t, store, { companyId: company.id, goalId: proyecto.id });

  decir(session, 'quiero un menú digital para un bodegón de barrio');
  session.memory.add('agent', 'alguien del equipo', 'Dale, lo armamos.', session.sessionAgents[0].id, 'turno-1');
  decir(session, 'que sea súper animado, con parallax');
  decir(session, 'y la sección de vinos va aparte');

  assert.deepEqual(store.userRequestForGoal(proyecto.id), [
    'quiero un menú digital para un bodegón de barrio',
    'que sea súper animado, con parallax',
    'y la sección de vinos va aparte'
  ], 'tus palabras completas, en orden, y sin las respuestas del equipo en el medio');
});

test('what you discuss in one project does not leak into the next one', (t) => {
  const { store, company } = nuevaEmpresa();
  const sushi = store.createProject({ companyId: company.id, title: 'Delivery de sushi' });
  const vivero = store.createProject({ companyId: company.id, title: 'Sitio del vivero' });

  const { session: enSushi } = abrirReunion(t, store, { companyId: company.id, goalId: sushi.id });
  const { session: enVivero } = abrirReunion(t, store, { companyId: company.id, goalId: vivero.id });

  decir(enSushi, 'el sushi se pide por WhatsApp');
  decir(enVivero, 'el vivero necesita el catálogo de plantas de interior');
  decir(enSushi, 'y quiero fotos de cada roll');

  assert.deepEqual(store.userRequestForGoal(sushi.id), [
    'el sushi se pide por WhatsApp',
    'y quiero fotos de cada roll'
  ]);
  assert.deepEqual(store.userRequestForGoal(vivero.id), [
    'el vivero necesita el catálogo de plantas de interior'
  ]);
});

test('when a teammate hands work to another by name, it lands on that person and in this project', (t) => {
  const { store, company } = nuevaEmpresa();
  const vivero = store.createProject({ companyId: company.id, title: 'Sitio del vivero' });
  const { session } = abrirReunion(t, store, { companyId: company.id, goalId: vivero.id });

  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');
  const [quien] = session.sessionAgents.filter((a) => a.role === 'worker');

  session.processAgentTaskCommands(ceo.id, `Perfecto, eso lo ve ${quien.name}. [TAREA_CREAR: ${quien.name}: escribir la home del vivero]`);

  const tareas = store.tasksForMeeting(session.meeting.id);
  assert.equal(tareas.length, 1);
  assert.equal(tareas[0].agentId, quien.id, 'quedó a nombre de quien la nombraron');
  assert.equal(tareas[0].text, 'escribir la home del vivero');
  assert.equal(tareas[0].goalId, vivero.id, 'entra al proyecto donde se está hablando');
  assert.equal((ceo.tasks || []).length, 0, 'quien repartió no se la quedó');

  const cola = store.workQueue(company.id);
  assert.equal(cola.length, 1, 'ya hay alguien produciendo sin cerrar la reunión');
  assert.equal(cola[0].agent_id, quien.id);
  assert.equal(store.listProjects(company.id).length, 1, 'no se abrió ningún proyecto fantasma');
});

test('if the same task repeats across two turns, the board keeps only one', (t) => {
  const { store, company } = nuevaEmpresa();
  const vivero = store.createProject({ companyId: company.id, title: 'Sitio del vivero' });
  const { session } = abrirReunion(t, store, { companyId: company.id, goalId: vivero.id });

  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');
  const [quien, otro] = session.sessionAgents.filter((a) => a.role === 'worker');

  session.processAgentTaskCommands(ceo.id, `[TAREA_CREAR: ${quien.name}: escribir la home del vivero]`);
  // Someone else repeats the same errand, worded differently: it is the same job.
  session.processAgentTaskCommands(otro.id, `Como decíamos, [TAREA_CREAR: ${quien.name}: Escribir la home del vivero]`);

  assert.equal(store.workQueue(company.id).length, 1, 'no se trabaja dos veces lo mismo');

  // But a genuinely different request does get in.
  session.processAgentTaskCommands(ceo.id, `[TAREA_CREAR: ${quien.name}: escribir la página de contacto]`);
  assert.equal(store.workQueue(company.id).length, 2);
});

test('the CEO does not keep what must be built: when work starts it sits with whoever knows how', async (t) => {
  const { store, company } = nuevaEmpresa();
  const proyecto = store.createProject({ companyId: company.id, title: 'Sitio de la ferretería' });
  const { session } = abrirReunion(t, store, { companyId: company.id, goalId: proyecto.id });

  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');
  await session.handleClientMessage({
    type: 'add_task',
    agentId: ceo.id,
    text: 'crear la página de inicio en html con animacion y formularios'
  });
  const [tarea] = store.tasksForMeeting(session.meeting.id);

  session.startWorkNow();

  const enTablero = store.getTask(tarea.id);
  assert.notEqual(enTablero.agent_id, ceo.id, 'la jefa coordina, no escribe la web');
  const destino = session.sessionAgents.find((a) => a.id === enTablero.agent_id);
  assert.equal(destino.role, 'worker');
  assert.ok(destino.domains.some((d) => /html/.test(d)), 'fue a parar a quien tiene el oficio');
  assert.equal(store.workQueue(company.id)[0].goal_id, proyecto.id);

  // And now the same request the way anyone makes it: in plain language,
  // without naming a single technology. Nobody asks for "una landing en html
  // con formularios"; they ask for "la landing del catálogo". It must end the
  // same way: built by whoever has the trade, not the boss.
  await session.handleClientMessage({
    type: 'add_task',
    agentId: ceo.id,
    text: 'crear la landing del catálogo de plantas'
  });
  session.startWorkNow();

  const encoladas = store.workQueue(company.id).map((t2) => ({
    quien: store.getAgent(t2.agent_id),
    texto: t2.text
  }));
  const enManosDeLaJefa = encoladas.filter((item) => item.quien.role === 'ceo');
  assert.deepEqual(
    enManosDeLaJefa.map((item) => item.texto),
    [],
    'la jefa quedó encolada para escribir un archivo del proyecto'
  );
});

test('when work starts, the project keeps the request in your own words', async (t) => {
  const { store, company } = nuevaEmpresa();
  const proyecto = store.createProject({ companyId: company.id, title: 'Menú digital' });
  assert.equal(proyecto.brief, '', 'arranca sin nada escrito');
  const { session } = abrirReunion(t, store, { companyId: company.id, goalId: proyecto.id });

  decir(session, 'quiero un menú digital para un restaurante de sushi');
  decir(session, 'súper animado y con parallax');

  const [quien] = session.sessionAgents.filter((a) => a.role === 'worker');
  await session.handleClientMessage({ type: 'add_task', agentId: quien.id, text: 'armar el menú en html' });
  session.startWorkNow();

  const guardado = store.getGoal(proyecto.id);
  assert.match(guardado.brief, /sushi/, 'el equipo construye lo que pediste, no un genérico');
  assert.match(guardado.brief, /parallax/);
  assert.equal(store.listProjects(company.id).length, 1, 'el trabajo va al proyecto donde se conversó');
  assert.equal(store.workQueue(company.id)[0].goal_id, proyecto.id);
});
