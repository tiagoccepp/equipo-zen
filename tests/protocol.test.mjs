import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentToolEvent, parseClientMessage, parseServerMessage } from '../shared/protocol.ts';

test('valid user_turn passes; giant text is rejected', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'user_turn', text: 'hola' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.text, 'hola');

  const grande = parseClientMessage(JSON.stringify({ type: 'user_turn', text: 'x'.repeat(100000) }));
  assert.equal(grande.ok, false);
});

test('unknown type is rejected on the server', () => {
  const res = parseClientMessage(JSON.stringify({ type: 'hackeo', data: 1 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown|desconocido/i);
});

test('spawn_agent: off-whitelist voice and giant style are rejected', () => {
  const malaVoz = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: 'Ana', title: 'QA', voice: 'Batman' }
  }));
  assert.equal(malaVoz.ok, false);
  assert.match(malaVoz.error, /Invalid voice|Voz inválida/);

  const estiloGigante = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: 'Ana', title: 'QA', style: 'x'.repeat(10000) }
  }));
  assert.equal(estiloGigante.ok, false);
});

test('valid spawn_agent normalizes lists from string', () => {
  const res = parseClientMessage(JSON.stringify({
    type: 'spawn_agent',
    agent: { name: ' Ana ', title: 'QA', domains: 'testing, calidad', voice: 'F1', initialTasks: ['  probar login  '] }
  }));
  assert.equal(res.ok, true);
  assert.equal(res.message.agent.name, 'Ana');
  assert.deepEqual(res.message.agent.domains, ['testing', 'calidad']);
  assert.deepEqual(res.message.agent.initialTasks, ['probar login']);
});

test('audio_chunk requires bounded data', () => {
  const ok = parseClientMessage(JSON.stringify({ type: 'audio_chunk', data: 'QUJD', mimeType: 'audio/pcm;rate=16000' }));
  assert.equal(ok.ok, true);
  const vacio = parseClientMessage(JSON.stringify({ type: 'audio_chunk', data: '' }));
  assert.equal(vacio.ok, false);
});

test('parseServerMessage: passes unknown types and rejects garbage', () => {
  assert.equal(parseServerMessage('{"type":"mensaje_nuevo","x":1}').type, 'mensaje_nuevo');
  assert.equal(parseServerMessage('no es json'), null);
  assert.equal(parseServerMessage('{"sinTipo":true}'), null);
});

test('valid agent_tool_call passes; giant preview or missing tool is rejected', () => {
  const ok = parseAgentToolEvent(JSON.stringify({
    type: 'agent_tool_call', turnId: 't1', agentId: 'bruno', tool: 'read', argsPreview: '{"path":"a.ts"}'
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.type, 'agent_tool_call');
  assert.equal(ok.message.tool, 'read');

  const grande = parseAgentToolEvent(JSON.stringify({
    type: 'agent_tool_call', turnId: 't1', agentId: 'bruno', tool: 'read', argsPreview: 'x'.repeat(201)
  }));
  assert.equal(grande.ok, false);

  const sinTool = parseAgentToolEvent(JSON.stringify({ type: 'agent_tool_call', turnId: 't1', agentId: 'bruno' }));
  assert.equal(sinTool.ok, false);

  const otroTipo = parseAgentToolEvent(JSON.stringify({ type: 'agent_progress', turnId: 't1', agentId: 'b', text: 'x' }));
  assert.equal(otroTipo.ok, false);
});

test('valid agent_tool_done passes; invalid ok/ms are rejected', () => {
  const ok = parseAgentToolEvent(JSON.stringify({
    type: 'agent_tool_done', turnId: 't1', agentId: 'bruno', tool: 'read', ok: true, ms: 42, outputPreview: 'contenido…'
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.message.type, 'agent_tool_done');
  assert.equal(ok.message.ms, 42);

  const sinOk = parseAgentToolEvent(JSON.stringify({
    type: 'agent_tool_done', turnId: 't1', agentId: 'bruno', tool: 'read', ms: 42
  }));
  assert.equal(sinOk.ok, false);

  const msMalo = parseAgentToolEvent(JSON.stringify({
    type: 'agent_tool_done', turnId: 't1', agentId: 'bruno', tool: 'read', ok: false, ms: -5
  }));
  assert.equal(msMalo.ok, false);
});

test("the request body uses each provider's token-cap name", async () => {
  // MiniMax uses max_completion_tokens; DeepSeek uses max_tokens and the other one
  // silently ignores it, so getting it wrong does not fail: it comes out wrong and nobody notices.
  const { LLM_PROVIDERS } = await import('../server/lib/config.js');
  assert.equal(LLM_PROVIDERS.minimax.tokenParam, 'max_completion_tokens');
  assert.equal(LLM_PROVIDERS.deepseek.tokenParam, 'max_tokens');
  assert.match(LLM_PROVIDERS.deepseek.url, /api\.deepseek\.com/);
  assert.deepEqual(LLM_PROVIDERS.deepseek.models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  // DeepSeek thinks by default: it must be switched off for fast conversation.
  assert.equal(LLM_PROVIDERS.deepseek.thinking, 'disabled');
});

test("switching providers does not drag the other one's model", async () => {
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

test('each provider keeps its key separately', async () => {
  const { Store } = await import('../server/lib/store.js');
  const { ApiKeyRing } = await import('../server/lib/key-ring.js');
  const settings = await import('../server/lib/settings.js');
  const store = new Store(':memory:');
  settings.initSettings(store, new ApiKeyRing([]));

  settings.applySettings({ 'llm.apiKey': 'clave-minimax-123456', 'llm.deepseekKey': 'clave-deepseek-7890' });
  assert.deepEqual(settings.getLlmKeys('minimax'), ['clave-minimax-123456']);
  assert.deepEqual(settings.getLlmKeys('deepseek'), ['clave-deepseek-7890']);

  // Going and coming back between providers loses none.
  settings.applySettings({ 'llm.provider': 'deepseek' });
  assert.deepEqual(settings.getLlmKeys(), ['clave-deepseek-7890']);
  settings.applySettings({ 'llm.provider': 'minimax' });
  assert.deepEqual(settings.getLlmKeys(), ['clave-minimax-123456']);
  store.close();
});
