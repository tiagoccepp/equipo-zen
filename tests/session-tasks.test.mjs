import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyTemplates } from '../server/lib/config.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { Store } from '../server/lib/store.js';

function fakeSocket() {
  const sent = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };
}

function newStore() {
  const store = new Store(':memory:');
  store.ensureCompanies(companyTemplates);
  return store;
}

function newSession(store = newStore()) {
  const socket = fakeSocket();
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null);
  // Dos integrantes cualesquiera que produzcan: los tests son sobre el
  // protocolo de tareas, no sobre quién está en la plantilla del momento.
  const [uno, dos] = session.sessionAgents.filter((a) => a.role === 'worker');
  return {
    socket, session, store,
    julioId: uno.id, julioName: uno.name,
    tomasaId: dos.id, tomasaName: dos.name
  };
}

test('SILENCIO + [TAREA_CREAR] crea la tarea aunque el agente calle', async () => {
  const { socket, session, julioId, julioName } = newSession();
  const julio = session.agents.get(julioId);
  julio.respond = async (_turn, emit) => {
    emit({ type: 'agent_silence', reason: 'protocolo' });
    return { rawText: 'SILENCIO [TAREA_CREAR: revisar stock del depósito]', text: '', audioChunks: [], usedMock: true };
  };

  await session.processUserTurn('t1', `${julioName} fijate esto`);

  const julioAgent = session.sessionAgents.find((a) => a.id === julioId);
  assert.equal(julioAgent.tasks.length, 1);
  assert.equal(julioAgent.tasks[0].text, 'revisar stock del depósito');
  assert.equal(julioAgent.tasks[0].completed, false);

  const complete = socket.sent.find((m) => m.type === 'agent_turn_complete' && m.agentId === julioId);
  assert.equal(complete.text, '');
  assert.equal(session.memory.lastAgentTurn(), null);
});

test('respuesta hablada con tag crea tarea y limpia el texto visible', async () => {
  const { socket, session, julioId, julioName } = newSession();
  const julio = session.agents.get(julioId);
  julio.respond = async () => ({
    rawText: 'Dale, lo agendo. [TAREA_CREAR: armar endpoint de cobranzas]',
    text: 'Dale, lo agendo. [TAREA_CREAR: armar endpoint de cobranzas]',
    audioChunks: [],
    usedMock: true
  });

  await session.processUserTurn('t2', `${julioName} anotate armar el endpoint`);

  const julioAgent = session.sessionAgents.find((a) => a.id === julioId);
  assert.equal(julioAgent.tasks.at(-1).text, 'armar endpoint de cobranzas');
  const complete = socket.sent.find((m) => m.type === 'agent_turn_complete' && m.agentId === julioId);
  assert.equal(complete.text, 'Dale, lo agendo.');
  assert.equal(session.memory.lastAgentTurn().text, 'Dale, lo agendo.');
});

test('tag con destinatario por NOMBRE asigna la tarea al otro agente', async () => {
  const { session, julioId, tomasaId, tomasaName } = newSession();
  const julio = session.agents.get(julioId);
  const tag = `Eso lo ve ${tomasaName}. [TAREA_CREAR: ${tomasaName}: validar stock físico]`;
  julio.respond = async () => ({
    rawText: tag,
    text: tag,
    audioChunks: [],
    usedMock: true
  });

  await session.processUserTurn('t3', `${session.sessionAgents.find((a) => a.id === julioId).name} coordiná la validación`);

  const tomasa = session.sessionAgents.find((a) => a.id === tomasaId);
  assert.equal(tomasa.tasks.at(-1).text, 'validar stock físico');
});

test('spawn_agent: cap de agentes y dedup por nombre', async () => {
  const { socket, session, julioName } = newSession();

  await session.handleClientMessage({
    type: 'spawn_agent',
    agent: { name: julioName, title: 'Otro', aliases: [], domains: [], boundaries: [], initialTasks: [] }
  });
  assert.ok(socket.sent.some((m) => m.type === 'error' && /already an agent called/.test(m.message)));

  for (let i = 0; i < 6; i += 1) {
    await session.handleClientMessage({
      type: 'spawn_agent',
      agent: { name: `Extra${i}`, title: 'Rol', aliases: [], domains: [], boundaries: [], initialTasks: [] }
    });
  }
  assert.equal(session.sessionAgents.length, 8);

  await session.handleClientMessage({
    type: 'spawn_agent',
    agent: { name: 'Desborde', title: 'Rol', aliases: [], domains: [], boundaries: [], initialTasks: [] }
  });
  assert.ok(socket.sent.some((m) => m.type === 'error' && /table is full/.test(m.message)));
  assert.equal(session.sessionAgents.length, 8);
});

