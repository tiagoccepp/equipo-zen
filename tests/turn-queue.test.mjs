import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TurnQueue } from '../server/lib/turn-queue.js';

test('un turno colgado hace timeout y el siguiente corre igual', async () => {
  const queue = new TurnQueue({ timeoutMs: 50, maxPending: 10 });
  const errors = [];
  const done = [];

  queue.push(() => new Promise(() => {}), (error) => errors.push(error.message));
  queue.push(async () => { done.push('segundo'); }, (error) => errors.push(error.message));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /excedió el tiempo/);
  assert.deepEqual(done, ['segundo']);
});

test('la cola rechaza cuando supera la profundidad máxima', () => {
  const queue = new TurnQueue({ timeoutMs: 1000, maxPending: 2 });
  const never = () => new Promise(() => {});
  assert.equal(queue.push(never), true);
  assert.equal(queue.push(never), true);
  assert.equal(queue.push(never), true);
  assert.equal(queue.push(never), false);
});

test('los errores de un turno no tumban la cola', async () => {
  const queue = new TurnQueue({ timeoutMs: 1000, maxPending: 10 });
  const done = [];
  queue.push(async () => { throw new Error('boom'); }, () => done.push('error-manejado'));
  queue.push(async () => { done.push('ok'); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(done, ['error-manejado', 'ok']);
});
