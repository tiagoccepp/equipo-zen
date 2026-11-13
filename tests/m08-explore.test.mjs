// M-08: Explore read-only — lee, reporta, y NO PUEDE escribir (harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}
const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'm08-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const { explore, exploreSystem, EXPLORE_ALLOW } = await import('../server/lib/explore.js');

const call = (name, args) => `\`\`\`tool:${name}\n${JSON.stringify(args)}\n\`\`\``;
function fakeChat(scripts) {
  let i = 0;
  return async () => ({ text: scripts[Math.min(i++, scripts.length - 1)] });
}

const ctx = { companyId: 'acme', slug: 'demo' };
mkdirSync(path.join(TMPWS, 'acme', 'demo'), { recursive: true });
writeFileSync(path.join(TMPWS, 'acme', 'demo', 'hola.txt'), 'contenido secreto');

test('m08: allow solo lectura', () => {
  assert.deepEqual([...EXPLORE_ALLOW].sort(), ['fetch_url', 'list_files', 'now', 'read_file']);
  assert.ok(exploreSystem().includes('read-only'));
});

test('m08: explora leyendo y reporta', async () => {
  const r = await explore({
    question: '¿Qué hay en el proyecto?',
    completeChat: fakeChat([
      call('list_files', {}),
      call('read_file', { path: 'hola.txt' }),
      'Reporte: hay hola.txt con contenido.'
    ]),
    ...ctx
  });
  assert.equal(r.readOnly, true);
  assert.ok(r.summary.includes('2 herramienta'), r.summary);
  assert.ok(r.calls.every((c) => c.ok), 'todas OK');
  assert.ok(r.files.some((f) => f.includes('hola.txt')), `rutas: ${r.files.join(',')}`);
});

test('m08: intento de escritura RECHAZADO por harness (archivo intacto)', async () => {
  const before = readFileSync(path.join(TMPWS, 'acme', 'demo', 'hola.txt'), 'utf8');
  const r = await explore({
    question: 'cambiá todo',
    completeChat: fakeChat([
      call('write_file', { path: 'hola.txt', content: 'HACKEADO' }),
      call('run_cmd', { cmd: 'echo HACKEADO > hola.txt' }),
      call('apply_patch', { patch: '*** Begin Patch\n*** End Patch' }),
      'Reporte: no pude escribir nada.'
    ]),
    ...ctx
  });
  assert.ok(r.calls.length === 3, '3 intentos registrados');
  assert.ok(r.calls.every((c) => !c.ok), 'todos rechazados');
  assert.ok(r.summary.includes('3 fallaron'), r.summary);
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'hola.txt'), 'utf8'), before, 'archivo INTACTO');
});

test('m08: valida inputs', async () => {
  await assert.rejects(() => explore({ question: 'x' }), /completeChat/);
  await assert.rejects(() => explore({ question: '  ', completeChat: async () => ({ text: '' }) }), /pregunta/);
});