test('modo mock: sin claves los agentes responden enlatado con usedMock', async () => {
  const { socket, session } = newSession();
  await session.processUserTurn('t4', 'hola equipo');

  const completes = socket.sent.filter((m) => m.type === 'agent_turn_complete');
  assert.equal(completes.length, session.sessionAgents.length, 'saluda todo el equipo (incl. CEO y contratista)');
  for (const complete of completes) {
    assert.equal(complete.usedMock, true);
    assert.match(complete.text, /simulation mode/);
  }
});

test('organigrama: toda empresa tiene CEO y contratista, y el equipo reporta al CEO', () => {
  const { session } = newSession();
  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');
  const contratista = session.sessionAgents.find((a) => a.role === 'contratista');
  assert.ok(ceo, 'hay CEO');
  assert.ok(contratista, 'hay contratista');
  assert.equal(ceo.managerId, null);
  for (const agent of session.sessionAgents.filter((a) => a.role !== 'ceo')) {
    assert.equal(agent.managerId, ceo.id, `${agent.name} reporta al CEO`);
  }
});

test('router: sin dominio claro, la CEO toma el punto', () => {
  const { session } = newSession();
  const route = session.router.route('zzz asunto totalmente ajeno qqq', session.memory);
  assert.equal(route.targets.length, 1);
  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');
  assert.equal(route.targets[0].agentId, ceo.id);
});

test('cierre de reunión: la meta agrupa las tareas pendientes y arranca la cola', async () => {
  const { socket, session, store, julioId } = newSession();
  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'armar la landing del catálogo' });

  await session.prepareMeetingClose();
  const summary = socket.sent.find((m) => m.type === 'meeting_closing_summary');
  assert.ok(summary, 'llega el resumen de cierre');
  assert.ok(summary.assignments.some((a) => a.tasks.some((t) => t.text === 'armar la landing del catálogo')));
  assert.equal(summary.producesWork, true, 'hay algo concreto para construir');

  const oldMeetingId = session.meeting.id;
  session.confirmMeetingClose();

  const goals = store.listGoals(session.company.id, 'active');
  assert.equal(goals.length, 1);
  const queue = store.workQueue(session.company.id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].text, 'armar la landing del catálogo');
  assert.equal(store.getMeeting(oldMeetingId).status, 'closed');
  assert.notEqual(session.meeting.id, oldMeetingId, 'se abre una reunión nueva');

  // Checkout atómico: solo un worker puede tomarla
  assert.equal(store.checkoutTask(queue[0].id), true);
  assert.equal(store.checkoutTask(queue[0].id), false);
});

test('cierre sin entregables: no se abre proyecto ni cola de trabajo', async () => {
  const { session, store } = newSession();

  // Reunión de pura conversación: nadie asignó tareas.
  await session.prepareMeetingClose();
  assert.equal(session.pendingClose.producesWork, false);

  session.confirmMeetingClose();
  assert.equal(store.listGoals(session.company.id, 'active').length, 0, 'no queda ningún proyecto activo');
  assert.equal(store.workQueue(session.company.id).length, 0, 'nadie se pone a trabajar');

  const acuerdos = store.listGoals(session.company.id).filter((g) => g.kind === 'acuerdo');
  assert.equal(acuerdos.length, 1, 'queda el acuerdo registrado en el historial');
});

test('una tarea clasificada como acuerdo queda anotada, no entra a la cola', async () => {
  const { session, store, julioId } = newSession();
  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'definimos que el foco es retail' });

  await session.prepareMeetingClose();
  // Sin claves el modelo no clasifica: se simula el veredicto de la CEO.
  session.pendingClose.producesWork = true;
  session.pendingClose.kinds = [[1, 'decision']];
  session.confirmMeetingClose();

  assert.equal(store.workQueue(session.company.id).length, 0, 'un acuerdo no se "trabaja"');
  const goal = store.listGoals(session.company.id)[0];
  const tasks = store.tasksForGoal(goal.id);
  assert.equal(tasks[0].kind, 'decision');
  assert.equal(tasks[0].status, 'noted');
});

