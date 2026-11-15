import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitSentences,
  planSentenceChunks,
  createTurnCancellation,
  createProgressiveQueue
} from '../server/lib/tts-stream.js';

test('splitSentences: splits basic sentences in order', () => {
  const parts = splitSentences('Hola. ¿Cómo estás? Todo bien!');
  assert.deepEqual(parts, ['Hola.', '¿Cómo estás?', 'Todo bien!']);
});

test('splitSentences: keeps short fragments together and trims', () => {
  const parts = splitSentences('Hi. Ok. This is a full sentence with enough length.');
  assert.ok(parts.length >= 1);
  assert.equal(parts.join(' ').includes('This is a full sentence'), true);
});

test('splitSentences: does not split common abbreviations and decimals', () => {
  const parts = splitSentences('El Sr. Pérez llegó a las 3.5 horas. Después habló.');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /Sr\. Pérez/);
  assert.match(parts[0], /3\.5/);
});

test('splitSentences: falls back to length-based chunking for long text', () => {
  const text = 'palabra '.repeat(80).trim() + '.';
  const parts = splitSentences(text, { maxChars: 60, minChars: 10 });
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 70, `chunk too long: ${p.length}`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').includes('palabra'), true);
});

test('planSentenceChunks: returns ordered descriptors', () => {
  const plan = planSentenceChunks('Uno. Dos. Tres.');
  assert.equal(plan.length >= 2, true);
  assert.deepEqual(plan.map((p) => p.index), plan.map((_, i) => i));
  assert.equal(plan[0].first, true);
  assert.equal(plan[plan.length - 1].last, true);
  for (const p of plan) assert.equal(p.total, plan.length);
});

test('turn cancellation: cancel by turnId and generation', async () => {
  const c = createTurnCancellation();
  const g1 = c.start('t1');
  assert.equal(c.generation('t1'), g1);
  assert.equal(c.isCancelled('t1', g1), false);
  c.cancel('t1', g1);
  assert.equal(c.isCancelled('t1', g1), true);
  const g2 = c.start('t1');
  assert.equal(g2 > g1, true);
  assert.equal(c.isCancelled('t1', g1), true, 'old generation superseded');
  assert.equal(c.isCancelled('t1', g2), false);
  c.cancel('t1'); // cancel current
  assert.equal(c.isCancelled('t1', g2), true);
});

test('progressive queue: runs in order and respects cancellation', async () => {
  const c = createTurnCancellation();
  c.start('t');
  const seen = [];
  const q = createProgressiveQueue({
    worker: async (item) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item.text);
      return item.text;
    },
    isCancelled: (item) => c.isCancelled(item.turnId, item.generation)
  });
  const g = c.generation('t');
  q.push({ text: 'a', turnId: 't', generation: g });
  q.push({ text: 'b', turnId: 't', generation: g });
  // cancel before third runs
  q.push({ text: 'c', turnId: 't', generation: g });
  c.cancel('t', g);
  q.clearPending((item) => c.isCancelled(item.turnId, item.generation));
  await q.drain();
  // 'a' may or may not have started before cancel; 'c' must not appear
  assert.equal(seen.includes('c'), false);
});

test('progressive queue: drain resolves when empty', async () => {
  const q = createProgressiveQueue({ worker: async (x) => x });
  q.push(1);
  q.push(2);
  await q.drain();
  assert.deepEqual(q.stats().queued, 0);
  assert.equal(q.stats().active, 0);
});


test('splitSentences: returns empty for empty/whitespace input', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   \n  '), []);
});

test('splitSentences: single chunk without sentence punctuation stays intact', () => {
  const parts = splitSentences('hello there this has no ending punctuation');
  assert.equal(parts.length, 1);
  assert.match(parts[0], /hello there/);
});

test('turn cancellation: clear removes tracking for turn', () => {
  const c = createTurnCancellation();
  c.start('turn-x');
  c.cancel('turn-x');
  assert.equal(c.isCancelled('turn-x'), true);
  c.clear('turn-x');
  assert.equal(c.isCancelled('turn-x'), false);
  assert.equal(c.generation('turn-x'), 0);
});

test('progressive queue: clearPending(predicate) drops only matching items', async () => {
  const seen = [];
  const q = createProgressiveQueue({
    worker: async (item) => {
      await new Promise((r) => setTimeout(r, 2));
      seen.push(item.id);
      return item.id;
    }
  });
  // First item will start quickly; queue others then clear matching pending.
  q.push({ id: 'a', turnId: 't1' });
  q.push({ id: 'b', turnId: 't1' });
  q.push({ id: 'c', turnId: 't2' });
  q.clearPending((item) => item.turnId === 't1');
  await q.drain();
  assert.equal(seen.includes('c'), true);
  assert.equal(seen.includes('b'), false);
});
