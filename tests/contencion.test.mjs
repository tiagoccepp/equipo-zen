import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clasificarComando, contencionReal, ejecutar } from '../server/lib/herramientas.js';

// The cage. The user was explicit: commands cannot touch anything outside
// the workspace under any circumstance. Patterns were proven NOT to be
// enough —`echo x > ../f`, `cat /ruta`, `node -e writeFileSync('/otra')` all
// escaped— so the real containment comes from sandbox-exec.
//
// These tests run against the real HOME on purpose: it is the target that
// matters to protect, and a folder in /tmp would prove nothing (it is allowed
// for npm caches).

function entorno(t) {
  const proyecto = mkdtempSync(path.join(os.homedir(), '.equipo-test-ws-'));
  const afuera = mkdtempSync(path.join(os.homedir(), '.equipo-test-fuera-'));
  writeFileSync(path.join(afuera, 'secreto.txt'), 'intacto');
  t.after(() => {
    rmSync(proyecto, { recursive: true, force: true });
    rmSync(afuera, { recursive: true, force: true });
  });
  return { proyecto, afuera };
}

const sinJaula = { skip: contencionReal() ? false : 'sin sandbox-exec en esta plataforma' };

test('normal work inside the project works', async (t) => {
  const { proyecto } = entorno(t);
  const r = await ejecutar('mkdir -p src && printf "hola" > src/a.txt && cat src/a.txt', proyecto);
  assert.equal(r.ok, true, r.salida);
  assert.ok(existsSync(path.join(proyecto, 'src', 'a.txt')));
});

test('cannot write upward with a redirect', sinJaula, async (t) => {
  const { proyecto } = entorno(t);
  await ejecutar('echo pwned > ../fuga.txt', proyecto);
  assert.equal(existsSync(path.join(path.dirname(proyecto), 'fuga.txt')), false);
});

test('cannot write to an absolute path in another folder', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  await ejecutar(`echo pwned > ${path.join(afuera, 'secreto.txt')}`, proyecto);
  assert.equal(readFileSync(path.join(afuera, 'secreto.txt'), 'utf-8'), 'intacto');
});

// The route an agent would really escape through: not with the shell, with code.
test('cannot write outside using node either', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const destino = path.join(afuera, 'js.txt');
  await ejecutar(`node -e 'require("fs").writeFileSync("${destino}","x")'`, proyecto);
  assert.equal(existsSync(destino), false);
});

test('nor with python', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const destino = path.join(afuera, 'py.txt');
  await ejecutar(`python3 -c 'open("${destino}","w").write("x")'`, proyecto);
  assert.equal(existsSync(destino), false);
});

test('a symlink is not a back door', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  await ejecutar(`ln -s ${afuera} atajo && echo pwned > atajo/secreto.txt`, proyecto);
  assert.equal(readFileSync(path.join(afuera, 'secreto.txt'), 'utf-8'), 'intacto');
});

test('when the system blocks it, the agent gets an explanation of what happened', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const r = await ejecutar(`echo x > ${path.join(afuera, 'nuevo.txt')}`, proyecto);
  assert.equal(r.ok, false);
  assert.match(r.salida, /FUERA de la carpeta del proyecto/, 'si no, el agente insiste con permisos');
});

// The intent filter still stands: it does not replace the cage, it complements it.
test('the irreversible is stopped before reaching the system', () => {
  for (const cmd of ['sudo rm -rf /', 'rm -rf ~', 'git push origin main', 'ssh x@y', 'cat ~/.ssh/id_rsa']) {
    assert.equal(clasificarComando(cmd).permitido, false, `"${cmd}" no puede pasar`);
  }
});

test('installing and deleting dependencies is normal work, not a threat', () => {
  assert.equal(clasificarComando('npm install expo').permitido, true);
  assert.equal(clasificarComando('pip install requests').permitido, true);
  // rm of something relative is allowed, but asks for justification.
  const rm = clasificarComando('rm -rf node_modules');
  assert.equal(rm.permitido, true);
  assert.equal(rm.riesgoso, true, 'borrar pide que el agente justifique');
});

test("the package managers' cache IS writable: without that nothing installs", sinJaula, async (t) => {
  const { proyecto } = entorno(t);
  // Nothing is really installed (it would be slow): it checks that npm can
  // write to its cache, which is what failed with an over-tight sandbox.
  const r = await ejecutar('npm config get cache && node -e "require(\'fs\').accessSync(require(\'os\').homedir()+\'/.npm\')" && echo caché-accesible', proyecto);
  assert.match(r.salida, /caché-accesible|\.npm/, r.salida);
});
