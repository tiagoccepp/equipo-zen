// E-05: bus peer-to-peer — send/drain + tool agent_send + prompt inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentBus, renderInboxSection } from '../server/lib/agent-bus.js';
import { getTool, runToolLoop } from '../server/lib/manos.js';

const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;
function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}

test('e05: send/drain/broadcast + validaciones', () => {
  const bus = new AgentBus();
  bus.setRoster(['a', 'b', 'c']);
  assert.deepEqual(bus.send('a', 'b', '  hola  '), { ok: true, id: 'am-1', count: 1 });
  assert.equal(bus.pending('b'), 1);
  assert.equal(bus.pending('a'), 0);
  const inbox = bus.drain('b');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, 'hola');
  assert.equal(inbox[0].from, 'a');
  assert.deepEqual(bus.drain('b'), [], 'drena una vez');
  const bc = bus.send('a', 'broadcast', 'todos');
  assert.equal(bc.count, 2, 'todos menos remitente');
  assert.equal(bus.pending('b'), 1);
  assert.equal(bus.pending('c'), 1);
  assert.equal(bus.send('a', 'a', 'yo').ok, false, 'no self');
  assert.equal(bus.send('a', 'zz', 'x').ok, false, 'destino inválido');
  assert.equal(bus.send('zz', 'a', 'x').ok, false, 'remitente inválido');
  assert.equal(bus.send('a', 'b', '   ').ok, false, 'vacío');
});

test('e05: topes inbox e historial', () => {
  const bus = new AgentBus();
  bus.setRoster(['a', 'b']);
  for (let i = 0; i < 25; i += 1) {
    bus.send('a', 'b', `m${i}`);
  }
  assert.equal(bus.pending('b'), 20, 'inbox topado');
  assert.ok(bus.recent(200).length <= 100, 'historial topado');
  const long = bus.send('a', 'b', 'x'.repeat(2000));
  assert.equal(long.ok, true);
  assert.equal(bus.drain('b').at(-1).text.length, 1000, 'texto recortado');
});

test('e05: tool agent_send por loop entrega al inbox', async () => {
  const bus = new AgentBus();
  bus.setRoster(['backend', 'tester']);
  const outcome = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'coordinen' }],
    completeChat: fakeChat([
      call('agent_send', { to: 'tester', text: '¿probaste el login?' }),
      call('agent_send', { to: 'nadie', text: 'x' }),
      'fin'
    ]),
    source: { companyId: 'c1', slug: 's' },
    agentId: 'backend',
    bus,
    maxTurns: 4
  });
  const calls = outcome.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls[0].ok, true, 'envío OK');
  assert.equal(calls[1].ok, false, 'destino inválido rechazado');
  const inbox = bus.drain('tester');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, '¿probaste el login?');
  // Sin bus: error claro.
  const r = await getTool('agent_send').execute({ to: 'x', text: 'y' }, { agentId: 'a' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('sin bus'));
});

test('e05: renderInboxSection ES/EN + vacío', () => {
  assert.equal(renderInboxSection([]), '');
  assert.equal(renderInboxSection(null), '');
  const es = renderInboxSection([{ from: 'backend', text: 'hola' }]);
  assert.ok(es.includes('MENSAJES DIRECTOS'), es);
  assert.ok(es.includes('backend → vos'), es);
  const en = renderInboxSection([{ from: 'backend', text: 'hi' }], { english: true });
  assert.ok(en.includes('DIRECT MESSAGES'), en);
});
