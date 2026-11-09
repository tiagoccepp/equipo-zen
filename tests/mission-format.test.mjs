import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultNode,
  esc,
  fmtMs,
  fmtVol,
  parseSopSummary,
  pickCompany,
  pillClass,
  summarizeTasks,
  timeAgo,
  uptimeSince
} from '../src/mission/format.ts';

test('fmtMs formatea ms/s y degrada a —', () => {
  assert.equal(fmtMs(850), '850 ms');
  assert.equal(fmtMs(1500), '1.5 s');
  assert.equal(fmtMs(12000), '12 s');
  assert.equal(fmtMs(null), '—');
  assert.equal(fmtMs(undefined), '—');
  assert.equal(fmtMs('x'), '—');
  assert.equal(fmtMs(-5), '—');
});

test('timeAgo degrada con fechas inválidas', () => {
  const now = new Date('2026-11-09T12:00:00Z').getTime();
  assert.equal(timeAgo(null, now), '—');
  assert.equal(timeAgo('no-fecha', now), '—');
  assert.equal(timeAgo('2026-11-09T11:57:00Z', now), 'hace 3 min');
  assert.equal(timeAgo('2026-11-09T10:00:00Z', now), 'hace 2 h');
  assert.equal(timeAgo('2026-11-09T11:59:50Z', now), 'ahora');
});

test('pillClass mapea estados conocidos', () => {
  assert.equal(pillClass('up'), 'ok');
  assert.equal(pillClass('done'), 'ok');
  assert.equal(pillClass('down'), 'bad');
  assert.equal(pillClass('blocked'), 'bad');
  assert.equal(pillClass('unknown'), 'mute');
  assert.equal(pillClass('pending'), 'mute');
  assert.equal(pillClass('in_progress'), 'warn');
  assert.equal(pillClass(null), 'mute');
});

test('uptimeSince calcula edad o degrada', () => {
  const now = new Date('2026-11-09T12:00:00Z').getTime();
  assert.equal(uptimeSince(null, now), '—');
  assert.equal(uptimeSince('2026-11-09T11:30:00Z', now), 'up 30 min');
  assert.equal(uptimeSince('2026-11-09T09:00:00Z', now), 'up 3 h');
});

test('summarizeTasks cuenta por estado', () => {
  const sum = summarizeTasks([
    { status: 'done' },
    { status: 'in_progress' },
    { status: 'blocked' },
    { status: 'pending' },
    { status: 'rara' }
  ]);
  assert.deepEqual(sum, { total: 5, done: 1, active: 1, blocked: 1, pending: 2 });
});

test('pickCompany prefiere Pablo/Sofia', () => {
  assert.equal(pickCompany([]), null);
  assert.equal(pickCompany([{ id: 'a', name: 'X' }]).id, 'a');
  const list = [
    { id: 'a', name: 'X' },
    { id: 'b', name: 'Pablo' }
  ];
  assert.equal(pickCompany(list).id, 'b');
});

test('parseSopSummary extrae reglas y knobs', () => {
  const sop = [
    'S1 una sola voz.',
    'S2 gate antes de sala.',
    'order: score-desc',
    'max_rounds: 2',
    'agent_timeout_ms: 20000',
    'r2: on-disagreement'
  ].join('\n');
  const s = parseSopSummary(sop);
  assert.equal(s.rules, 2);
  assert.equal(s.order, 'score-desc');
  assert.equal(s.maxRounds, 2);
  assert.equal(s.agentTimeoutMs, 20000);
  assert.equal(s.r2, 'on-disagreement');
  assert.equal(s.firstRules.length, 2);
  const empty = parseSopSummary(null);
  assert.equal(empty.rules, 0);
  assert.equal(empty.order, null);
});

test('esc neutraliza HTML', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc(null), '');
});

test('fmtVol formatea 0..1 a %', () => {
  assert.equal(fmtVol(0.73), '73%');
  assert.equal(fmtVol(1), '100%');
  assert.equal(fmtVol(0), '0%');
  assert.equal(fmtVol(null), '—');
  assert.equal(fmtVol('x'), '—');
});

test('defaultNode prefiere isDefault', () => {
  assert.equal(defaultNode([]), null);
  const nodes = [
    { name: 'a', isDefault: false },
    { name: 'b', isDefault: true }
  ];
  assert.equal(defaultNode(nodes).name, 'b');
  assert.equal(defaultNode([{ name: 'solo' }]).name, 'solo');
});
