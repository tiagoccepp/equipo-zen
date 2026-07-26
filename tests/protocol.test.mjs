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
    agent: { name: ' Ana ', title: 'QA', domains: 'testing, calidad', voice: 'F1', initialTasks: ['  probar login  '] }
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

test('el cuerpo del pedido usa el nombre de tope de tokens de cada proveedor', async () => {
  // MiniMax usa max_completion_tokens; DeepSeek usa max_tokens y el otro lo
  // ignora en silencio, así que equivocarse no falla: sale mal y no se nota.
  const { LLM_PROVIDERS } = await import('../server/lib/config.js');
  assert.equal(LLM_PROVIDERS.minimax.tokenParam, 'max_completion_tokens');
  assert.equal(LLM_PROVIDERS.deepseek.tokenParam, 'max_tokens');
  assert.match(LLM_PROVIDERS.deepseek.url, /api\.deepseek\.com/);
  assert.deepEqual(LLM_PROVIDERS.deepseek.models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  // DeepSeek piensa por defecto: hay que apagarlo para conversar rápido.
  assert.equal(LLM_PROVIDERS.deepseek.thinking, 'disabled');
});

test('cambiar de proveedor no arrastra el modelo del otro', async () => {
  const { Store } = await import('../server/lib/store.js');
  const { ApiKeyRing } = await import('../server/lib/key-ring.js');
  const settings = await import('../server/lib/settings.js');
  const store = new Store(':memory:');
  settings.initSettings(store, new ApiKeyRing([]));

  settings.applySettings({ 'llm.provider': 'deepseek', 'llm.model': 'deepseek-v4-pro' });
  assert.equal(settings.getLlmProvider(), 'deepseek');
  assert.equal(settings.getLlmModels()[0], 'deepseek-v4-pro');
  assert.match(settings.getLlmProviderConfig().url, /deepseek/);

  settings.applySettings({ 'llm.provider': 'minimax' });
  assert.match(settings.getLlmModels()[0], /^MiniMax/, 'no queda apuntando a un modelo que MiniMax no conoce');

  settings.applySettings({ 'llm.provider': 'inventado' });
  assert.equal(settings.getLlmProvider(), 'minimax', 'un proveedor desconocido se ignora');
  store.close();
});

test('cada proveedor guarda su clave por separado', async () => {
  const { Store } = await import('../server/lib/store.js');
  const { ApiKeyRing } = await import('../server/lib/key-ring.js');
  const settings = await import('../server/lib/settings.js');
  const store = new Store(':memory:');
  settings.initSettings(store, new ApiKeyRing([]));

  settings.applySettings({ 'llm.apiKey': 'clave-minimax-123456', 'llm.deepseekKey': 'clave-deepseek-7890' });
  assert.deepEqual(settings.getLlmKeys('minimax'), ['clave-minimax-123456']);
  assert.deepEqual(settings.getLlmKeys('deepseek'), ['clave-deepseek-7890']);

  // Ir y volver de proveedor no pierde ninguna.
  settings.applySettings({ 'llm.provider': 'deepseek' });
  assert.deepEqual(settings.getLlmKeys(), ['clave-deepseek-7890']);
  settings.applySettings({ 'llm.provider': 'minimax' });
  assert.deepEqual(settings.getLlmKeys(), ['clave-minimax-123456']);
  store.close();
});
