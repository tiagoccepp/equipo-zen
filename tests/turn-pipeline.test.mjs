import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CancellableTurnQueue, SpeakerGate } from '../server/lib/turn-pipeline.js';

test('interrupt aborta el turno en curso y descarta los pendientes', async () => {
  const cancelled = [];
  const queue = new CancellableTurnQueue({ timeoutMs: 5000, onCancelled: (id, reason) => cancelled.push({ id, reason }) });
  const done = [];

  queue.push('t1', (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve());
  }));
  queue.push('t2', async () => { done.push('t2'); });

  await new Promise((r) => setTimeout(r, 20));
  queue.interrupt('barge_in');
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(cancelled.map((c) => c.id).sort(), ['t1', 't2']);
  assert.deepEqual(done, []);

  queue.push('t3', async () => { done.push('t3'); });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(done, ['t3'], 'la cola sigue viva después del interrupt');
});

test('un turno colgado hace timeout y el siguiente corre', async () => {
  const errors = [];
  const queue = new CancellableTurnQueue({ timeoutMs: 50 });
  const done = [];
  queue.push('t1', () => new Promise(() => {}), (error) => errors.push(error.message));
  queue.push('t2', async () => { done.push('t2'); });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(errors.length, 1);
  assert.deepEqual(done, ['t2']);
});

test('SpeakerGate: un solo dueño, orden FIFO y flush por barge-in', async () => {
  const emitted = [];
  const gate = new SpeakerGate({ emit: (e) => emitted.push(e), ackGraceMs: 50 });

  const tokenA = await gate.acquire('t1', 'julio', { sampleRate: 24000 });
  assert.ok(gate.sendChunk(tokenA, 'QUJDRA==', 'audio/pcm;rate=24000'));

  let bGranted = false;
  const acquireB = gate.acquire('t1', 'tomasa').then((token) => { bGranted = true; return token; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bGranted, false, 'B espera mientras A es dueño');

  gate.finish(tokenA, 'complete');
  gate.onPlaybackComplete('t1', 'julio');
  const tokenB = await acquireB;
  assert.equal(bGranted, true);
  assert.ok(gate.sendChunk(tokenB, 'QUJDRA=='));

  gate.flush();
  const types = emitted.map((e) => e.type);
  assert.ok(types.includes('agent_audio_start'));
  assert.ok(types.includes('agent_audio_end'));
  const ends = emitted.filter((e) => e.type === 'agent_audio_end');
  assert.equal(ends.at(-1).reason, 'interrupted');
});

test('SpeakerGate: chunks de un token no-dueño se descartan', async () => {
  const emitted = [];
  const gate = new SpeakerGate({ emit: (e) => emitted.push(e) });
  const token = await gate.acquire('t1', 'julio');
  gate.flush();
  assert.equal(gate.sendChunk(token, 'QUJDRA=='), false);
});
