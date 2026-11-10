// Live group-call tests (turn process): R1 → R2 reply → CEO
// close, behind the sala.groupchat flag (default OFF). 100% fake model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The on-disk journal and convention seeds are not part of what is
// tested: they are turned off BEFORE loading the modules.
process.env.SESSION_LOG = '0';
process.env.PABLO_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'gc-turno-'));

const { companyTemplates } = await import('../server/lib/config.js');
const { ApiKeyRing } = await import('../server/lib/key-ring.js');
const { MeetingSession } = await import('../server/lib/meeting-session.js');
const { Store } = await import('../server/lib/store.js');
const { initSettings } = await import('../server/lib/settings.js');

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

// Bruno speaks in R1 and names Camila (no QA domains: the OLD handoff
// does not fire and OFF stays at a single voice). Camila answers HIM.
// Renata (CEO) closes. Texts without aliases or foreign domains.
const TEXTO_BRUNO = 'Yo saldría con la página estática: publica hoy mismo. Camila, el CMS nos suma una semana, ¿lo ves viable?';
const TEXTO_CAMILA = 'Bruno, el CMS deja editar sin programar: para mí compensa.';
const TEXTO_RENATA = 'Decisión: salimos con estática y el CMS queda para fase dos.';

function nuevaSesion({ groupchat }) {
  const store = new Store(':memory:');
  store.ensureCompanies(companyTemplates);
  if (groupchat) {
    store.setSetting('sala.groupchat', 'true');
  }
  const keyRing = new ApiKeyRing([]);
  initSettings(store, keyRing);
  const socket = fakeSocket();
  const session = new MeetingSession(socket, keyRing, store);
  session.initMeeting(null);
  const byName = (n) => session.sessionAgents.find((a) => a.name === n);
  const bruno = byName('Bruno');
  const camila = byName('Camila');
  const renata = byName('Renata');
  assert.ok(bruno && camila && renata, 'roster trae Bruno, Camila y Renata');

  const turnos = []; // { agentId, turn } — what each agent SAW
  const callados = [];
  for (const agent of session.sessionAgents) {
    const rt = session.agents.get(agent.id);
    const texto = agent.id === bruno.id ? TEXTO_BRUNO : agent.id === camila.id ? TEXTO_CAMILA : agent.id === renata.id ? TEXTO_RENATA : '';
    rt.respond = async (turn) => {
      turnos.push({ agentId: agent.id, turn });
      if (!texto) {
        callados.push(agent.id);
      }
      return { rawText: texto, text: texto, audioChunks: [], usedMock: true };
    };
  }
  const telemetria = [];
  const logReal = session.logTelemetry.bind(session);
  session.logTelemetry = (type, payload, turnId) => {
    telemetria.push({ type, payload });
    return logReal(type, payload, turnId);
  };
  return { session, socket, store, bruno, camila, renata, turnos, telemetria };
}

function voces(socket) {
  return socket.sent.filter((m) => m.type === 'agent_turn_complete' && m.text).map((m) => m.agentId);
}

test('flag ON: R1 → reply of the mentioned one → CEO close (3 voices)', async () => {
  const { session, socket, bruno, camila, renata, turnos, telemetria } = nuevaSesion({ groupchat: true });
  try {
    await session.processUserTurn('t1', 'Bruno, ¿la landing la hacemos estática o con CMS?');

    assert.deepEqual(voces(socket), [bruno.id, camila.id, renata.id], 'hablan Bruno, Camila y Renata en orden');

    // Camila replies ONCE (R2 picks her up before the old followup).
    const turnosCamila = turnos.filter((t) => t.agentId === camila.id);
    assert.equal(turnosCamila.length, 1, 'Camila habla una sola vez');
    assert.ok(turnosCamila[0].turn.isContextualFollowup, 'la réplica va como followup');
    assert.ok(turnosCamila[0].turn.text.includes('Bruno te habló'), 'le habla A Bruno');
    assert.ok(turnosCamila[0].turn.text.includes('¿la landing la hacemos estática o con CMS?'), 've el pedido de Tito');
    assert.ok(
      turnosCamila[0].turn.priorResponses.some((r) => r.name === 'Bruno' && r.text === TEXTO_BRUNO),
      've quién dijo qué (nombre: texto)'
    );

    // Renata closes in one line.
    const turnosRenata = turnos.filter((t) => t.agentId === renata.id);
    assert.equal(turnosRenata.length, 1, 'Renata habla una sola vez');
    assert.ok(turnosRenata[0].turn.text.includes('Cerrá la ronda'), 'cierre CEO');

    // Group telemetry.
    const replica = telemetria.find((t) => t.type === 'groupchat_replica');
    assert.ok(replica, 'evento groupchat_replica');
    assert.equal(replica.payload.agentId, camila.id);
    assert.equal(replica.payload.citedBy, 'Bruno');
    assert.ok(telemetria.some((t) => t.type === 'groupchat_ceo_close'), 'evento groupchat_ceo_close');
  } finally {
    session.close();
  }
});

test('flag ON: if nobody mentions anybody, no R2 nor close', async () => {
  const { session, socket, bruno, telemetria } = nuevaSesion({ groupchat: true });
  try {
    const rt = session.agents.get(bruno.id);
    rt.respond = async (turn) => ({ rawText: 'Salgo con estática y listo.', text: 'Salgo con estática y listo.', audioChunks: [], usedMock: true });
    await session.processUserTurn('t1', 'Bruno, ¿la landing la hacemos estática o con CMS?');
    assert.deepEqual(voces(socket), [bruno.id], 'solo Bruno');
    assert.ok(!telemetria.some((t) => t.type === 'groupchat_replica'), 'sin réplica');
    assert.ok(!telemetria.some((t) => t.type === 'groupchat_ceo_close'), 'sin cierre');
  } finally {
    session.close();
  }
});

test('flag OFF (default): one voice, zero group telemetry', async () => {
  const { session, socket, bruno, telemetria } = nuevaSesion({ groupchat: false });
  try {
    await session.processUserTurn('t1', 'Bruno, ¿la landing la hacemos estática o con CMS?');
    assert.deepEqual(voces(socket), [bruno.id], 'solo Bruno, como siempre');
    assert.ok(!telemetria.some((t) => String(t.type).startsWith('groupchat_')), 'cero telemetría grupal');
  } finally {
    session.close();
  }
});

test('flag ON: seed conventions created for the roster', async () => {
  const { readFileSync } = await import('node:fs');
  const { session } = nuevaSesion({ groupchat: true });
  try {
    const { conventionsPathFor } = await import('../server/lib/agent-conventions.js');
    for (const agent of session.sessionAgents.slice(0, 3)) {
      const raw = readFileSync(conventionsPathFor(session.company.id, agent.id), 'utf-8');
      assert.ok(raw.includes(agent.name), `${agent.name}: seed con su nombre`);
    }
  } finally {
    session.close();
  }
});
