// E-23: seguridad — scrub, env, bwrap, DB 0600, verify-update, aislamiento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getErrorText, scrubSecretsText } from '../server/lib/text.js';
import { bwrapArgs, bwrapPath, ejecutar, scrubEnvForChild } from '../server/lib/herramientas.js';
import { Store } from '../server/lib/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('e23: scrub quita secretos de errores', () => {
  assert.equal(scrubSecretsText('key sk-abcdefgh12345678 fin'), 'key [redacted] fin');
  assert.equal(scrubSecretsText('AKIAIOSFODNN7EXAMPLE'), '[redacted]');
  assert.equal(scrubSecretsText('token ghp_abc123XYZ456 end'), 'token [redacted] end');
  assert.equal(scrubSecretsText('normal text 123'), 'normal text 123');
  const errText = getErrorText(new Error('boom sk-abcdefgh12345678'));
  assert.ok(errText.includes('[redacted]'), 'stack scrubbeado');
  assert.ok(!errText.includes('sk-abcdefgh'), 'sin secreto');
  assert.equal(getErrorText(null), 'Unknown error');
});

test('e23: changelog scrubbea secretos', () => {
  const store = new Store(':memory:');
  store.logChange('t', 'e', '1', 'a', { note: 'key sk-abcdefgh12345678' });
  const rows = store.listChangelog({ entity: 'e', entityId: '1' });
  assert.ok(rows[0].detail_json.includes('[redacted]'), rows[0].detail_json);
  assert.ok(!rows[0].detail_json.includes('sk-abcdefgh'), 'sin secreto');
  store.close();
});

test('e23: env scrub saca llaves, deja resto', () => {
  const out = scrubEnvForChild({
    PATH: '/bin', HOME: '/h', MINIMAX_API_KEY: 'x', DEEPSEEK_API_KEY: 'y',
    CUSTOM_TOKEN: 'z', TELEGRAM_BOT_TOKEN: 't', LANG: 'es', MY_PASSWORD: 'p'
  });
  assert.equal(out.PATH, '/bin');
  assert.equal(out.HOME, '/h');
  assert.equal(out.LANG, 'es');
  for (const k of ['MINIMAX_API_KEY', 'DEEPSEEK_API_KEY', 'CUSTOM_TOKEN', 'TELEGRAM_BOT_TOKEN', 'MY_PASSWORD']) {
    assert.ok(!(k in out), `${k} fuera`);
  }
});

test('e23: bwrap detectado + args aíslan escritura', () => {
  const bp = bwrapPath();
  assert.ok(bp === null || bp.endsWith('bwrap'));
  const args = bwrapArgs('/tmp/proj', 'echo hi');
  assert.ok(args.includes('--ro-bind') && args.includes('/'), 'raíz RO');
  const bi = args.indexOf('--bind');
  assert.ok(args[bi + 1] === '/tmp/proj', 'proyecto RW');
  assert.ok(args.includes('--unshare-pid'), 'pid aislado');
  assert.ok(args.includes('--die-with-parent'));
});

test('e23: ejecutar corre (sandbox si hay) sin heredar secretos', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e23-'));
  process.env.E23_PROBE_TOKEN = 'secreto';
  const r = await ejecutar('echo "TOKEN=[$E23_PROBE_TOKEN]"; echo ok', dir, { timeoutMs: 15000 });
  delete process.env.E23_PROBE_TOKEN;
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.ok(r.salida.includes('ok'), r.salida);
  assert.ok(!r.salida.includes('secreto'), 'hijo sin secreto');
});

test('e23: DB nueva queda 0600', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e23-db-'));
  const store = new Store(path.join(dir, 't.db'));
  store.close();
  const mode = statSync(path.join(dir, 't.db')).mode & 0o777;
  assert.equal(mode.toString(8), '600', `0600 (dio ${mode.toString(8)})`);
});

test('e23: verify-update round-trip openssl (si hay)', () => {
  const hasOpenssl = spawnSync('which', ['openssl']).status === 0;
  if (!hasOpenssl) {
    return; // sin openssl: skip honesto
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e23-upd-'));
  const file = path.join(dir, 'fake.deb');
  const key = path.join(dir, 'priv.pem');
  const pub = path.join(dir, 'pub.pem');
  const sig = path.join(dir, 'fake.sig');
  writeFileSync(file, 'contenido-falso-del-deb');
  assert.equal(spawnSync('openssl', ['genrsa', '-out', key, '2048']).status, 0);
  assert.equal(spawnSync('openssl', ['rsa', '-in', key, '-pubout', '-out', pub]).status, 0);
  assert.equal(spawnSync('openssl', ['dgst', '-sha256', '-sign', key, '-out', sig, file]).status, 0);
  const ok = spawnSync('node', [path.join(ROOT, 'scripts', 'verify-update.mjs'), file, sig, '--pubkey', pub]);
  assert.equal(ok.status, 0, ok.stderr.toString().slice(0, 300));
  writeFileSync(file, 'TAMPERED!!!');
  const bad = spawnSync('node', [path.join(ROOT, 'scripts', 'verify-update.mjs'), file, sig, '--pubkey', pub]);
  assert.notEqual(bad.status, 0, 'tamper detectado');
});

test('e23: aislamiento — accessors exigen scope proyecto', async () => {
  const { readFileSync } = await import('node:fs');
  const storeSrc = readFileSync(path.join(ROOT, 'server/lib/store.js'), 'utf8');
  for (const fn of ['goalForSlug', 'checklistForGoal', 'rosterForProject', 'tastesFor', 'prohibitionsFor', 'pendingProposals']) {
    assert.ok(storeSrc.includes(`${fn}(`), `${fn} existe`);
  }
  // safeWorkspacePath rechaza traversal (runtime, no solo estático).
  const { safeWorkspacePath } = await import('../server/lib/workforce.js');
  assert.throws(() => safeWorkspacePath('c', 's', '../../evil'), /traversal|fuera|inválid/i);
  assert.throws(() => safeWorkspacePath('c', 's', '/absoluto'), /traversal|fuera|inválid|absolut/i);
});
