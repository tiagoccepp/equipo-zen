import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetPabloMemoryCache,
  appendDaily,
  memoryDirFor,
  readDaily,
  readMemoryFile,
  renderMemorySection,
  todayStamp,
  writeMemoryFile
} from '../server/lib/pablo-memory.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEEDS = join(here, '..', 'server', 'templates', 'pablo');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pablo-mem-'));
  process.env.PABLO_MEMORY_DIR = tmp;
  __resetPabloMemoryCache();
});
afterEach(() => {
  delete process.env.PABLO_MEMORY_DIR;
  __resetPabloMemoryCache();
});

test('memoryDirFor resuelve <base>/<slug>/memoria y rechaza slugs malos', () => {
  assert.equal(memoryDirFor('acme'), join(tmp, 'acme', 'memoria'));
  for (const malo of ['', '../x', 'a/b', 'a\\b', '..', '  ']) {
    assert.throws(() => memoryDirFor(malo), /Empresa inválida/);
  }
});

test('roundtrip write/read deja el archivo en disco', () => {
  const abs = writeMemoryFile('acme', 'SOUL.md', 'yo soy pablo');
  assert.ok(existsSync(abs));
  assert.equal(abs, join(tmp, 'acme', 'memoria', 'SOUL.md'));
  assert.equal(readMemoryFile('acme', 'SOUL.md'), 'yo soy pablo');
  assert.equal(readFileSync(abs, 'utf-8'), 'yo soy pablo');
});

test('read faltante o nombre inválido devuelve null, nunca throw', () => {
  assert.equal(readMemoryFile('acme', 'USER.md'), null);
  assert.equal(readMemoryFile('sin-empresa', 'MEMORY.md'), null);
  assert.equal(readMemoryFile('acme', 'hack.txt'), null);
  assert.equal(readMemoryFile('acme', '../evil.md'), null);
  assert.equal(readMemoryFile('acme', ''), null);
  assert.equal(readDaily('acme'), null);
  assert.equal(readDaily('acme', 'no-fecha'), null);
  assert.equal(readDaily('acme', '../../etc/passwd'), null);
});

test('write rechaza path traversal y nombres fuera de allowlist', () => {
  for (const malo of ['../evil.md', 'sub/x.md', '..', 'x.md/', 'hack.txt', '', 'SOUL.md/..']) {
    assert.throws(() => writeMemoryFile('acme', malo, 'x'), /inválido/);
  }
});

test('appendDaily crea memory/YYYY-MM-DD.md y acumula', () => {
  const stamp = todayStamp();
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}$/);
  const abs = appendDaily('acme', 'línea uno');
  assert.equal(abs, join(tmp, 'acme', 'memoria', 'memory', `${stamp}.md`));
  appendDaily('acme', 'línea dos');
  const daily = readDaily('acme');
  assert.ok(daily.includes('línea uno'));
  assert.ok(daily.includes('línea dos'));
  assert.ok(daily.indexOf('línea uno') < daily.indexOf('línea dos'));
});

test('render respeta orden SOUL > USER > MEMORY > hoy, con headers', () => {
  writeMemoryFile('acme', 'SOUL.md', 'alma');
  writeMemoryFile('acme', 'USER.md', 'directivas');
  writeMemoryFile('acme', 'MEMORY.md', 'hechos');
  appendDaily('acme', 'hoy pasó x');
  const out = renderMemorySection('acme', { maxChars: 10000 });
  for (const h of ['PABLO SOUL', 'PABLO USER', 'PABLO MEMORY', 'PABLO TODAY']) {
    assert.ok(out.includes(h), `falta header ${h}`);
  }
  const idx = (s) => out.indexOf(s);
  assert.ok(idx('PABLO SOUL') < idx('PABLO USER'));
  assert.ok(idx('PABLO USER') < idx('PABLO MEMORY'));
  assert.ok(idx('PABLO MEMORY') < idx('PABLO TODAY'));
  // AGENTS.md existe pero NO se inyecta al prompt de voz.
  writeMemoryFile('acme', 'AGENTS.md', 'convenciones-secretas');
  __resetPabloMemoryCache();
  assert.ok(!renderMemorySection('acme', { maxChars: 10000 }).includes('convenciones-secretas'));
});

test('render respeta maxChars y empresa vacía devuelve cadena vacía', () => {
  writeMemoryFile('big', 'SOUL.md', 's'.repeat(500));
  writeMemoryFile('big', 'USER.md', 'u'.repeat(500));
  writeMemoryFile('big', 'MEMORY.md', 'm'.repeat(500));
  const corto = renderMemorySection('big', { maxChars: 200 });
  assert.ok(corto.length <= 200, `largo ${corto.length} > 200`);
  assert.ok(corto.includes('PABLO SOUL')); // lo primero sobrevive al recorte
  assert.equal(renderMemorySection('vacia'), '');
  assert.equal(renderMemorySection('big', { maxChars: 0 }), '');
});

test('write invalida la caché de lectura (sin lecturas rancias)', () => {
  writeMemoryFile('acme', 'SOUL.md', 'v1');
  assert.equal(readMemoryFile('acme', 'SOUL.md'), 'v1');
  writeMemoryFile('acme', 'SOUL.md', 'v2');
  assert.equal(readMemoryFile('acme', 'SOUL.md'), 'v2');
  appendDaily('acme', 'primero');
  assert.ok(readDaily('acme').includes('primero'));
  appendDaily('acme', 'segundo');
  assert.ok(readDaily('acme').includes('segundo'));
});

test('seeds parsean: existen y traen sus headers', () => {
  const esperados = {
    'SOUL.md': ['# SOUL.md', 'Pablo'],
    'USER.md': ['# USER.md', 'observed:', 'Always', 'Never'],
    'MEMORY.md': ['# MEMORY.md'],
    'AGENTS.md': ['# AGENTS.md', 'workspace']
  };
  for (const [file, headers] of Object.entries(esperados)) {
    const abs = join(SEEDS, file);
    assert.ok(existsSync(abs), `falta seed ${file}`);
    const raw = readFileSync(abs, 'utf-8');
    for (const h of headers) {
      assert.ok(raw.includes(h), `${file} sin ${JSON.stringify(h)}`);
    }
  }
});
