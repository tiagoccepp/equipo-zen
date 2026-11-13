// E-27: topes — default sin topes; setearlos enforcea (tokens/tiempo/RAM).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkCaps, ramMbNow } from '../server/lib/caps.js';
import { Store } from '../server/lib/store.js';
import { companyTemplates } from '../server/lib/config.js';

test('e27: sin topes todo pasa; umbrales 80% avisan, 100% frenan', () => {
  assert.deepEqual(checkCaps({}), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(checkCaps({ caps: {}, usage: { tokens: 99999999 } }), { ok: true, errors: [], warnings: [] }, 'default sin topes');
  const w = checkCaps({ caps: { tokens: 100 }, usage: { tokens: 85 } });
  assert.equal(w.ok, true);
  assert.equal(w.warnings.length, 1, 'aviso 80%');
  const e = checkCaps({ caps: { tokens: 100 }, usage: { tokens: 100 } });
  assert.equal(e.ok, false);
  assert.ok(e.errors[0].includes('tokens'));
  const t = checkCaps({ caps: { timeMin: 60 }, usage: { elapsedMin: 61 } });
  assert.equal(t.ok, false);
  const r = checkCaps({ caps: { ramMb: 512 }, usage: { ramMb: 600 } });
  assert.equal(r.ok, false);
  assert.ok(ramMbNow() > 0, 'RSS real');
});

test('e27: store setCaps + PATCH semántico', () => {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.id === 'web') || companyTemplates.templates[0];
  const company = store.createCompanyFromTemplate(template, 'test');
  const project = store.createProject({ companyId: company.id, title: 'Topes' });
  assert.equal(project.cap_tokens, null, 'default sin tope');
  const updated = store.setProjectCaps(project.id, { tokens: 5000, ramMb: 0, timeMin: -3 });
  assert.equal(updated.cap_tokens, 5000);
  assert.equal(updated.cap_ram_mb, null, '0 → sin tope');
  assert.equal(updated.cap_time_min, null, 'negativo → sin tope');
  store.close();
});
