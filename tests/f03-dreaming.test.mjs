// F-03: dreaming — purga, decaimiento y consolidación. DB :memory:.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dreamCycle } from '../server/lib/dreaming.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

function seeded() {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  return { store, company };
}

const OLD = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();

test('f03: purga turnos de reuniones cerradas viejas CON resumen', async () => {
  const { store, company } = seeded();
  const m1 = store.createMeeting({ companyId: company.id });
  store.appendTurn(m1.id, { kind: 'user', speaker: 'You', text: 'hola' });
  store.appendTurn(m1.id, { kind: 'agent', speaker: 'X', text: 'chau' });
  store.db.prepare("UPDATE meetings SET status='closed', summary='resumen', closed_at=? WHERE id=?").run(OLD, m1.id);
  const m2 = store.createMeeting({ companyId: company.id });
  store.appendTurn(m2.id, { kind: 'user', speaker: 'You', text: 'reciente' });

  const dry = await dreamCycle({ store, dryRun: true });
  assert.equal(dry.prunedTurns, 2, 'dry-run cuenta sin borrar');
  assert.equal(store.recentTurns(m1.id, 10).length, 2, 'dry-run no borra');

  const r = await dreamCycle({ store });
  assert.equal(r.prunedTurns, 2);
  assert.equal(r.prunedMeetings, 1);
  assert.equal(store.recentTurns(m1.id, 10).length, 0, 'turnos viejos purgados');
  assert.equal(store.recentTurns(m2.id, 10).length, 1, 'reciente intacta');
  assert.ok(store.getMeeting(m1.id).summary, 'resumen conservado');
  store.close();
});

test('f03: decae learnings débiles sin refuerzo', async () => {
  const { store } = seeded();
  const weak = store.insertLearning({ type: 'fact', content: 'dato débil viejo', confidence: 0.3 });
  store.db.prepare('UPDATE learnings SET last_reinforced_at=? WHERE id=?').run(OLD, weak);
  const strong = store.insertLearning({ type: 'fact', content: 'dato fuerte', confidence: 0.9 });
  store.db.prepare('UPDATE learnings SET last_reinforced_at=? WHERE id=?').run(OLD, strong);
  const fresh = store.insertLearning({ type: 'fact', content: 'dato débil fresco', confidence: 0.3 });

  const r = await dreamCycle({ store });
  assert.equal(r.decayed, 1);
  const rows = store.db.prepare('SELECT id, status FROM learnings').all();
  assert.equal(rows.find((x) => x.id === weak).status, 'decayed');
  assert.equal(rows.find((x) => x.id === strong).status, 'active', 'fuerte sobrevive');
  assert.equal(rows.find((x) => x.id === fresh).status, 'active', 'fresco sobrevive');
  assert.ok(!store.activeLearnings().some((l) => l.id === weak), 'fuera de activas');
  store.close();
});

test('f03: consolida resúmenes con LLM inyectado (fake)', async () => {
  const { store, company } = seeded();
  const m = store.createMeeting({ companyId: company.id });
  store.db.prepare("UPDATE meetings SET summary='A Tito le gusta el azul para botones.' WHERE id=?").run(m.id);
  const r = await dreamCycle({
    store,
    completeChat: async () => ({ text: 'Tito prefiere botones azules.\nLe gustan los contrastes altos.' })
  });
  assert.equal(r.consolidated, 1);
  const facts = store.activeLearnings().filter((l) => String(l.content).startsWith('[sueño]'));
  assert.equal(facts.length, 2, '2 hechos extraídos');
  // Segunda vuelta: ya consolidada, no repite.
  const r2 = await dreamCycle({ store, completeChat: async () => ({ text: 'otro' }) });
  assert.equal(r2.consolidated, 0);
  store.close();
});

test('f03: NADA marca como revisada sin inventar', async () => {
  const { store, company } = seeded();
  const m = store.createMeeting({ companyId: company.id });
  store.db.prepare("UPDATE meetings SET summary='Charla trivial sin datos.' WHERE id=?").run(m.id);
  await dreamCycle({ store, completeChat: async () => ({ text: 'NADA' }) });
  const marks = store.activeLearnings().filter((l) => l.content.includes('sin hechos durables'));
  assert.equal(marks.length, 1);
  store.close();
});
