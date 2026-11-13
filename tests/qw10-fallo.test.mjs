// QW-10: fallo hablado siempre + tools idempotentes. Cero red.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  failureSpokenPhrase,
  maybeRunToolsPhase,
  setManosLoader
} from '../server/lib/agent-runtime.js';
import { runToolLoop, registerTool, toolRegistry, toolCallKey, stableJson } from '../server/lib/manos.js';
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

afterEach(() => {
  db.clear();
  setManosLoader(null);
  toolRegistry.delete('qw10_fake');
});

// ── Frases de fallo ──
test('qw10: failureSpokenPhrase ES/EN por kind', () => {
  db.set('tts.language', 'es');
  assert.ok(failureSpokenPhrase('modelo').includes('problema técnico'));
  assert.ok(failureSpokenPhrase('herramientas').includes('herramientas fallaron'));
  db.set('tts.language', 'en');
  assert.ok(failureSpokenPhrase('modelo').includes('technical problem'));
  assert.ok(failureSpokenPhrase('herramientas').includes('tools failed'));
  assert.ok(failureSpokenPhrase('inexistente').length > 10, 'kind raro → fallback modelo');
});

// ── Estabilidad de clave ──
test('qw10: toolCallKey estable al orden, sensible al valor', () => {
  assert.equal(
    toolCallKey('read_file', { path: 'a.txt', x: 1 }),
    toolCallKey('read_file', { x: 1, path: 'a.txt' })
  );
  assert.notEqual(
    toolCallKey('read_file', { path: 'a.txt' }),
    toolCallKey('read_file', { path: 'b.txt' })
  );
  assert.notEqual(
    toolCallKey('read_file', { path: 'a.txt' }),
    toolCallKey('write_file', { path: 'a.txt' })
  );
  assert.equal(stableJson({ b: [3, 1], a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1},"b":[3,1]}');
});

// ── Idempotencia en el loop ──
function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}

test('qw10: llamada repetida no re-ejecuta (devuelve anterior)', async () => {
  let runs = 0;
  registerTool({
    name: 'qw10_fake',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => { runs += 1; return { ok: true, output: `out-${runs}` }; }
  });
  const call = '```tool:qw10_fake\n{"a":1}\n```';
  const outcome = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: fakeChat([call, call, 'listo, sin más llamadas']),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 4
  });
  assert.equal(runs, 1, 'execute corrió una sola vez');
  const calls = outcome.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].repetida, true);
  assert.ok(outcome.toolSummary.includes('repetidas sin re-ejecutar'), outcome.toolSummary);
});

test('qw10: args distintos sí re-ejecutan; error repetido tampoco re-ejecuta', async () => {
  let runs = 0;
  registerTool({
    name: 'qw10_fake',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    execute: async (args) => {
      runs += 1;
      if (args.boom) return { ok: false, output: '', error: `boom-${runs}` };
      return { ok: true, output: `out-${runs}` };
    }
  });
  const c1 = '```tool:qw10_fake\n{"a":1}\n```';
  const c2 = '```tool:qw10_fake\n{"a":2}\n```';
  const cb = '```tool:qw10_fake\n{"boom":true}\n```';
  const outcome = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: fakeChat([c1, c2, cb, cb, 'fin']),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 6
  });
  assert.equal(runs, 3, 'a=1, a=2, boom×1 (segundo boom dedup)');
  assert.ok(outcome.toolSummary.includes('2 fallaron'), outcome.toolSummary);
  assert.ok(outcome.toolSummary.includes('1 repetidas sin re-ejecutar'), outcome.toolSummary);
});

// ── Conteo de fallos en la fase ──
test('qw10: maybeRunToolsPhase reporta toolFailures', async () => {
  setManosLoader(async () => ({
    shouldUseTools: () => true,
    renderManosPrompt: () => 'MANOS',
    runToolLoop: async () => ({
      toolSummary: 'Usé 2 herramienta(s):\n- a: ok — x\n- b: falló (boom) — y\n(1 fallaron)',
      toolTurns: [
        { calls: [{ tool: 'a', ok: true, ms: 1, summary: 'x' }] },
        { calls: [{ tool: 'b', ok: false, ms: 2, summary: 'y', error: 'boom' }] }
      ]
    })
  }));
  const out = await maybeRunToolsPhase({
    turn: { text: 'hola', source: 'text' },
    system: 'sys',
    userContent: 'hola',
    keyRing: { hasKeys: () => true },
    emit: () => {},
    source: 'text',
    turnId: 't',
    agentId: 'a',
    companyId: 'c1',
    slug: 's'
  });
  assert.equal(out.ran, true);
  assert.equal(out.toolFailures, 1);
});