test('un pedido explícito de crear algo se construye aunque la CEO dude', async () => {
  const { session, store, julioId } = newSession();
  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'crear la página web institucional' });

  await session.prepareMeetingClose();
  // Sin claves no hay clasificación del modelo: la red de seguridad tiene que
  // reconocer sola que "crear la página web" es algo para construir.
  assert.equal(session.pendingClose.producesWork, true);
  assert.deepEqual(session.pendingClose.kinds, [[1, 'entregable']]);
  session.confirmMeetingClose();

  const queue = store.workQueue(session.company.id);
  assert.equal(queue.length, 1, 'la red de seguridad manda el pedido a la cola igual');
  assert.equal(queue[0].kind, 'entregable');
});

test('una etiqueta con dos nombres crea la tarea para los dos', async () => {
  const { session, store, julioId, julioName, tomasaId, tomasaName } = newSession();

  // El modelo escribe naturalmente "Fulana y Mengano": antes se descartaba
  // entera y el trabajo pedido se perdía sin dejar rastro.
  session.processAgentTaskCommands(julioId, `Lo vemos. [TAREA_CREAR: ${julioName} y ${tomasaName}: preparar el informe de stock]`);

  const deJulio = store.tasksForMeeting(session.meeting.id).filter((t) => t.agentId === julioId);
  const deTomasa = store.tasksForMeeting(session.meeting.id).filter((t) => t.agentId === tomasaId);
  assert.equal(deJulio.length, 1);
  assert.equal(deTomasa.length, 1);
  assert.equal(deJulio[0].text, 'preparar el informe de stock');
});

test('la misma tarea repetida en dos turnos no se duplica', async () => {
  const { session, store, julioId, julioName } = newSession();

  session.processAgentTaskCommands(julioId, `[TAREA_CREAR: ${julioName}: definir el alcance]`);
  session.processAgentTaskCommands(julioId, `Como decía, [TAREA_CREAR: ${julioName}: definir el alcance]`);

  const tareas = store.tasksForMeeting(session.meeting.id).filter((t) => t.agentId === julioId);
  assert.equal(tareas.length, 1, 'el tablero no se llena de tareas idénticas');
});

test('un destinatario que no existe no rompe ni inventa tareas', async () => {
  const { session, store, julioId } = newSession();
  session.processAgentTaskCommands(julioId, '[TAREA_CREAR: Fulano: algo]');
  assert.equal(store.tasksForMeeting(session.meeting.id).length, 0);
});

test('continuidad: turnos, agente spawneado y tareas sobreviven a otra sesión', async () => {
  const store = newStore();
  const { session: first } = newSession(store);
  const meetingId = first.meeting.id;

  await first.processUserTurn('t1', 'hola equipo');
  await first.handleClientMessage({
    type: 'spawn_agent',
    agent: { name: 'Rita', title: 'QA', aliases: [], domains: ['testing'], boundaries: [], initialTasks: ['probar login'] }
  });
  first.close();

  const socket2 = fakeSocket();
  const second = new MeetingSession(socket2, new ApiKeyRing([]), store);
  second.initMeeting(meetingId);

  const ready = socket2.sent.find((m) => m.type === 'meeting_ready');
  assert.equal(ready.resumed, true);
  assert.equal(ready.meetingId, meetingId);
  assert.ok(ready.turns.length >= 3, 'restaura la conversación previa');

  const rita = second.sessionAgents.find((a) => a.name === 'Rita');
  assert.ok(rita, 'el agente spawneado sigue en la mesa');
  assert.equal(rita.tasks[0].text, 'probar login');
  assert.ok(second.memory.turns.length >= 3, 'la memoria se rehidrató');
});

test('single-writer: una segunda pestaña sobre la misma reunión activa recibe otra', () => {
  const store = newStore();
  const { session: first } = newSession(store);
  const meetingId = first.meeting.id;

  const socket2 = fakeSocket();
  const second = new MeetingSession(socket2, new ApiKeyRing([]), store);
  second.initMeeting(meetingId);

  assert.notEqual(second.meeting.id, meetingId);
  const ready = socket2.sent.find((m) => m.type === 'meeting_ready');
  assert.equal(ready.resumed, false);
});

test('reset cierra la reunión actual y abre una nueva', async () => {
  const { socket, session, store } = newSession();
  const oldMeetingId = session.meeting.id;

  await session.handleClientMessage({ type: 'reset' });

  assert.notEqual(session.meeting.id, oldMeetingId);
  assert.equal(store.getMeeting(oldMeetingId).status, 'closed');
  assert.ok(socket.sent.some((m) => m.type === 'meeting_reset'));
  const readies = socket.sent.filter((m) => m.type === 'meeting_ready');
  assert.equal(readies.at(-1).meetingId, session.meeting.id);
});

