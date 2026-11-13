#!/usr/bin/env node
// E-23: verifica un update (.deb) contra firma detached (minisign u openssl).
// Uso: node scripts/verify-update.mjs <archivo> <firma> [--pubkey <pub>]
//   minisign: verify-update.mjs Equipo.deb Equipo.deb.minisig
//   openssl:  verify-update.mjs Equipo.deb Equipo.deb.sig --pubkey update-pub.pem
// Exit 0 = firma válida; 1 = inválida/error. Pensado para correr ANTES de
// instalar (release process en research/threat-model-2026-11-10.md §updates).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [, , file, sig, ...rest] = process.argv;
const pubIdx = rest.indexOf('--pubkey');
const pubkey = pubIdx !== -1 ? rest[pubIdx + 1] : (process.env.EQUIPO_UPDATE_PUBKEY || '');

function fail(msg) {
  console.error(`verify-update: ${msg}`);
  process.exit(1);
}

if (!file || !sig) {
  fail('uso: verify-update.mjs <archivo> <firma> [--pubkey <pub>]');
}
if (!existsSync(file)) {
  fail(`no existe: ${file}`);
}
if (!existsSync(sig)) {
  fail(`no existe: ${sig}`);
}

const which = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;

// minisign primero (formato minisig o -x): 1 comando, sin pubkey inline.
if (which('minisign') && !pubkey) {
  const pub = process.env.EQUIPO_MINISIGN_PUBKEY || '';
  if (!pub) {
    fail('minisign necesita EQUIPO_MINISIGN_PUBKEY (o pasá --pubkey para openssl)');
  }
  const r = spawnSync('minisign', ['-Vm', file, '-p', pub, '-x', sig], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`verify-update: OK (minisign) ${file}`);
    process.exit(0);
  }
  fail(`firma minisign inválida: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
}

if (!pubkey) {
  fail('openssl necesita --pubkey <update-pub.pem>');
}
if (!existsSync(pubkey)) {
  fail(`pubkey inexistente: ${pubkey}`);
}
if (!which('openssl')) {
  fail('ni minisign ni openssl disponibles');
}
// openssl dgst -sha256 -verify pub.pem -signature sig file
const r = spawnSync('openssl', ['dgst', '-sha256', '-verify', pubkey, '-signature', sig, file], { encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`;
if (r.status === 0 && /verified ok/i.test(out)) {
  console.log(`verify-update: OK (openssl) ${file}`);
  process.exit(0);
}
fail(`firma openssl inválida: ${out.slice(0, 200)}`);
