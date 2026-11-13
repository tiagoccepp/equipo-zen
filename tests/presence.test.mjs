import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSignals, formatSinceLabel, summarize } from '../src/presence/signals.ts';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');

function baseSnapshot(overrides = {}) {
  return {
    now: NOW,
    fetchedAt: NOW,
    latencyMs: 120,
    live: { live: [] },
    work: { team: [], goals: [], runs: [] },
    jobs: [],
    approvals: [],
    connectivity: { status: 'online', checks: [] },
    sidecars: [],
    ...overrides
  };
}

test('detectSignals: empty snapshot is calm', () => {
  const signals = detectSignals(baseSnapshot());
  assert.deepEqual(signals, []);
});

test('detectSignals: rules for blockers, health, drift, attention, and done', () => {
  const snapshot = baseSnapshot({
    jobs: [
      { id: 'j1', estado: 'failed', brief: { objetivo: 'Build report' }, motivo: 'timeout' },
      { id: 'j2', estado: 'completed', summary: { objetivo: 'Sync docs' }, completedAt: NOW - 5 * 60 * 1000 }
    ],
    approvals: [{ id: 'a1', status: 'pending', title: 'Deploy release' }],
    work: {
      team: [],
      goals: [
        {
          id: 'g1',
          title: 'Main',
          tasks: [
            { id: 't1', text: 'Index data', status: 'in_progress', startedAt: NOW - 21 * 60 * 1000, agentId: 'agent-1' },
            { id: 't2', text: 'Publish site', status: 'blocked', blockedReason: 'missing token' }
          ]
        }
      ],
      runs: []
    },
    latencyMs: 650,
    autoWorkOn: true,
    queueDepth: 3
  });
  const signals = detectSignals(snapshot);
  const kinds = signals.map((s) => s.kind);
  assert.ok(kinds.includes('blocker'));
  assert.ok(kinds.includes('health'));
  assert.ok(kinds.includes('drift'));
  assert.ok(kinds.includes('attention'));
  assert.ok(kinds.includes('done'));
  assert.ok(signals.some((s) => s.key === 'job-failed:j1'));
  assert.ok(signals.some((s) => s.key === 'approval:a1'));
  assert.ok(signals.some((s) => s.key === 'task-blocked:t2'));
  assert.ok(signals.some((s) => s.key.includes('working-long')));
  assert.ok(signals.some((s) => s.text.includes('High backend latency')));
  assert.ok(signals.some((s) => s.key === 'queue-idle:auto-on'));
  assert.ok(signals.some((s) => s.key === 'job-done:j2'));
});

test('detectSignals: ordering is deterministic by kind, severity, time, key', () => {
  const snapshot = baseSnapshot({
    jobs: [
      { id: 'j2', estado: 'failed', brief: { objetivo: 'B job' }, failedAt: NOW - 1000 },
      { id: 'j1', estado: 'failed', brief: { objetivo: 'A job' }, failedAt: NOW - 2000 }
    ],
    latencyMs: 1500,
    approvals: [{ id: 'a2', status: 'pending', title: 'B approval' }, { id: 'a1', status: 'pending', title: 'A approval' }]
  });
  const signals = detectSignals(snapshot);
  assert.equal(signals[0].kind, 'blocker');
  assert.equal(signals[0].key, 'job-failed:j1');
  assert.equal(signals[1].key, 'job-failed:j2');
  assert.equal(signals[2].key, 'approval:a1');
  assert.equal(signals[3].key, 'approval:a2');
  assert.equal(signals[signals.length - 1].kind, 'health');
});

test('detectSignals: deterministic for same snapshot', () => {
  const snapshot = baseSnapshot({
    jobs: [{ id: 'j1', estado: 'completed', completedAt: NOW - 120000 }],
    approvals: [{ id: 'a1', status: 'pending', title: 'Grant' }],
    latencyMs: 500
  });
  const a = detectSignals(snapshot);
  const b = detectSignals(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(a, b);
});

test('summarize: formatting with fixed clock and lastSeenAt', () => {
  const snapshot = baseSnapshot({
    jobs: [{ id: 'j1', estado: 'completed', brief: { objetivo: 'Export metrics' }, completedAt: NOW - 10 * 60 * 1000 }],
    approvals: [{ id: 'a1', status: 'pending', title: 'Rotate key' }]
  });
  const lastSeenAt = NOW - 45 * 60 * 1000;
  const briefing = summarize(snapshot, lastSeenAt);
  assert.equal(briefing.headline, '1 blocker needs attention');
  assert.equal(briefing.sinceLabel, 'Since last check: 45 min ago');
  assert.ok(briefing.blockers.some((b) => b.text.includes('Rotate key') && b.severity === 'high'));
  assert.ok(briefing.highlights.some((h) => h.includes('Completed since last seen')));
  assert.ok(briefing.nextActions.length >= 1);
});

test('summarize: unknown last seen and calm state', () => {
  const briefing = summarize(baseSnapshot(), null);
  assert.equal(briefing.headline, 'All clear');
  assert.equal(briefing.sinceLabel, 'Since last check: unknown');
  assert.deepEqual(briefing.blockers, []);
  assert.deepEqual(briefing.highlights, []);
  assert.ok(briefing.nextActions[0].includes('No urgent action'));
});

test('formatSinceLabel: fixed clock formatting', () => {
  assert.equal(formatSinceLabel(NOW, NOW - 30 * 1000), 'Since last check: just now');
  assert.equal(formatSinceLabel(NOW, NOW - 90 * 60 * 1000), 'Since last check: 1h 30m ago');
  assert.equal(formatSinceLabel(NOW, NOW - 26 * 60 * 60 * 1000), 'Since last check: 1d 2h ago');
  assert.equal(formatSinceLabel(NOW, null), 'Since last check: unknown');
});
