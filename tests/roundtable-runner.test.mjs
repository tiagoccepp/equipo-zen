import test from 'node:test';
import assert from 'node:assert/strict';
import { runRoundtableWithChat } from '../server/lib/roundtable-runner.js';

const AGENTS = [
  { id: 'pablo', name: 'Pablo', role: 'producto' },
  { id: 'ivan', name: 'Iván', role: 'técnico' },
  { id: 'sofia', name: 'Sofía', role: 'diseño' }
];

function scriptedChat(replies) {
  let i = 0;
  const calls = [];
  const callChat = async ({ system, user }) => {
    calls.push({ system, user });
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? { text: r } : r;
  };
  return { callChat, calls };
}

test('runner: produce transcript, roles y resumen', async () => {
  const { callChat, calls } = scriptedChat([
    { text: 'Empezaría midiendo la latencia real.' },
    { text: 'Necesitamos trazas por turno antes de optimizar.' },
    { text: 'Y que el usuario sienta que responde rápido.' },
    { text: 'Cierro: medir, trazar, ajustar.', done: true }
  ]);

  const out = await runRoundtableWithChat({
    topic: 'Cómo bajar la latencia percibida',
    agents: AGENTS,
    maxTurns: 6,
    callChat
  });

  assert.equal(out.topic, 'Cómo bajar la latencia percibida');
  assert.equal(out.transcript.length, 4);
  assert.equal(out.transcript[0].name, 'Pablo');
  assert.equal(out.transcript[0].role, 'producto');
  assert.equal(out.transcript[3].text, 'Cierro: medir, trazar, ajustar.');
  assert.equal(out.stopped.reason, 'done');
  assert.equal(out.errors.length, 0);
  assert.ok(out.summary.includes('Mesa redonda'));
  assert.ok(out.summary.includes('Conclusión'));

  // El prompt de cada turno incluye identidad, rol y tema.
  assert.ok(calls.length >= 3);
  assert.ok(calls[0].system.includes('Pablo'));
  assert.ok(calls[0].system.includes('producto'));
  assert.ok(calls[0].user.includes('Cómo bajar la latencia percibida'));
});

test('runner: respeta maxTurns y no explota si el modelo repite', async () => {
  const { callChat } = scriptedChat([{ text: 'Mismo texto' }]);
  const out = await runRoundtableWithChat({
    topic: 'tema',
    agents: AGENTS,
    maxTurns: 4,
    callChat
  });
  assert.ok(out.transcript.length >= 1);
  assert.ok(out.stopped.reason === 'max_turns' || out.stopped.reason === 'skipped');
  assert.ok(out.transcript.length <= 4);
});

test('runner: tolera errores del proveedor sin romper la mesa', async () => {
  const { callChat } = scriptedChat([
    new Error('boom'),
    { text: 'Sigo con la idea.' },
    { text: 'Aporto desde diseño.' }
  ]);
  const out = await runRoundtableWithChat({
    topic: 'tema',
    agents: AGENTS,
    maxTurns: 6,
    callChat
  });
  assert.ok(out.errors.length >= 1);
  assert.equal(out.errors[0].message, 'boom');
  assert.ok(out.transcript.length >= 1);
});

test('runner: normaliza texto vacío a skip', async () => {
  const { callChat } = scriptedChat([{ text: '   ' }, { text: 'Algo útil.' }]);
  const out = await runRoundtableWithChat({
    topic: 'tema',
    agents: AGENTS,
    maxTurns: 3,
    callChat
  });
  assert.ok(out.transcript.every((t) => t.text.trim().length > 0));
});

test('runner: rechaza configuración inválida', async () => {
  await assert.rejects(
    () => runRoundtableWithChat({ topic: '', agents: AGENTS, callChat: async () => ({ text: 'x' }) }),
    (err) => err.code === 'ROUNDTABLE_CONFIG'
  );
});
