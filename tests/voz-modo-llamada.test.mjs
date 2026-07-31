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

test('una reunión arranca SIN voz: por texto no se sintetiza nada', () => {
  const { session } = sesion();
  assert.equal(session.voiceEnabled, false, 'el default tiene que ser sin voz');
});

test('entrar al modo llamada prende la voz y salir la apaga', async () => {
  const { session } = sesion();

  await session.handleClientMessage({ type: 'set_voice', enabled: true });
  assert.equal(session.voiceEnabled, true);

  await session.handleClientMessage({ type: 'set_voice', enabled: false });
  assert.equal(session.voiceEnabled, false);
});

test('salir de la llamada corta lo que estuviera sonando', async () => {
  const { session } = sesion();
  let vaciado = 0;
  session.gate.flush = () => { vaciado += 1; };

  await session.handleClientMessage({ type: 'set_voice', enabled: true });
  assert.equal(vaciado, 0, 'entrar no corta nada');

  await session.handleClientMessage({ type: 'set_voice', enabled: false });
  assert.equal(vaciado, 1, 'salir sí corta el audio en curso');
});

test('el protocolo acepta set_voice y lo normaliza a booleano', () => {
  for (const [entrada, esperado] of [[true, true], [false, false], ['si', true], [undefined, false], [0, false]]) {
    const r = parseClientMessage(JSON.stringify({ type: 'set_voice', enabled: entrada }));
    assert.equal(r.ok, true, `set_voice con ${JSON.stringify(entrada)} tiene que parsear`);
    assert.equal(r.message.enabled, esperado);
  }
});

// La razón de fondo del arreglo: sin voz el SpeakerGate no se toma, y sin
// gate los agentes dejan de serializarse de a uno.
test('sin voz el agente no pide el altavoz', async () => {
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
