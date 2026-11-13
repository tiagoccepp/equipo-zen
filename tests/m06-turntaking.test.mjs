// M-06: turn-taking semántico — matriz ES/EN + cableado estático.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyInterruption, shouldCut } from '../src/lib/turn-taking.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('m06: backchannel ES/EN no corta', () => {
  for (const t of ['sí', 'si', 'ajá', 'mhm', 'mm', 'dale', 'ok', 'claro', 'entiendo', 'ya veo', 'bien', 'perfecto', 'genial']) {
    assert.equal(classifyInterruption(t), 'backchannel', t);
    assert.equal(shouldCut(classifyInterruption(t)), false, t);
  }
  for (const t of ['yeah', 'yes', 'right', 'got it', 'i see', 'uh-huh', 'mm-hmm', 'sure']) {
    assert.equal(classifyInterruption(t), 'backchannel', t);
  }
});

test('m06: stop explícito corta (barge)', () => {
  for (const t of ['pará', 'para', 'basta', 'callate', 'esperá', 'momento', 'no no', 'stop', 'wait', 'hold on', 'shut up', 'pará un momento por favor']) {
    assert.equal(classifyInterruption(t), 'barge', t);
    assert.equal(shouldCut(classifyInterruption(t)), true, t);
  }
});

test('m06: contenido nuevo corta; largo con fillers es contenido', () => {
  assert.equal(classifyInterruption('cambiá el color a azul'), 'content');
  assert.equal(classifyInterruption('no, mejor en rojo'), 'content');
  assert.equal(classifyInterruption('sí, está bien, pero agregá un botón de contacto arriba'), 'content', 'largo = contenido');
  assert.equal(classifyInterruption('ok entendido, ahora explicame los precios'), 'content');
});

test('m06: vacío/ruido = unclear (esperar, no cortar)', () => {
  for (const t of ['', '  ', 'e', 'eh', 'ah', 'x']) {
    assert.equal(classifyInterruption(t), 'unclear', JSON.stringify(t));
    assert.equal(shouldCut(classifyInterruption(t)), false);
  }
});

test('m06: cableado — app consulta semántica y manda hint', () => {
  const app = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  assert.ok(app.includes("from './lib/turn-taking.ts'"), 'import');
  assert.ok(app.includes("=== 'backchannel'"), 'backchannel no corta');
  assert.ok(app.includes('cutHint()'), 'hint en cortes');
  const client = readFileSync(join(ROOT, 'src/client.ts'), 'utf8');
  assert.ok(client.includes('hint?: { cls: string; text: string }'), 'firma interrupt con hint');
  const server = readFileSync(join(ROOT, 'server/lib/meeting-session.js'), 'utf8');
  assert.ok(server.includes('hintCls'), 'telemetría con hint');
});
