// E-14: providers configurables — orden, customs y failover cruzado.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetSticky, completeChat } from '../server/lib/llm.js';
import { __resetProviderPool, failoverRings } from '../server/lib/providers.js';
import {
  getFailoverOrder,
  getLlmModels,
  getLlmModelsFor,
  initSettings
} from '../server/lib/settings.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
const realFetch = globalThis.fetch;
afterEach(() => {
  db.clear();
  globalThis.fetch = realFetch;
  __resetSticky();
  __resetProviderPool();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.MINIMAX_API_KEY;
});

function ring() {
  return {
    hasKeys: () => true, size: () => 1,
    acquire: () => ({ id: 'key-1' }),
    reportSuccess: () => {}, reportFailure: () => {}, logKey: () => {}
  };
}

test('e14: orden failover (activo + configurados con llave)', () => {
  db.set('llm.provider', 'opencode');
  db.set('llm.opencodeKey', 'k-op');
  db.set('llm.deepseekKey', 'k-ds');
  db.set('llm.failover', 'groq, deepseek, invento');
  // groq sin llave → fuera; invento inválido → fuera.
  assert.deepEqual(getFailoverOrder(), ['opencode', 'deepseek']);
  db.delete('llm.failover');
  assert.deepEqual(getFailoverOrder(), ['opencode', 'deepseek']);
  db.set('llm.provider', 'groq');
  assert.deepEqual(getFailoverOrder()[0], 'groq', 'activo primero aunque sin llave');
});

test('e14: customs solo para el activo', () => {
  db.set('llm.provider', 'opencode');
  db.set('llm.models', 'mi-modelo-1, mi-modelo-2');
  assert.deepEqual(getLlmModels(), ['mi-modelo-1', 'mi-modelo-2']);
  assert.deepEqual(getLlmModelsFor('opencode'), ['mi-modelo-1', 'mi-modelo-2']);
  assert.ok(!getLlmModelsFor('deepseek').includes('mi-modelo-1'), 'otros: curados');
  db.delete('llm.models');
  assert.ok(getLlmModels().length > 1, 'curados por default');
  assert.deepEqual(getLlmModelsFor('invento'), []);
});

test('e14: failover cruzado — activo 500s, siguiente responde', async () => {
  db.set('llm.provider', 'opencode');
  db.set('llm.opencodeKey', 'k-op');
  db.set('llm.deepseekKey', 'k-ds');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, model: JSON.parse(init.body).model });
    if (String(url).includes('deepseek')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hola-ds' } }] }) };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
  };
  const events = [];
  const out = await completeChat(ring(), {
    scope: 'e14', messages: [{ role: 'user', content: 'h' }],
    emit: (e) => events.push(e)
  });
  assert.equal(out.text, 'hola-ds', 'respondió el failover');
  assert.ok(seen.some((s) => String(s.url).includes('deepseek')), 'pegó a deepseek');
  assert.ok(events.some((e) => e.type === 'api_stage' && e.provider === 'deepseek'), 'etapa con provider');
  // noFailover: lanza sin intentar otros.
  await assert.rejects(() => completeChat(ring(), {
    scope: 'e14', messages: [{ role: 'user', content: 'h' }], noFailover: true
  }), /HTTP 500/);
});

test('e14: pool rings con re-sync de llaves', () => {
  db.set('llm.provider', 'opencode');
  db.set('llm.opencodeKey', 'k1');
  const rings = failoverRings();
  assert.equal(rings[0].providerId, 'opencode');
  assert.equal(rings[0].ring.hasKeys(), true);
});
