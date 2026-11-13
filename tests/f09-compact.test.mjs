// F-09: compactación — umbrales, batch rolling, render de sección.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactOnce, needsCompaction, renderCompactSection } from '../server/lib/compaction.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

function seeded(turns = 0) {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const meeting = store.createMeeting({ companyId: company.id });
  for (let i = 0; i < turns; i += 1) {
    store.appendTurn(meeting.id, { kind: i % 2 ? 'agent' : 'user', speaker: i % 2 ? 'X' : 'You', text: `turno ${i} con contenido` });
  }
  return { store, meeting };
}

test('f09: needsCompaction por umbral menos compactados', () => {
  const { store, meeting } = seeded(50);
  assert.equal(needsCompaction(store, meeting.id), false, '50 < 120');
  assert.equal(needsCompaction(store, 'nope'), false);
  store.close();
  const big = seeded(130);
  assert.equal(needsCompaction(big.store, big.meeting.id), true, '130 ≥ 120');
  big.store.close();
});

test('f09: compactOnce resume batch y avanza cursor', async () => {
  const { store, meeting } = seeded(130);
  const seen = [];
  const r = await compactOnce({
    store,
    meetingId: meeting.id,
    completeChat: async ({ messages }) => {
      seen.push(messages[0].content);
      return { text: 'Resumen: se habló de A, B y C. Pendiente: D.' };
    }
  });
  assert.equal(r.compacted, true);
  assert.equal(r.turns, 60, 'batch de 60');
  const m = store.getMeeting(meeting.id);
  assert.equal(m.compacted_turns, 60);
  assert.ok(m.compacted_summary.includes('Pendiente: D'), m.compacted_summary);
  assert.ok(seen[0].includes('turno 0'), 'empieza desde lo viejo');
  assert.ok(!seen[0].includes('turno 129'), 'respeta keepLast');
  // Segunda vuelta: rolling (fusiona previo).
  const r2 = await compactOnce({
    store,
    meetingId: meeting.id,
    completeChat: async () => ({ text: 'Más E y F.' })
  });
  assert.equal(r2.compacted, true);
  assert.equal(store.getMeeting(meeting.id).compacted_turns, 90);
  store.close();
});

test('f09: poco para compactar / resumen vacío no tocan nada', async () => {
  const { store, meeting } = seeded(50);
  const r = await compactOnce({ store, meetingId: meeting.id, completeChat: async () => ({ text: 'x' }) });
  assert.equal(r.compacted, false);
  assert.equal(store.getMeeting(meeting.id).compacted_turns, 0);
  await assert.rejects(() => compactOnce({ store, meetingId: meeting.id }), /completeChat/);
  store.close();
});

test('f09: renderCompactSection ES/EN + vacío', () => {
  assert.equal(renderCompactSection(''), '');
  assert.equal(renderCompactSection(null), '');
  assert.ok(renderCompactSection('dato viejo').includes('COMPACTADO'));
  assert.ok(renderCompactSection('old', { english: true }).includes('ROLLED-UP'));
});
