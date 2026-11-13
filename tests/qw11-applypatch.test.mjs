// QW-11: apply_patch atómico multi-archivo. Workspace temporal, cero red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}
const TMPWS = mkdtempSync(path.join(os.tmpdir(), 'qw11-ws-'));
process.env.WORKSPACE_ROOT = TMPWS;

const { parseApplyPatch, applyHunks, applyGroups } = await import('../server/lib/apply-patch.js');
const { getTool } = await import('../server/lib/manos.js');

const ctx = { companyId: 'acme', slug: 'demo' };
mkdirSync(path.join(TMPWS, 'acme', 'demo'), { recursive: true });
const wfile = (rel, content) => {
  const full = path.join(TMPWS, 'acme', 'demo', rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
};
const tool = getTool('apply_patch');
assert.ok(tool, 'tool apply_patch registrada');

test('qw11: parse OK + update + add + delete', () => {
  const r = parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    ' hola',
    '-mundo',
    '+tierra',
    '*** Add File: b.txt',
    '+uno',
    '+dos',
    '*** Delete File: c.txt',
    '*** End Patch'
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 3);
  assert.equal(r.files[0].op, 'update');
  assert.deepEqual(r.files[0].hunks.map((h) => h.type), ['context', 'remove', 'add']);
  assert.equal(r.files[1].op, 'add');
  assert.equal(r.files[2].op, 'delete');
});

test('qw11: parse rechaza formato roto', () => {
  assert.equal(parseApplyPatch('sin marcadores').ok, false);
  const bad = parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\nlínea sin marcador\n*** End Patch');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('espacio/-/'));
});

test('qw11: applyHunks exacto, ambiguo y ausente', () => {
  const lines = ['uno', 'dos', 'tres'];
  const ok = applyHunks(lines, [
    { type: 'context', text: 'uno' },
    { type: 'remove', text: 'dos' },
    { type: 'add', text: 'DOS' },
    { type: 'context', text: 'tres' }
  ]);
  assert.deepEqual(ok.lines, ['uno', 'DOS', 'tres']);
  const amb = applyHunks(['x', 'y', 'x', 'y'], [{ type: 'remove', text: 'x' }, { type: 'context', text: 'y' }]);
  assert.equal(amb.ok, false);
  assert.ok(amb.error.includes('ambiguo'));
  const miss = applyHunks(lines, [{ type: 'remove', text: 'zzz' }]);
  assert.equal(miss.ok, false);
  assert.ok(miss.error.includes('no encontrado'));
});

test('qw11: applyGroups encadena hunks', () => {
  const r = applyGroups(['a', 'b', 'c', 'd'], [
    [{ type: 'remove', text: 'a' }, { type: 'add', text: 'A' }],
    [{ type: 'remove', text: 'd' }, { type: 'add', text: 'D' }]
  ]);
  assert.deepEqual(r.lines, ['A', 'b', 'c', 'D']);
  const bad = applyGroups(['a'], [[{ type: 'remove', text: 'a' }], [{ type: 'remove', text: 'zzz' }]]);
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('hunk 2'));
});

test('qw11: tool aplica patch real multi-archivo', async () => {
  wfile('a.txt', 'hola\nmundo\n');
  wfile('c.txt', 'borrame\n');
  const r = await tool.execute({
    patch: [
      '*** Begin Patch',
      '*** Update File: a.txt',
      ' hola',
      '-mundo',
      '+tierra',
      '*** Add File: sub/b.txt',
      '+nuevo',
      '*** Delete File: c.txt',
      '*** End Patch'
    ].join('\n')
  }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'a.txt'), 'utf8'), 'hola\ntierra\n');
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'sub/b.txt'), 'utf8'), 'nuevo\n');
  assert.equal(existsSync(path.join(TMPWS, 'acme', 'demo', 'c.txt')), false);
});

test('qw11: atómico — si un archivo falla, NINGUNO se toca', async () => {
  wfile('ok.txt', 'uno\ndos\n');
  wfile('otro.txt', 'aaa\n');
  const r = await tool.execute({
    patch: [
      '*** Begin Patch',
      '*** Update File: ok.txt',
      ' uno',
      '-dos',
      '+DOS',
      '*** Update File: otro.txt',
      '-zzz-inexistente',
      '+nuevo',
      '*** End Patch'
    ].join('\n')
  }, ctx);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'ok.txt'), 'utf8'), 'uno\ndos\n', 'rollback: intacto');
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'otro.txt'), 'utf8'), 'aaa\n');
});

test('qw11: dry-run valida sin escribir + add existente falla', async () => {
  wfile('d.txt', 'x\n');
  const dry = await tool.execute({
    patch: '*** Begin Patch\n*** Update File: d.txt\n-x\n+X\n*** End Patch',
    dry_run: true
  }, ctx);
  assert.equal(dry.ok, true);
  assert.ok(dry.output.includes('dry-run'));
  assert.equal(readFileSync(path.join(TMPWS, 'acme', 'demo', 'd.txt'), 'utf8'), 'x\n', 'dry-run no escribe');
  const dup = await tool.execute({ patch: '*** Begin Patch\n*** Add File: d.txt\n+hola\n*** End Patch' }, ctx);
  assert.equal(dup.ok, false);
  assert.ok(dup.error.includes('ya existe'));
});

test('qw11: sandbox — traversal bloqueado', async () => {
  const r = await tool.execute({ patch: '*** Begin Patch\n*** Add File: ../../evil.txt\n+x\n*** End Patch' }, ctx);
  assert.equal(r.ok, false, 'safeWorkspacePath debe rechazar');
});
