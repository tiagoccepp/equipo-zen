// QW-09: earcon "trabajando" — timing (arm/cancel/cooldown) con timers falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkingEarcon, WORKING_EARCON_DELAY_MS, WORKING_EARCON_COOLDOWN_MS } from '../src/lib/working-earcon.ts';

function harness() {
  let nowMs = 100000;
  const timers = new Map();
  let nextId = 1;
  const played = [];
  const earcon = new WorkingEarcon(
    (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: nowMs + ms }); return id; },
    (h) => { timers.delete(h); },
    (agentId) => { played.push(agentId); },
    () => nowMs
  );
  const advance = (ms) => {
    nowMs += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= nowMs) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { earcon, played, advance, timers, getNow: () => nowMs };
}

test('qw09: suena tras ~1s de silencio', () => {
  const { earcon, played, advance } = harness();
  assert.equal(WORKING_EARCON_DELAY_MS, 1000);
  earcon.arm('ivan');
  advance(999);
  assert.deepEqual(played, [], 'antes del delay: nada');
  advance(1);
  assert.deepEqual(played, ['ivan']);
});

test('qw09: cancel evita el sonido', () => {
  const { earcon, played, advance } = harness();
  earcon.arm('ivan');
  advance(500);
  earcon.cancel('ivan');
  advance(2000);
  assert.deepEqual(played, []);
  assert.equal(earcon.armedCount, 0);
});

test('qw09: arm doble no duplica; cooldown de 8s entre earcons', () => {
  assert.equal(WORKING_EARCON_COOLDOWN_MS, 8000);
  const { earcon, played, advance } = harness();
  earcon.arm('ivan');
  earcon.arm('ivan');
  assert.equal(earcon.armedCount, 1);
  advance(1000);
  assert.deepEqual(played, ['ivan']);
  earcon.arm('ivan');
  advance(1000);
  assert.deepEqual(played, ['ivan'], 'dentro del cooldown: no repite');
  advance(7000);
  earcon.arm('ivan');
  advance(1000);
  assert.deepEqual(played, ['ivan', 'ivan'], 'tras cooldown: sí');
});

test('qw09: por agente independiente + cancel global', () => {
  const { earcon, played, advance } = harness();
  earcon.arm('ivan');
  earcon.arm('pablo');
  earcon.cancel();
  advance(2000);
  assert.deepEqual(played, []);
  earcon.arm('ivan');
  advance(1000);
  assert.deepEqual(played, ['ivan']);
});
