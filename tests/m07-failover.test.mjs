// M-07: failover 2 etapas + sticky — orden, TTL y eventos. Fetch falso.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetSticky,
  completeChat,
  markStickyModel,
  orderModelsSticky,
  stickyModelFor
} from '../server/lib/llm.js';
import { initSettings } from '../server/lib/settings.js';

const db = new Map();
initSettings(
  {
    getSetting: (k) => (db.has(k) ? db.get(k) : null),
    setSetting: (k, v) => { db.set(k, v); },
    deleteSetting: (k) => { db.delete(k); },
    logChange: () => {}
  },
  { setKeys: () => {} }
);

const realFetch = globalThis.fetch;
afterEach(() => {
  db.clear();
  globalThis.fetch = realFetch;
  __resetSticky();
});

function fakeRing() {
  return {
    hasKeys: () => true,
    size: () => 1,
    acquire: () => ({ id: 'key-1' }),
    reportSuccess: () => {},
    reportFailure: () => {},
    logKey: () => {}
  };
}

test('m07: sticky va primero por scope; TTL y scope aíslan', () => {
  assert.deepEqual(orderModelsSticky(['a', 'b', 'c'], 's1'), ['a', 'b', 'c'], 'sin sticky: orden dado');
  markStickyModel('s1', 'b');
  assert.deepEqual(orderModelsSticky(['a', 'b', 'c'], 's1'), ['b', 'a', 'c']);
  assert.deepEqual(orderModelsSticky(['a', 'b', 'c'], 's2'), ['a', 'b', 'c'], 'otro scope: no afecta');
  assert.equal(stickyModelFor('s1', ['a', 'c']), null, 'sticky fuera de lista: null');
  assert.equal(stickyModelFor('s1', ['a', 'b']), 'b');
});

test('m07: éxito marca sticky; siguiente llamada lo usa primero', async () => {
  db.set('llm.provider', 'opencode');
  const seenModels = [];
  // Falla 'm1' (500 en ambos reintentos etapa 1), funciona 'm2' → sticky m2.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seenModels.push(body.model);
    if (body.model === 'm1') {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hola' } }] }) };
  };
  const events = [];
  const out = await completeChat(fakeRing(), {
    models: ['m1', 'm2'], scope: 'secreto-test', messages: [{ role: 'user', content: 'h' }],
    emit: (e) => events.push(e)
  });
  assert.equal(out.model, 'm2');
  assert.ok(events.some((e) => e.type === 'api_stage' && e.stage === 2 && e.model === 'm2'), 'etapa 2 emitida');
  // Segunda llamada: m2 primero (sticky), sin etapa 2.
  seenModels.length = 0;
  events.length = 0;
  await completeChat(fakeRing(), {
    models: ['m1', 'm2'], scope: 'secreto-test', messages: [{ role: 'user', content: 'h' }],
    emit: (e) => events.push(e)
  });
  assert.equal(seenModels[0], 'm2', 'sticky primero');
  assert.ok(!events.some((e) => e.type === 'api_stage' && e.stage === 2), 'sin failover');
});

test('m07: vacío emite etapa 1 y reintenta mismo modelo', async () => {
  db.set('llm.provider', 'opencode');
  const seenModels = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    seenModels.push(JSON.parse(init.body).model);
    n += 1;
    const content = n === 1 ? '' : 'hola';
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const events = [];
  const out = await completeChat(fakeRing(), {
    models: ['m1'], scope: 'vacio-test', messages: [{ role: 'user', content: 'h' }],
    emit: (e) => events.push(e)
  });
  assert.equal(out.text, 'hola');
  assert.deepEqual(seenModels, ['m1', 'm1'], 'etapa 1: mismo modelo');
  assert.ok(events.some((e) => e.type === 'api_stage' && e.stage === 1), 'etapa 1 emitida');
});
