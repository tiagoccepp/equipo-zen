import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveSnapshot } from '../server/lib/mission.js';

const MEETINGS = [
  { id: 'm1', company_id: 'c1', title: 'Daily', status: 'active', turn_count: 12, last_active_at: '2026-11-09T12:00:00Z' },
  { id: 'm2', company_id: 'c1', title: 'Vieja', status: 'active', turn_count: 3, last_active_at: '2026-11-01T12:00:00Z' },
  { id: 'm3', company_id: 'cX', title: 'Sin empresa', status: 'active', turn_count: 1, last_active_at: null }
];

const deps = {
  meetings: MEETINGS,
  isLive: (id) => id === 'm1' || id === 'm3',
  getCompany: (id) => (id === 'c1' ? { id: 'c1', name: 'Pablo' } : null),
  teamFor: (companyId) =>
    companyId === 'c1'
      ? [{ id: 'a1', name: 'Pablo', title: 'CEO', role: 'ceo', color: '#fff' }]
      : [],
  goalFor: (meetingId) => (meetingId === 'm1' ? 'Siempre' : null)
};

test('solo incluye reuniones vivas', () => {
  const snap = buildLiveSnapshot(deps);
  assert.equal(snap.live.length, 2);
  assert.deepEqual(
    snap.live.map((m) => m.meetingId),
    ['m1', 'm3']
  );
});

test('mapea equipo, empresa y proyecto', () => {
  const snap = buildLiveSnapshot(deps);
  const m1 = snap.live[0];
  assert.equal(m1.companyName, 'Pablo');
  assert.equal(m1.goalTitle, 'Siempre');
  assert.equal(m1.turnCount, 12);
  assert.equal(m1.team.length, 1);
  assert.equal(m1.team[0].name, 'Pablo');
});

test('degrada empresa desconocida al id', () => {
  const snap = buildLiveSnapshot(deps);
  const m3 = snap.live[1];
  assert.equal(m3.companyName, 'cX');
  assert.equal(m3.goalTitle, null);
  assert.deepEqual(m3.team, []);
});

test('sin reuniones vivas devuelve lista vacía', () => {
  const snap = buildLiveSnapshot({ ...deps, isLive: () => false });
  assert.deepEqual(snap, { live: [] });
});
