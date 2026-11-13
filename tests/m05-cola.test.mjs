// M-05: cola steer + turnId de cliente. Cola real con jobs falsos, cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CancellableTurnQueue } from '../server/lib/turn-pipeline.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('m05: steer interrumpe lo actual y va al frente', async () => {
  const order = [];
  const cancelled = [];
  const q = new CancellableTurnQueue({ timeoutMs: 5000, maxPending: 10, onCancelled: (id, reason) => cancelled.push([id, reason]) });
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  q.push('first', async (signal) => {
    order.push('first-start');
    await gate;
    if (!signal.aborted) order.push('first-end');
  });
  await tick();
  q.push('second', async () => { order.push('second'); });
  q.steer('steered', async () => { order.push('steered'); });
  releaseFirst();
  await tick(50);
  assert.deepEqual(order, ['first-start', 'steered'], 'steer ejecuta y descarta cola vieja');
  assert.ok(cancelled.some(([id, r]) => id === 'first' && r === 'steered'), 'actual cancelado como steered');
  assert.ok(cancelled.some(([id, r]) => id === 'second' && r === 'superseded'), 'pendiente viejo descartado');
});

test('m05: steer respeta tope + interrumpe pendientes como superseded', async () => {
  const cancelled = [];
  const q = new CancellableTurnQueue({ timeoutMs: 5000, maxPending: 1, onCancelled: (id, reason) => cancelled.push([id, reason]) });
  let release;
  const gate = new Promise((r) => { release = r; });
  q.push('a', async () => { await gate; });
  await tick();
  assert.equal(q.push('b', async () => {}), true);
  assert.equal(q.push('c', async () => {}), false, 'tope');
  assert.equal(q.steer('s', async () => {}), true, 'steer limpia y entra');
  assert.ok(cancelled.some(([id, r]) => id === 'b' && r === 'superseded'), 'pendiente marcado superseded');
  release();
  await tick(50);
});

test('m05: push orden FIFO intacto (sin regresión)', async () => {
  const order = [];
  const q = new CancellableTurnQueue({ timeoutMs: 5000 });
  q.push('1', async () => { order.push(1); });
  q.push('2', async () => { order.push(2); });
  q.push('3', async () => { order.push(3); });
  await tick(50);
  assert.deepEqual(order, [1, 2, 3]);
});