test('update_agent persiste el patch con snapshot de versión y changelog', async () => {
  const { session, store, julioId } = newSession();

  await session.handleClientMessage({
    type: 'update_agent',
    agentId: julioId,
    patch: { style: 'habla más formal', boundaries: ['No estima plazos sin datos'], knowledge: 'Sabe del stack legacy.' }
  });

  const updated = store.getAgent(julioId);
  assert.equal(updated.style, 'habla más formal');
  assert.deepEqual(updated.boundaries, ['No estima plazos sin datos']);
  assert.equal(updated.knowledge, 'Sabe del stack legacy.');
  assert.equal(updated.version, 2);
  assert.equal(store.listAgentVersions(julioId).length, 1);
  assert.ok(store.listChangelog({ entity: 'agent', entityId: julioId }).length >= 1);

  const inSession = session.sessionAgents.find((a) => a.id === julioId);
  assert.equal(inSession.style, 'habla más formal');
});

test('set_agent_enabled saca al agente del ruteo pero lo deja en el roster', async () => {
  const { session, tomasaId } = newSession();

  await session.handleClientMessage({ type: 'set_agent_enabled', agentId: tomasaId, enabled: false });

  const tomasa = session.sessionAgents.find((a) => a.id === tomasaId);
  assert.equal(tomasa.enabled, false);
  const route = session.router.route('¿cómo viene el stock del inventario?', session.memory);
  assert.ok(!route.targets.some((t) => t.agentId === tomasaId));
  assert.ok(session.publicAgents().some((a) => a.id === tomasaId));
});

test('archive_agent solo permite archivar agentes custom', async () => {
  const { socket, session, store, julioId } = newSession();

  await session.handleClientMessage({ type: 'archive_agent', agentId: julioId });
  assert.ok(socket.sent.some((m) => m.type === 'error' && /core team/.test(m.message)));

  await session.handleClientMessage({
    type: 'spawn_agent',
    agent: { name: 'Temporal', title: 'Rol', aliases: [], domains: [], boundaries: [], initialTasks: [] }
  });
  const temporal = session.sessionAgents.find((a) => a.name === 'Temporal');
  await session.handleClientMessage({ type: 'archive_agent', agentId: temporal.id });

  assert.ok(!session.sessionAgents.some((a) => a.name === 'Temporal'));
  assert.equal(store.getAgent(temporal.id).status, 'archived');
});

test('set_scenario actualiza el contexto que ven los prompts', async () => {
  const { socket, session } = newSession();

  await session.handleClientMessage({ type: 'set_scenario', text: 'Sprint de migración del sistema de pedidos' });

  assert.equal(session.meeting.scenario_text, 'Sprint de migración del sistema de pedidos');
  assert.ok(socket.sent.some((m) => m.type === 'scenario_updated'));
  assert.ok(session.promptContext().scenario.text.includes('Objetivo de esta reunión: Sprint de migración del sistema de pedidos'));
  assert.ok(session.promptContext().scenario.name.includes(session.company.name));
});

test('paciencia: mensajes seguidos se agregan en UN solo ruteo', async () => {
  process.env.USER_TURN_SETTLE_MS = '2600';
  const { socket, session, julioId, julioName } = newSession();
  const julio = session.agents.get(julioId);
  const received = [];
  julio.respond = async (turn) => {
    received.push(turn.text);
    return { rawText: 'ok', text: 'ok', audioChunks: [], usedMock: true };
  };

  session.enqueueUserTurn(`${julioName}, tengo que contarte algo del sistema`, 'text');
  await new Promise((r) => setTimeout(r, 120));
  session.enqueueUserTurn('lavar los platos', 'text');

  // Los dos fragmentos aparecen al instante en el chat…
  const bubbles = socket.sent.filter((m) => m.type === 'user_turn_received');
  assert.equal(bubbles.length, 2);

  // …pero todavía no se ruteó nada (está esperando)
  assert.equal(socket.sent.filter((m) => m.type === 'route_decision').length, 0);

  await new Promise((r) => setTimeout(r, 3200));

  const routes = socket.sent.filter((m) => m.type === 'route_decision');
  assert.equal(routes.length, 1, 'un solo ruteo para los dos fragmentos');
  assert.equal(received.length, 1);
  assert.ok(received[0].includes('contarte algo del sistema'));
  assert.ok(received[0].includes('lavar los platos'), 'el turno combinado tiene TODO el contexto');
});

