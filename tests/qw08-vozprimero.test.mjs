// QW-08: regla voz-primero (shapeSpeechText a nivel harness) +
// chequeo estático de a11y del HTML (roles/focos/skip links). Cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shapeSpeechText } from '../server/lib/text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('qw08: links y URLs se vuelven prosa', () => {
  assert.equal(
    shapeSpeechText('Mirá [la doc](https://example.com/x) por favor.'),
    'Mirá la doc por favor.'
  );
  assert.equal(
    shapeSpeechText('Está en https://example.com/largo?x=1 listo.'),
    'Está en listo.'
  );
});

test('qw08: código, énfasis y headings se pelan dejando contenido', () => {
  assert.equal(shapeSpeechText('Usá `npm test` ahora.'), 'Usá npm test ahora.');
  assert.equal(shapeSpeechText('## Título\nEsto es **importante** de verdad.'), 'Título Esto es importante de verdad.');
  assert.equal(shapeSpeechText('```js\nconst a = 1;\n```\nListo.'), 'const a = 1; Listo.');
});

test('qw08: listas, citas y tablas se vuelven prosa corrida', () => {
  const md = '- Primero\n- Segundo\n1. Tercero\n> nota al pie';
  assert.equal(shapeSpeechText(md), 'Primero Segundo Tercero nota al pie');
  assert.equal(shapeSpeechText('| a | b |\n| 1 | 2 |'), ', a, b, , 1, 2,');
});

test('qw08: prosa normal intacta', () => {
  assert.equal(shapeSpeechText('Hola, ¿cómo estás? Todo bien.'), 'Hola, ¿cómo estás? Todo bien.');
  assert.equal(shapeSpeechText(''), '');
});

test('qw08: a11y estático — tabs con roles, skip links, status, focos', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('role="tablist"'), 'tablist');
  assert.ok(html.includes('role="tab"'), 'tabs');
  assert.ok(html.includes('role="tabpanel"'), 'panels');
  assert.ok(html.includes('aria-controls="view-console"'), 'tab→panel link');
  assert.ok(html.includes('class="skip-link" href="#prompt"'), 'skip a compositor');
  assert.ok(html.includes('class="skip-link" href="#stream"'), 'skip a mensajes');
  assert.ok(html.includes('id="status" role="status"'), 'status anunciable');
  assert.ok(html.includes('id="stream" aria-live="polite"'), 'stream live region');
  const css = readFileSync(join(ROOT, 'src/app.css'), 'utf8');
  assert.ok(css.includes('.skip-link'), 'skip link estilado');
  assert.ok(css.includes('.tabs button:focus-visible'), 'foco visible en tabs');
  assert.ok(css.includes('.mmd-copy:focus-visible'), 'foco visible en copiar');
  const app = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  assert.ok(app.includes("e.key === 'Escape'"), 'atajo Escape interrumpe');
  assert.ok(app.includes("e.key === '/'"), 'atajo / enfoca compositor');
  assert.ok(app.includes("e.key === 'm'"), 'atajo Alt+M mic');
});
