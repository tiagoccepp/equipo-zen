// F-06: hooks — registro, pre/post en loop, secrets-guard, notification.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetHooks,
  listHooks,
  looksLikeSecret,
  registerBuiltinHooks,
  registerHook,
  runHooks,
  unregisterHook
} from '../server/lib/hooks.js';
import { runToolLoop } from '../server/lib/manos.js';

afterEach(() => { __resetHooks(); });

const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;
function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}

test('f06: registro + run ordenado + errores aislados + timeout', async () => {
  const order = [];
  const id1 = registerHook('preToolUse', () => { order.push(1); return 'uno'; }, { name: 'h1' });
  registerHook('preToolUse', () => { order.push(2); throw new Error('boom'); }, { name: 'h2' });
  registerHook('preToolUse', async () => { order.push(3); await new Promise((r) => setTimeout(r, 50)); return 'tres'; }, { name: 'h3', timeoutMs: 10 });
  const r = await runHooks('preToolUse', { tool: 'x' });
  assert.deepEqual(order, [1, 2, 3], 'todos corren en orden');
  assert.equal(r.results.length, 1, 'solo h1 devolvió');
  assert.equal(r.results[0].value, 'uno');
  assert.equal(r.errors.length, 2, 'throw + timeout aislados');
  assert.ok(r.errors.some((e) => e.error.includes('timeout')), 'timeout reportado');
  assert.equal(unregisterHook(id1), true);
  assert.equal(listHooks('preToolUse').length, 2);
  assert.throws(() => registerHook('invento', () => {}), /desconocido/);
});

test('f06: pre-hook bloquea y modifica args en el loop', async () => {
  registerHook('preToolUse', ({ tool }) => {
    if (tool === 'run_cmd') return { block: true, reason: 'shell vedada en este turno' };
  });
  registerHook('preToolUse', ({ tool, args }) => {
    if (tool === 'now') return { args: { ...args, extra: '1' } };
  });
  const out = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: fakeChat([call('run_cmd', { cmd: 'ls' }), call('now', {}), 'fin']),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 4
  });
  const calls = out.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, false);
  assert.ok(calls[0].error.includes('vedada'), calls[0].error);
  assert.equal(calls[1].ok, true, 'now con args modificados ejecuta');
});

test('f06: post-hook anexa nota a la observación', async () => {
  registerHook('postToolUse', ({ tool }) => ({ note: `${tool} auditado` }));
  const out = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: fakeChat([call('now', {}), 'fin']),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 3
  });
  assert.ok(out.toolSummary.includes('now: ok'), out.toolSummary);
});

test('f06: secrets-guard bloquea claves, deja pasar lo normal', async () => {
  registerBuiltinHooks();
  assert.equal(looksLikeSecret({ cmd: 'echo hola' }), false);
  assert.equal(looksLikeSecret({ text: 'mi password es hunter2' }), true);
  assert.equal(looksLikeSecret('sk-abcdefgh12345678'), true);
  assert.equal(looksLikeSecret('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(looksLikeSecret('ghp_abc123XYZ456'), true);
  assert.equal(looksLikeSecret('xoxb-1234-abcdef'), true);
  assert.equal(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  const out = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: fakeChat([call('write_file', { path: 'k.txt', content: 'api_key=sk-abcdefgh12345678' }), 'fin']),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 3
  });
  const calls = out.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, false);
  assert.ok(calls[0].error.includes('secreto'), calls[0].error);
});

test('f06: notification hooks transforman/suprimen', async () => {
  registerHook('notification', ({ text }) => ({ text: `${text}!!` }));
  const r1 = await runHooks('notification', { text: 'hola' });
  assert.equal(r1.results[0].value.text, 'hola!!');
  registerHook('notification', () => ({ suppress: true }));
  const r2 = await runHooks('notification', { text: 'hola' });
  assert.ok(r2.results.some((x) => x.value.suppress), 'suprime');
});
