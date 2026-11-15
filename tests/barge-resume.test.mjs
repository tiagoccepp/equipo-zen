import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBargeResumeBuffer,
  decideResumeAction,
  replayPayloads
} from '../src/lib/barge-resume.ts';

function seg(id, payload = id, tag = undefined) {
  return tag === undefined ? { id, payload } : { id, payload, tag };
}

test('idle buffer: nothing pending, interrupt/resume/cancel are safe', () => {
  const b = createBargeResumeBuffer();
  assert.equal(b.turnId, null);
  assert.equal(b.phase, 'idle');
  assert.equal(b.hasPending(), false);
  assert.equal(b.isFullySpoken(), false);

  const intr = b.interrupt();
  assert.equal(intr.canResume, false);
  assert.deepEqual(intr.pending, []);
  assert.equal(intr.interruptedSegment, null);

  const res = b.resume();
  assert.equal(res.resumed, false);
  assert.deepEqual(res.segments, []);
  assert.equal(res.phase, 'idle');

  b.cancel();
  b.reset();
  assert.equal(b.phase, 'idle');
  assert.deepEqual(b.getSegments(), []);
});

test('tracks spoken vs pending segments for a turn', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', { audio: 1 }, 'tag1'));
  b.enqueue(seg('s2', { audio: 2 }, 'tag2'));
  b.enqueue(seg('s3', { audio: 3 }, 'tag3'));

  assert.equal(b.turnId, 't1');
  assert.equal(b.phase, 'playing');
  assert.equal(b.hasPending(), true);
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s1', 's2', 's3']);

  b.markStarted('s1');
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(b.getSegments().map((s) => [s.id, s.status]), [
    ['s1', 'started'],
    ['s2', 'pending'],
    ['s3', 'pending']
  ]);

  // markStarted also resolves by tag
  b.markStarted('tag2');
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s3']);
  assert.equal(b.isFullySpoken(), false);

  b.markStarted('s3');
  assert.equal(b.hasPending(), false);
  assert.equal(b.isFullySpoken(), true);
});

test('interrupt pauses and retains remainder; resume continues from next pending segment', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  b.enqueue(seg('s3', 'p3'));
  b.markStarted('s1'); // s1 started/cut on flush, should not be replayed

  const intr = b.interrupt();
  assert.equal(intr.canResume, true);
  assert.equal(intr.phase, 'interrupted');
  assert.equal(intr.interruptedSegment?.id, 's1');
  assert.deepEqual(intr.pending.map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s2', 's3'], 'remainder retained');

  const res = b.resume();
  assert.equal(res.resumed, true);
  assert.equal(res.phase, 'playing');
  assert.deepEqual(res.segments.map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(replayPayloads(res.segments), ['p2', 'p3']);
  // Still tracked as pending until re-enqueue path marks them started again.
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s2', 's3']);

  b.markStarted('s2');
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s3']);
});

test('cancel on real interrupt/new turn drops retained remainder', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  b.markStarted('s1');
  const intr = b.interrupt();
  assert.equal(intr.canResume, true);

  b.cancel();
  assert.equal(b.phase, 'cancelled');
  assert.equal(b.hasPending(), false);
  assert.deepEqual(b.getSegments(), []);
  assert.equal(b.resume().resumed, false);
  assert.equal(b.enqueue(seg('s3', 'p3')), null, 'stale enqueue ignored until new turn');

  b.beginTurn('t2');
  assert.equal(b.phase, 'playing');
  const enq = b.enqueue(seg('n1', 'np1'));
  assert.equal(enq?.id, 'n1');
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['n1']);
});

test('nothing pending: interrupt/resume behave safely', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  const intr = b.interrupt();
  assert.equal(intr.canResume, false);
  assert.deepEqual(intr.pending, []);
  assert.equal(intr.interruptedSegment, null);

  const res = b.resume();
  assert.equal(res.resumed, false);
  assert.deepEqual(res.segments, []);
});

test('fully spoken: no pending to resume', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  b.markStarted('s1');
  b.markStarted('s2');
  assert.equal(b.isFullySpoken(), true);

  const intr = b.interrupt();
  assert.equal(intr.canResume, false);
  assert.deepEqual(intr.pending, []);
  assert.equal(intr.interruptedSegment?.id, 's2');

  const res = b.resume();
  assert.equal(res.resumed, false);
  assert.deepEqual(res.segments, []);
});

