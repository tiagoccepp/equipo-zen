import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node 22.6+ can strip TS types when enabled; this keeps `node --test ...` working
// without modifying repo tsconfig/build. Falls back gracefully if already active.
try {
  const mod = await import('node:module');
  if (typeof mod.register === 'function') {
    // Best-effort: built-in strip-types loader name varies by Node version.
    // If registration is unsupported this throws and we continue to direct import.
    mod.register('tsx/esm', { parentURL: import.meta.url });
  }
} catch {
  // ignore
}

let insights;
let actions;
let ambient;
try {
  insights = await import('../src/jabs/insights.ts');
  actions = await import('../src/jabs/command-actions.ts');
  ambient = await import('../src/jabs/ambient.ts');
} catch (err) {
  // Fallback: allow running with `node --experimental-strip-types --test tests/jabs-features.test.mjs`
  // by rethrowing a clear message when strip-types is unavailable.
  throw err;
}

const NOW = Date.parse('2026-11-13T15:00:00.000Z');

function sampleWork() {
  return {
    company: { id: 'co1', name: 'Equipo' },
    team: [{ id: 'a1', name: 'Renata' }],
    goals: [
      {
        id: 'g1',
        title: 'Menu Sushi',
        status: 'active',
        tasks: [
          { id: 't1', text: 'Fix hero layout', status: 'blocked', blockedReason: 'missing assets' },
          { id: 't2', text: 'Polish copy', status: 'review' },
          { id: 't3', text: 'Deploy preview', status: 'pending' },
          { id: 't4', text: 'Refine tokens', status: 'in_progress' }
        ]
      }
    ]
  };
}

function sampleLive(stale = false) {
  return [
    {
      meetingId: 'm1',
      companyId: 'co1',
      companyName: 'Equipo',
      goalTitle: 'Menu Sushi',
      lastActiveAt: new Date(NOW - (stale ? 30 * 60_000 : 60_000)).toISOString(),
      team: [{ id: 'a1', name: 'Renata' }]
    }
  ];
}

test('synthesizePulse: calm when nothing is active', () => {
  const pulse = insights.synthesizePulse({ live: [], work: { company: { id: 'c', name: 'C' }, goals: [] }, now: NOW });
  assert.equal(pulse.level, 'calm');
  assert.equal(pulse.signals.blockedTasks, 0);
  assert.match(pulse.text, /steady/i);
});

test('synthesizePulse: attention when blocked work exists', () => {
  const pulse = insights.synthesizePulse({ live: sampleLive(false), work: sampleWork(), now: NOW });
  assert.equal(pulse.level, 'attention');
  assert.equal(pulse.signals.blockedTasks, 1);
  assert.equal(pulse.signals.inProgressTasks, 1);
  assert.equal(pulse.signals.pendingTasks, 1);
  assert.equal(pulse.signals.liveMeetings, 1);
  assert.match(pulse.text, /blocked/i);
});

test('detectNudges: deterministic blocked/review/silence/queue nudges', () => {
  const nudges = insights.detectNudges({
    live: sampleLive(true),
    work: sampleWork(),
    now: NOW,
    staleAfterMs: 5 * 60_000
  });
  const kinds = nudges.map((n) => n.kind);
  assert.ok(kinds.includes('blocked'));
  assert.ok(kinds.includes('review'));
  assert.ok(kinds.includes('silence'));
  // warn/blocked should be first
  assert.equal(nudges[0].severity, 'warn');
  assert.equal(nudges[0].kind, 'blocked');
  // deterministic ordering for same input
  const again = insights.detectNudges({ live: sampleLive(true), work: sampleWork(), now: NOW, staleAfterMs: 5 * 60_000 });
  assert.deepEqual(nudges.map((n) => n.id), again.map((n) => n.id));
});

test('detectNudges: respects dismissal keys and emits queue-stalled nudge', () => {
  const nudges = insights.detectNudges({
    live: [],
    work: { company: { id: 'c', name: 'C' }, goals: [{ id: 'g', title: 'G', status: 'active', tasks: [{ id: 'p1', text: 'Queued task', status: 'pending' }] }] },
    now: NOW,
    dismissed: ['queue:stalled']
  });
  assert.equal(nudges.find((n) => n.kind === 'queue'), undefined);
  const nudges2 = insights.detectNudges({
    live: [],
    work: { company: { id: 'c', name: 'C' }, goals: [{ id: 'g', title: 'G', status: 'active', tasks: [{ id: 'p1', text: 'Queued task', status: 'pending' }] }] },
    now: NOW
  });
  assert.ok(nudges2.some((n) => n.kind === 'queue'));
});

test('buildSessionBrief: first look and away summary', () => {
  const first = insights.buildSessionBrief({ lastSeenAt: null, now: NOW, live: [], work: sampleWork() });
  assert.match(first.headline, /First look/i);
  assert.equal(first.awayMs, 0);

  const away = insights.buildSessionBrief({
    lastSeenAt: NOW - 2 * 60 * 60_000,
    now: NOW,
    live: sampleLive(false),
    work: sampleWork(),
    previousTaskStatus: { t2: 'in_progress' }
  });
  assert.match(away.headline, /While you were away/i);
  assert.ok(away.lines.some((l) => /blocked|review|Live/i.test(l)));
  assert.ok(away.lines.some((l) => /Status changes/i.test(l)));
});

test('deriveQuickActions: produces context-aware actions for live/blocked/review/project', () => {
  const list = actions.deriveQuickActions({ live: sampleLive(false), work: sampleWork(), now: NOW });
  const intents = new Set(list.map((a) => a.intent));
  assert.ok(intents.has('jump.meeting'));
  assert.ok(intents.has('open.blocker'));
  assert.ok(intents.has('resume.task'));
  assert.ok(intents.has('review.task'));
  assert.ok(intents.has('open.project'));
  assert.ok(intents.has('refresh.pulse'));
  // deterministic sort: priorities non-decreasing
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].priority <= list[i].priority);
  }
});

test('toPaletteItems: exposes stable palette shape', () => {
  const list = actions.deriveQuickActions({ live: [], work: sampleWork(), now: NOW });
  const items = actions.toPaletteItems(list);
  assert.equal(items.length, list.length);
  assert.ok(items[0].id);
  assert.ok(items[0].title);
  assert.ok(Array.isArray(items[0].keywords));
  assert.equal(items[0].action, list[0]);
});

test('computeJabsState: composes pulse, nudges, brief, actions', () => {
  const snapshot = { live: sampleLive(false), work: sampleWork(), fetchedAt: NOW, degraded: {} };
  const state = ambient.computeJabsState(snapshot, { lastSeenAt: NOW - 3_600_000, now: NOW });
  assert.equal(state.pulse.level, 'attention');
  assert.ok(Array.isArray(state.nudges));
  assert.match(state.brief.headline, /While you were away/i);
  assert.ok(state.actions.length > 0);
});

test('readLastSeen/writeLastSeen: graceful with in-memory storage', () => {
  const mem = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); }
    };
  })();
  assert.equal(ambient.readLastSeen('k', mem), null);
  ambient.writeLastSeen(12345, 'k', mem);
  assert.equal(ambient.readLastSeen('k', mem), 12345);
});
