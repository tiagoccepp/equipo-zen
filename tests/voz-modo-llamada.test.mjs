import { test } from 'node:test';
import assert from 'node:assert/strict';

import { companyTemplates } from '../server/lib/config.js';
import { ApiKeyRing } from '../server/lib/key-ring.js';
import { MeetingSession } from '../server/lib/meeting-session.js';
import { Store } from '../server/lib/store.js';
import { parseClientMessage } from '../shared/protocol.ts';

function sesion() {
  const enviados = [];
  const socket = { readyState: 1, OPEN: 1, send: (p) => enviados.push(JSON.parse(p)) };
  const store = new Store(':memory:');
  store.ensureCompanies(companyTemplates);
  const session = new MeetingSession(socket, new ApiKeyRing([]), store);
  session.initMeeting(null);
  return { session, enviados, store };
}

test('a meeting starts WITHOUT voice: over text nothing is synthesized', () => {
  const { session } = sesion();
  assert.equal(session.voiceEnabled, false, 'el default tiene que ser sin voz');
});

test('entering call mode turns voice on and leaving turns it off', async () => {
  const { session } = sesion();

  await session.handleClientMessage({ type: 'set_voice', enabled: true });
  assert.equal(session.voiceEnabled, true);

  await session.handleClientMessage({ type: 'set_voice', enabled: false });
  assert.equal(session.voiceEnabled, false);
});

test('leaving the call cuts whatever was playing', async () => {
  const { session } = sesion();
  let vaciado = 0;
  session.gate.flush = () => { vaciado += 1; };

  await session.handleClientMessage({ type: 'set_voice', enabled: true });
  assert.equal(vaciado, 0, 'entrar no corta nada');

  await session.handleClientMessage({ type: 'set_voice', enabled: false });
  assert.equal(vaciado, 1, 'salir sí corta el audio en curso');
});

test('the protocol accepts set_voice and normalizes it to boolean', () => {
  for (const [entrada, esperado] of [[true, true], [false, false], ['si', true], [undefined, false], [0, false]]) {
    const r = parseClientMessage(JSON.stringify({ type: 'set_voice', enabled: entrada }));
    assert.equal(r.ok, true, `set_voice con ${JSON.stringify(entrada)} tiene que parsear`);
    assert.equal(r.message.enabled, esperado);
  }
});

// The root reason for the fix: without voice the SpeakerGate is never taken,
// and without the gate agents stop serializing one by one.
test('without voice the agent does not ask for the speaker', async () => {
  const { session } = sesion();
  const agente = session.sessionAgents[0];
  const runtime = session.agents.get(agente.id);

  let adquisiciones = 0;
  const gateFalso = {
    acquire: async () => { adquisiciones += 1; return { id: 'x' }; },
    sendChunk() {},
    finish() {}
  };

  session.voiceEnabled = false;
  await runtime.respond({ text: 'hola', route: {} }, () => {}, { gate: gateFalso, turnId: 't1' });
  assert.equal(adquisiciones, 0, 'sin llamada, nadie toma el altavoz');
});
