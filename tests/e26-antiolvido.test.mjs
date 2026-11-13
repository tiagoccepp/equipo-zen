// E-26: meta-eval anti-olvido — cada regla: prompt + harness + test.
// Si una pata falta, el test lo grita (la regla "se olvida" del sistema).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

// [regla, promptAncla, harnessAncla, testFile]
const RULES = [
  ['prohibiciones', 'prohibitionsSection', 'matchProhibition', 'tests/e22-acceso.test.mjs'],
  ['tiers/modos', 'viaPlan', 'checkCall', 'tests/f04-permisos.test.mjs'],
  ['gustos', 'tastesSection', 'tastesFor', 'tests/e09-gustos.test.mjs'],
  ['l límites rol', 'boundariesBlock', "tool no permitida para tu rol", 'tests/flujo-manos-roles.test.mjs'],
  ['secretos', 'secrets-guard', 'looksLikeSecret', 'tests/f06-hooks.test.mjs'],
  ['acceso proyecto', 'access_level', 'permLevel', 'tests/e22-acceso.test.mjs'],
  ['plan aprobado', 'planApproved', 'approvedPlanForGoal', 'tests/m09-plan.test.mjs']
];

test('e26: toda regla tiene prompt + harness + test', () => {
  const rt = src('server/lib/agent-runtime.js');
  const ms = src('server/lib/meeting-session.js');
  const manos = src('server/lib/manos.js');
  const perms = src('server/lib/permissions.js');
  const all = rt + ms + manos + perms + src('server/lib/hooks.js') + src('server/lib/store.js');
  for (const [rule, promptMark, harnessMark, testFile] of RULES) {
    assert.ok(all.includes(promptMark.trim()), `${rule}: prompt (${promptMark.trim()})`);
    assert.ok(all.includes(harnessMark), `${rule}: harness (${harnessMark})`);
    assert.ok(existsSync(join(ROOT, testFile)), `${rule}: test ${testFile}`);
  }
});

test('e26: reminders mid-loop cada 3 turnos', () => {
  const manos = src('server/lib/manos.js');
  assert.ok(manos.includes('(turno + 1) % 3 === 0'), 'reminder periódico');
  assert.ok(manos.includes('[recordatorio:'), 'texto reminder');
});

test('e26: research + eval viva documentados', () => {
  assert.ok(existsSync(join(ROOT, '..', 'research', 'antiolvido-2026-11-10.md')) || existsSync('/home/tito/research/antiolvido-2026-11-10.md'), 'research doc');
});
