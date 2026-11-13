// A-04 + A-09: compact dirigida+disco + checkpoints + thrashing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compactDirected,
  effectiveCompactSummary,
  loadCompactFromDisk,
  persistCompactToDisk
} from '../server/lib/compaction.js';
import { createThrashingGuard, listCheckpoints, loadCheckpoint, saveCheckpoint } from '../server/lib/checkpoints.js';
import { runToolLoop } from '../server/lib/manos.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'a04-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

function seeded(turns = 0) {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const meeting = store.createMeeting({ companyId: company.id });
  for (let i = 0; i < turns; i += 1) {
    store.appendTurn(meeting.id, { kind: 'user', speaker: 'You', text: `turno ${i} bla` });
  }
  return { store, company, meeting };
}

test('a04: dirigida resume rango + persiste disco + re-inyecta', async () => {
  const { store, company, meeting } = seeded(30);
  const r = await compactDirected({
    store,
    meetingId: meeting.id,
    completeChat: async () => ({ text: 'Resumen dirigido OK.' })
  });
  assert.equal(r.compacted, true);
  assert.equal(r.turns, 30);
  persistCompactToDisk({ companyId: company.id, slug: 'web', meetingId: meeting.id, summary: 'Resumen dirigido OK.' });
  assert.ok(loadCompactFromDisk({ companyId: company.id, slug: 'web', meetingId: meeting.id }).includes('dirigido'));
  // DB borrada → disco restaura.
  store._prepare('UPDATE meetings SET compacted_summary = NULL WHERE id = ?').run(meeting.id);
  const eff = effectiveCompactSummary({ store, meetingId: meeting.id, companyId: company.id, slug: 'web' });
  assert.ok(eff.includes('dirigido'), 're-inyección desde disco');
  assert.ok(store.getMeeting(meeting.id).compacted_summary.includes('dirigido'), 'DB restaurada');
  store.close();
});

test('a04: throughId acota + poco no compacta', async () => {
  const { store, meeting } = seeded(30);
  const ids = store._prepare('SELECT id FROM turns WHERE meeting_id = ? ORDER BY id').all(meeting.id).map((r) => r.id);
  const r = await compactDirected({
    store, meetingId: meeting.id, throughId: ids[9],
    completeChat: async () => ({ text: 'primeros 10' })
  });
  assert.equal(r.turns, 10);
  assert.equal(r.throughId, ids[9]);
  const small = seeded(3);
  const r2 = await compactDirected({ store: small.store, meetingId: small.meeting.id, completeChat: async () => ({ text: 'x' }) });
  assert.equal(r2.compacted, false);
  store.close();
  small.store.close();
});

test('a09: checkpoints round-trip + lista', () => {
  const file = saveCheckpoint({ companyId: 'c1', slug: 's', scope: 'team', key: 'job-1', state: { done: ['a'], todo: ['b'] } });
  assert.ok(file.includes('checkpoints'));
  const loaded = loadCheckpoint({ companyId: 'c1', slug: 's', scope: 'team', key: 'job-1' });
  assert.deepEqual(loaded.state, { done: ['a'], todo: ['b'] });
  assert.ok(listCheckpoints({ companyId: 'c1', slug: 's' }).some((f) => f.includes('job-1')));
  assert.equal(loadCheckpoint({ companyId: 'c1', slug: 's', scope: 'x', key: 'nope' }), null);
});

test('a09: thrashing guard + freno en loop real', async () => {
  const g = createThrashingGuard({ consecutive: 4 });
  assert.equal(g.push('run_cmd', false), false);
  assert.equal(g.push('run_cmd', false), false);
  assert.equal(g.push('run_cmd', false), false);
  assert.equal(g.push('run_cmd', false), true, 'cuarto seguido');
  g.reset();
  assert.equal(g.push('run_cmd', false), false);
  assert.equal(g.push('run_cmd', true), false, 'éxito resetea');
  assert.equal(g.push('run_cmd', false), false, 'racha nueva');

  // Loop: 4 fallos seguidos misma tool → frena con nota.
  const call = (n, a) => `\`\`\`tool:${n}\n${JSON.stringify(a)}\n\`\`\``;
  const scripts = [
    call('read_file', { path: 'nope1.txt' }),
    call('read_file', { path: 'nope2.txt' }),
    call('read_file', { path: 'nope3.txt' }),
    call('read_file', { path: 'nope4.txt' }),
    call('read_file', { path: 'nope5.txt' }),
    'fin'
  ];
  let i = 0;
  const out = await runToolLoop({
    system: 's',
    messages: [{ role: 'user', content: 'h' }],
    completeChat: async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] }),
    source: { companyId: 'c1', slug: 's' },
    maxTurns: 8
  });
  assert.ok(out.toolSummary.includes('reintentos idénticos'), out.toolSummary);
  const calls = out.toolTurns.flatMap((t) => t.calls || []);
  assert.equal(calls.length, 4, 'frenó en el cuarto');
});
