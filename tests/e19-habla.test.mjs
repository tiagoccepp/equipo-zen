// E-19: habla cara-a-cara — doctrina en prompts + tope anti-desborde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('e19: doctrina V-13 presente (oído, expresivo, decide)', () => {
  const rt = readFileSync(join(ROOT, 'server/lib/agent-runtime.js'), 'utf8');
  for (const marker of ['OÍDO', 'Decidí VOS qué decir', 'una idea por oración', 'recortes artificiales']) {
    assert.ok(rt.includes(marker), `doctrina: ${marker}`);
  }
  for (const marker of ['one idea per sentence', 'YOU decide what to say', 'No artificial cuts']) {
    assert.ok(rt.includes(marker), `doctrine EN: ${marker}`);
  }
});

test('e19: sin recorte artificial (1-2 frases / monólogo / explayate-solo)', () => {
  const rt = readFileSync(join(ROOT, 'server/lib/agent-runtime.js'), 'utf8');
  for (const banned of ['1-2 frases', '1-2 sentences', 'Explayate solo si', 'Expand only if', 'antes de soltar un monólogo', 'launching into a monologue']) {
    assert.ok(!rt.includes(banned), `fuera: ${banned}`);
  }
  assert.ok(rt.includes('maxTokens: voiceFast ? 2000 : 3000'), 'tope voz 2000 (anti-desborde)');
});

test('e19: smoke actualizado a sustancia', () => {
  const smoke = readFileSync(join(ROOT, 'tests/personality-smoke.mjs'), 'utf8');
  assert.ok(!smoke.includes("'1-2 frases'"), 'smoke sin 1-2 frases');
  assert.ok(smoke.includes('sustancia sin divague'), 'smoke V-13');
});
