import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentConfig } from '../server/lib/config.js';
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
  store.seedAgentsIfEmpty(agentConfig);
  return store;
}

function newSession(store = newStore()) {
  const socket = fakeSocket();
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null);
  return { socket, session, store };
}

test('SILENCIO + [TAREA_CREAR] crea la tarea aunque el agente calle', async () => {
  const { socket, session } = newSession();
  const julio = session.agents.get('programacion');
  julio.respond = async (_turn, emit) => {
    emit({ type: 'agent_silence', reason: 'protocolo' });
    return { rawText: 'SILENCIO [TAREA_CREAR: revisar stock del depósito]', text: '', audioChunks: [], usedMock: true };
  };

  await session.processUserTurn('t1', 'julio fijate esto');

  const julioAgent = session.sessionAgents.find((a) => a.id === 'programacion');
  assert.equal(julioAgent.tasks.length, 1);
  assert.equal(julioAgent.tasks[0].text, 'revisar stock del depósito');
  assert.equal(julioAgent.tasks[0].completed, false);

  const complete = socket.sent.find((m) => m.type === 'agent_turn_complete' && m.agentId === 'programacion');
  assert.equal(complete.text, '');
  assert.equal(session.memory.lastAgentTurn(), null);
});

test('respuesta hablada con tag crea tarea y limpia el texto visible', async () => {
  const { socket, session } = newSession();
  const julio = session.agents.get('programacion');
  julio.respond = async () => ({
    rawText: 'Dale, lo agendo. [TAREA_CREAR: armar endpoint de cobranzas]',
    text: 'Dale, lo agendo. [TAREA_CREAR: armar endpoint de cobranzas]',
    audioChunks: [],
    usedMock: true
  });

  await session.processUserTurn('t2', 'julio anotate armar el endpoint');

  const julioAgent = session.sessionAgents.find((a) => a.id === 'programacion');
  assert.equal(julioAgent.tasks.at(-1).text, 'armar endpoint de cobranzas');
  const complete = socket.sent.find((m) => m.type === 'agent_turn_complete' && m.agentId === 'programacion');
  assert.equal(complete.text, 'Dale, lo agendo.');
  assert.equal(session.memory.lastAgentTurn().text, 'Dale, lo agendo.');
});

test('tag con destinatario explícito asigna la tarea al otro agente', async () => {
  const { session } = newSession();
  const julio = session.agents.get('programacion');
  julio.respond = async () => ({
    rawText: 'Eso lo ve Tomasa. [TAREA_CREAR: operaciones: validar stock físico]',
    text: 'Eso lo ve Tomasa. [TAREA_CREAR: operaciones: validar stock físico]',
    audioChunks: [],
    usedMock: true
  });

  await session.processUserTurn('t3', 'julio coordiná la validación');

  const tomasa = session.sessionAgents.find((a) => a.id === 'operaciones');
  assert.equal(tomasa.tasks.at(-1).text, 'validar stock físico');
});

test('spawn_agent: cap de agentes y dedup por nombre', async () => {
  const { socket, session } = newSession();

  await session.handleClientMessage({
    type: 'spawn_agent',
    agent: { name: 'Julio', title: 'Otro', aliases: [], domains: [], boundaries: [], initialTasks: [] }
  });
  assert.ok(socket.sent.some((m) => m.type === 'error' && /Ya hay un agente llamado/.test(m.message)));

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
  assert.ok(socket.sent.some((m) => m.type === 'error' && /mesa está completa/.test(m.message)));
  assert.equal(session.sessionAgents.length, 8);
});

test('modo mock: sin claves los agentes responden enlatado con usedMock', async () => {
  const { socket, session } = newSession();
  await session.processUserTurn('t4', 'hola equipo');

  const completes = socket.sent.filter((m) => m.type === 'agent_turn_complete');
  assert.equal(completes.length, 2);
  for (const complete of completes) {
    assert.equal(complete.usedMock, true);
    assert.match(complete.text, /modo simulación/);
  }
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
  const { session, store } = newSession();

  await session.handleClientMessage({
    type: 'update_agent',
    agentId: 'programacion',
    patch: { style: 'habla más formal', boundaries: ['No estima plazos sin datos'] }
  });

  const updated = store.getAgent('programacion');
  assert.equal(updated.style, 'habla más formal');
  assert.deepEqual(updated.boundaries, ['No estima plazos sin datos']);
  assert.equal(updated.version, 2);
  assert.equal(store.listAgentVersions('programacion').length, 1);
  assert.ok(store.listChangelog({ entity: 'agent', entityId: 'programacion' }).length >= 1);

  const inSession = session.sessionAgents.find((a) => a.id === 'programacion');
  assert.equal(inSession.style, 'habla más formal');
});

test('set_agent_enabled saca al agente del ruteo pero lo deja en el roster', async () => {
  const { session } = newSession();

  await session.handleClientMessage({ type: 'set_agent_enabled', agentId: 'operaciones', enabled: false });

  const tomasa = session.sessionAgents.find((a) => a.id === 'operaciones');
  assert.equal(tomasa.enabled, false);
  const route = session.router.route('¿cómo viene el stock del inventario?', session.memory);
  assert.ok(!route.targets.some((t) => t.agentId === 'operaciones'));
  assert.ok(session.publicAgents().some((a) => a.id === 'operaciones'));
});

test('archive_agent solo permite archivar agentes custom', async () => {
  const { socket, session, store } = newSession();

  await session.handleClientMessage({ type: 'archive_agent', agentId: 'programacion' });
  assert.ok(socket.sent.some((m) => m.type === 'error' && /equipo base/.test(m.message)));

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
  assert.equal(session.promptContext().scenario.text, 'Sprint de migración del sistema de pedidos');
});
