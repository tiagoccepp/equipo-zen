import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClientMessage, parseServerMessage } from '../shared/protocol.ts';

test('user_turn válido pasa; texto gigante se rechaza', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'user_turn', text: 'hola' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.text, 'hola');

  const grande = parseClientMessage(JSON.stringify({ type: 'user_turn', text: 'x'.repeat(100000) }));
  assert.equal(grande.ok, false);
});

test('tipo desconocido se rechaza en el servidor', () => {
  const res = parseClientMessage(JSON.stringify({ type: 'hackeo', data: 1 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /desconocido/);
});

test('spawn_agent: voz fuera de whitelist y style gigante se rechazan', () => {
  const malaVoz = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: 'Ana', title: 'QA', voice: 'Batman' }
  }));
  assert.equal(malaVoz.ok, false);
  assert.match(malaVoz.error, /Voz inválida/);

  const estiloGigante = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: 'Ana', title: 'QA', style: 'x'.repeat(10000) }
  }));
  assert.equal(estiloGigante.ok, false);
});

test('spawn_agent válido normaliza listas desde string', () => {
  const res = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: ' Ana ', title: 'QA', domains: 'testing, calidad', voice: 'Kore', initialTasks: ['  probar login  '] }
  }));
  assert.equal(res.ok, true);
  assert.equal(res.message.agent.name, 'Ana');
  assert.deepEqual(res.message.agent.domains, ['testing', 'calidad']);
  assert.deepEqual(res.message.agent.initialTasks, ['probar login']);
});

test('audio_chunk exige data acotada', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'audio_chunk', data: 'QUJD', mimeType: 'audio/pcm;rate=16000' }));
  assert.equal(ok.ok, true);
  const vacio = parseClientMessage(JSON.stringify({ type: 'audio_chunk', data: '' }));
  assert.equal(vacio.ok, false);
});

test('parseServerMessage: pasa tipos desconocidos y rechaza basura', () => {
  assert.equal(parseServerMessage('{"type":"mensaje_nuevo","x":1}').type, 'mensaje_nuevo');
  assert.equal(parseServerMessage('no es json'), null);
  assert.equal(parseServerMessage('{"sinTipo":true}'), null);
});
