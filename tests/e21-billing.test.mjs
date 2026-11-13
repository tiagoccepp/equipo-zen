// E-21: seams de facturación — entitlements default-allow + ledger real.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetBilling,
  accountPlan,
  checkEntitlement,
  emitUsage,
  setEntitlementPolicy,
  setUsageSink
} from '../server/lib/billing.js';
import { completeChat } from '../server/lib/llm.js';
import { Store } from '../server/lib/store.js';
import { initSettings } from '../server/lib/settings.js';

const db = new Map();
initSettings(
  { getSetting: (k) => (db.has(k) ? db.get(k) : null), setSetting: (k, v) => { db.set(k, v); }, deleteSetting: (k) => { db.delete(k); }, logChange: () => {} },
  { setKeys: () => {} }
);
const realFetch = globalThis.fetch;
afterEach(() => {
  db.clear();
  globalThis.fetch = realFetch;
  __resetBilling();
  delete process.env.OPENCODE_API_KEY;
});

function ring() {
  return {
    hasKeys: () => true, size: () => 1,
    acquire: () => ({ id: 'key-1' }),
    reportSuccess: () => {}, reportFailure: () => {}, logKey: () => {}
  };
}

test('e21: default allow-all + policy futura + planes', () => {
  assert.equal(checkEntitlement('cualquier-cosa').ok, true, 'hoy todo pasa');
  assert.equal(accountPlan(), 'personal');
  assert.equal(accountPlan(() => 'enterprise'), 'enterprise');
  assert.equal(accountPlan(() => 'invento'), 'personal');
  setEntitlementPolicy((feature) => feature === 'x' ? { ok: false, reason: 'plan' } : null);
  assert.equal(checkEntitlement('x').ok, false, 'policy manda');
  assert.equal(checkEntitlement('y').ok, true, 'null → default');
  setEntitlementPolicy(() => { throw new Error('boom'); });
  assert.equal(checkEntitlement('x').ok, true, 'policy caída fail-open');
});

test('e21: llamada LLM real (falsa) alimenta el ledger', async () => {
  db.set('llm.provider', 'opencode');
  const store = new Store(':memory:');
  setUsageSink((u) => store.recordUsage(u));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'hola' } }],
      usage: { total_tokens: 41, cost: 0.0002, opencode: { billing_source: 'go', allowance: 5 } }
    })
  });
  await completeChat(ring(), { models: ['m1'], scope: 'e21', messages: [{ role: 'user', content: 'h' }], noFailover: true });
  const s = store.usageSummary({});
  assert.equal(s.calls, 1);
  assert.equal(s.tokens, 41);
  assert.equal(s.cost, 0.0002);
  const rows = store._prepare('SELECT * FROM usage_ledger').all();
  assert.equal(rows[0].account_id, 'local');
  assert.equal(rows[0].scope, 'e21');
  store.close();
});

test('e21: sin sink no rompe; summary vacío ceros', async () => {
  db.set('llm.provider', 'opencode');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'h' } }] }) });
  const out = await completeChat(ring(), { models: ['m1'], scope: 'e21b', messages: [{ role: 'user', content: 'h' }], noFailover: true });
  assert.equal(out.text, 'h', 'sin sink anda igual');
  const store = new Store(':memory:');
  assert.deepEqual(store.usageSummary({}), { calls: 0, tokens: 0, cost: 0 });
  store.close();
});