test('paciencia: un conector al final extiende la espera', () => {
  assert.equal(MeetingSession.seemsUnfinished('quiero que hagas dos cosas: primero'), true);
  assert.equal(MeetingSession.seemsUnfinished('además,'), true);
  assert.equal(MeetingSession.seemsUnfinished('lavá los platos y'), true);
  assert.equal(MeetingSession.seemsUnfinished('lavá los platos.'), false);
  assert.equal(MeetingSession.seemsUnfinished('¿cómo va el stock?'), false);
});

test('la CEO coordina: un entregable en su mano pasa a quien tiene el oficio', async () => {
  const { session } = newSession();
  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');

  // Como pasó de verdad: la jefa quedó con la web del desarrollador y la
  // reescribía entera con su propio estilo.
  await session.handleClientMessage({
    type: 'add_task',
    agentId: ceo.id,
    text: 'crear la página web del catálogo con html y css'
  });

  const movidas = session.reassignCeoDeliverables();
  assert.equal(movidas.length, 1, 'la tarea se movió');
  assert.equal(ceo.tasks.filter((t) => !t.completed).length, 0);

  // Fue a parar a alguien cuyas skills coinciden con lo pedido, no a cualquiera.
  const destino = session.sessionAgents.find((a) => a.name === movidas[0].a);
  assert.ok(destino.domains.some((d) => /html|css|front|web/.test(d)), 'quedó en quien tiene el oficio');
  assert.ok(destino.tasks.some((t) => t.text.includes('página web del catálogo')));
});

test('lo que sí es de la CEO se queda con ella', async () => {
  const { session } = newSession();
  const ceo = session.sessionAgents.find((a) => a.role === 'ceo');

  // Coordinar no es un entregable: no hay a quién pasárselo.
  await session.handleClientMessage({ type: 'add_task', agentId: ceo.id, text: 'definir la prioridad de la semana' });
  assert.equal(session.reassignCeoDeliverables().length, 0);
  assert.equal(ceo.tasks.length, 1);
});

test('"Comenzar a trabajar": el equipo arranca con lo que ya tiene, sin cerrar la reunión', async () => {
  const { socket, session, store, julioId, tomasaId } = newSession();

  // Sin nada asignado el botón no hace nada, pero lo dice.
  session.startWorkNow();
  const vacio = socket.sent.filter((m) => m.type === 'work_started').at(-1);
  assert.equal(vacio.tasks, 0);
  assert.match(vacio.note, /tasks assigned/i);
  assert.equal(store.workQueue(session.company.id).length, 0);

  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'armar el informe de stock' });
  await session.handleClientMessage({ type: 'add_task', agentId: tomasaId, text: 'revisar las rutas de reparto' });

  const reunionAntes = session.meeting.id;
  session.startWorkNow();

  const arranque = socket.sent.filter((m) => m.type === 'work_started').at(-1);
  assert.equal(arranque.tasks, 2, 'arrancan las dos');
  assert.ok(arranque.goalTitle, 'el trabajo queda bajo un proyecto');
  assert.equal(session.meeting.id, reunionAntes, 'la reunión sigue abierta');

  const cola = store.workQueue(session.company.id);
  assert.equal(cola.length, 2);
});

test('tocar el botón dos veces no encola la misma tarea de nuevo', async () => {
  const { session, store, julioId } = newSession();
  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'armar el informe' });

  session.startWorkNow();
  session.startWorkNow();

  assert.equal(store.workQueue(session.company.id).length, 1, 'sigue habiendo una sola');
});

test('lo ya completado no vuelve a la cola', async () => {
  const { session, store, julioId } = newSession();
  await session.handleClientMessage({ type: 'add_task', agentId: julioId, text: 'algo viejo' });
  const julio = session.sessionAgents.find((a) => a.id === julioId);
  julio.tasks[0].completed = true;

  session.startWorkNow();
  assert.equal(store.workQueue(session.company.id).length, 0);
});


// Lo que la CEO propone como archivo destino tiene que ser un archivo de
// verdad: "Figma" o una ruta que escapa del proyecto no pueden pasar.
test('el archivo destino de un entregable se sanea', () => {
  const ok = ['index.html', 'css/estilos.css', 'app.js', './menu.json'];
  for (const valor of ok) {
    assert.ok(MeetingSession.normalizeTargetFile(valor), `${valor} tendría que valer`);
  }
  const mal = ['Figma', 'un prototipo', '/etc/passwd', '../fuera.html', '.env', '', null, undefined];
  for (const valor of mal) {
    assert.equal(MeetingSession.normalizeTargetFile(valor), null, `${valor} no puede pasar`);
  }
  assert.equal(MeetingSession.normalizeTargetFile('./menu.json'), 'menu.json');
});