test('interrupt before any segment starts retains full queue', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  const intr = b.interrupt();
  assert.equal(intr.canResume, true);
  assert.equal(intr.interruptedSegment, null);
  assert.deepEqual(intr.pending.map((s) => s.id), ['s1', 's2']);
  const res = b.resume();
  assert.equal(res.resumed, true);
  assert.deepEqual(res.segments.map((s) => s.id), ['s1', 's2']);
});

test('rapid toggles: interrupt/resume cycles keep correct remainder', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  b.enqueue(seg('s3', 'p3'));

  b.markStarted('s1');
  let intr = b.interrupt();
  assert.deepEqual(intr.pending.map((s) => s.id), ['s2', 's3']);
  let res = b.resume();
  assert.equal(res.resumed, true);
  assert.deepEqual(res.segments.map((s) => s.id), ['s2', 's3']);

  // interrupted again before any re-enqueued segment started: same remainder
  intr = b.interrupt();
  assert.deepEqual(intr.pending.map((s) => s.id), ['s2', 's3']);
  res = b.resume();
  assert.equal(res.resumed, true);
  assert.deepEqual(res.segments.map((s) => s.id), ['s2', 's3']);

  // now s2 starts, interrupt again -> only s3 remains
  b.markStarted('s2');
  intr = b.interrupt();
  assert.equal(intr.interruptedSegment?.id, 's2');
  assert.deepEqual(intr.pending.map((s) => s.id), ['s3']);
  res = b.resume();
  assert.deepEqual(res.segments.map((s) => s.id), ['s3']);

  b.markStarted('s3');
  intr = b.interrupt();
  assert.equal(intr.canResume, false);
  assert.equal(resumePayloadsSafe(b), false);
});

function resumePayloadsSafe(b) {
  return b.resume().resumed;
}

test('resume when not interrupted is a no-op', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  const res = b.resume();
  assert.equal(res.resumed, false);
  assert.deepEqual(res.segments, []);
  assert.equal(b.phase, 'playing');
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['s1']);
});

test('beginTurn drops previous turn state', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1'));
  b.enqueue(seg('s2', 'p2'));
  b.markStarted('s1');
  b.interrupt();

  b.beginTurn('t2');
  assert.equal(b.turnId, 't2');
  assert.equal(b.phase, 'playing');
  assert.deepEqual(b.getSegments(), []);
  assert.equal(b.hasPending(), false);
  b.enqueue(seg('n1', 'x'));
  assert.deepEqual(b.getPendingSegments().map((s) => s.id), ['n1']);
});

test('markStarted unknown id/tag returns null and keeps state', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', 'p1', 'tag1'));
  assert.equal(b.markStarted('missing'), null);
  assert.equal(b.markStarted(null), null);
  assert.deepEqual(b.getSegments().map((s) => s.status), ['pending']);
  assert.equal(b.markStarted('tag1')?.id, 's1');
  assert.equal(b.markStarted('s1')?.status, 'started', 'idempotent mark');
});

test('enqueue without active turn returns null', () => {
  const b = createBargeResumeBuffer();
  assert.equal(b.enqueue(seg('s1', 'p1')), null);
  assert.deepEqual(b.getSegments(), []);
});

test('snapshot and getters return copies (no external mutation)', () => {
  const b = createBargeResumeBuffer();
  b.beginTurn('t1');
  b.enqueue(seg('s1', { nested: 1 }));
  const snap = b.snapshot();
  snap.segments[0].id = 'mutated';
  snap.segments[0].payload.nested = 99;
  assert.equal(b.getSegments()[0].id, 's1');
  assert.equal(b.getSegments()[0].payload.nested, 99, 'payload is caller-owned (not deep-cloned)');

  const listed = b.getSegments();
  listed[0].status = 'started';
  assert.equal(b.getSegments()[0].status, 'pending');
});

test('decideResumeAction helper', () => {
  assert.equal(decideResumeAction(true, true), 'resume');
  assert.equal(decideResumeAction(true, false), 'drop');
  assert.equal(decideResumeAction(false, true), 'drop');
  assert.equal(decideResumeAction(false, false), 'drop');
});
