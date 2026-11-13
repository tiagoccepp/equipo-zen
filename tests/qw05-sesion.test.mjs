// QW-05: session ID por proyecto + costo por turno.
// - projectSessionId: UUIDv5 estable por (company, slug), distinto entre proyectos.
// - requestChat: options.sessionId overridea x-opencode-session SOLO si el
//   provider declara el header (lane opencode); jamás se agrega a otros.
// - parseUsage: cost/billing/allowance desde Go lane (stream y no-stream).
// Todo con fetch mockeado: cero red, cero cuota (V-17).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { projectSessionId } from '../server/lib/config.js';
import { completeChat, parseUsage, streamChat } from '../server/lib/llm.js';
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
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeRing(logged) {
  return {
    hasKeys: () => true,
    size: () => 1,
    acquire: () => ({ id: 'key-1' }),
    reportSuccess: () => {},
    reportFailure: () => {},
    logKey: (type, payload) => { logged.push({ type, payload }); }
  };
}

test('qw05: session estable por proyecto, distinta entre proyectos, formato UUIDv5', () => {
  const a1 = projectSessionId('c1', 'web-acme');
  const a2 = projectSessionId('c1', 'web-acme');
  const b = projectSessionId('c1', 'otro-proyecto');
  const c = projectSessionId('c2', 'web-acme');
  const g = projectSessionId(null, null);
  assert.equal(a1, a2, 'estable');
  assert.ok(UUID_RE.test(a1), `formato uuidv5 (${a1})`);
  assert.notEqual(a1, b, 'distinto por slug');
  assert.notEqual(a1, c, 'distinto por company');
  assert.ok(UUID_RE.test(g), 'fallback general también uuid');
});

test('qw05: parseUsage lee Go lane y devuelve null sin datos', () => {
  const u = parseUsage({
    usage: { total_tokens: 41, cost: 0, opencode: { billing_source: 'go', allowance: 0.00001 } }
  });
  assert.deepEqual(u, { tokens: 41, cost: 0, billing: 'go', allowance: 0.00001 });
  assert.equal(parseUsage({}), null, 'sin usage → null');
  assert.equal(parseUsage({ usage: {} }), null, 'usage vacío → null');
  assert.deepEqual(parseUsage({ cost: 0.5 }), { tokens: null, cost: 0.5, billing: null, allowance: null });
});

test('qw05: completeChat manda session override + devuelve usage + loguea', async () => {
  db.set('llm.provider', 'opencode');
  const seen = [];
  const logged = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hola' } }],
        usage: { total_tokens: 10, cost: 0, opencode: { billing_source: 'go', allowance: 7 } }
      })
    };
  };
  const sid = projectSessionId('c1', 'web-acme');
  const out = await completeChat(fakeRing(logged), {
    models: ['m1'], scope: 'test', messages: [{ role: 'user', content: 'h' }], sessionId: sid
  });
  assert.equal(seen.length, 1, 'un intento');
  assert.equal(seen[0].headers['x-opencode-session'], sid, 'header overrideado');
  assert.deepEqual(out.usage, { tokens: 10, cost: 0, billing: 'go', allowance: 7 });
  const ok = logged.find((l) => l.type === 'api_call_success');
  assert.deepEqual(ok.payload.usage, out.usage, 'usage en telemetry');
  assert.ok(!('stream_options' in seen[0].body), 'no-stream sin stream_options');
});

test('qw05: streamChat manda stream_options + captura usage final', async () => {
  db.set('llm.provider', 'opencode');
  const seen = [];
  const logged = [];
  const sse = [
    'data: {"choices":[{"delta":{"content":"ho"}}]}',
    'data: {"choices":[{"delta":{"content":"la"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":10,"cost":0,"opencode":{"billing_source":"go","allowance":7}}}',
    'data: [DONE]'
  ].join('\n\n');
  globalThis.fetch = async (url, init) => {
    seen.push({ body: JSON.parse(init.body), sid: init.headers['x-opencode-session'] });
    return new Response(sse, { status: 200 });
  };
  const sid = projectSessionId('c9', 's9');
  const deltas = [];
  const out = await streamChat(fakeRing(logged), {
    models: ['m1'], scope: 'test', messages: [{ role: 'user', content: 'h' }], sessionId: sid
  }, (d) => deltas.push(d));
  assert.deepEqual(seen[0].body.stream_options, { include_usage: true });
  assert.equal(seen[0].sid, sid, 'header en stream');
  assert.equal(out.text, 'hola');
  assert.deepEqual(out.usage, { tokens: 10, cost: 0, billing: 'go', allowance: 7 });
});

test('qw05: provider sin header (minimax) jamás recibe x-opencode-session', async () => {
  db.set('llm.provider', 'minimax');
  let headers = null;
  globalThis.fetch = async (url, init) => {
    headers = init.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'h' } }] }) };
  };
  await completeChat(fakeRing([]), {
    models: ['m1'], scope: 'test', messages: [{ role: 'user', content: 'h' }],
    sessionId: projectSessionId('c1', 'x')
  });
  assert.ok(!('x-opencode-session' in headers), 'sin header extra');
});
