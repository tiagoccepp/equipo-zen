import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiKeyRing } from '../server/lib/key-ring.js';
import { MeetingSession } from '../server/lib/meeting-session.js';

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

function newSession() {
  const socket = fakeSocket();
  const session = new MeetingSession(socket, new ApiKeyRing([]));
  return { socket, session };
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
