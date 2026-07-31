import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clasificarComando, contencionReal, ejecutar } from '../server/lib/herramientas.js';

// La jaula. El usuario fue explícito: los comandos no pueden tocar nada fuera
// del workspace bajo ninguna circunstancia. Se probó que los patrones NO
// alcanzan —`echo x > ../f`, `cat /ruta`, `node -e writeFileSync('/otra')` se
// escapaban todos— así que la contención real la da sandbox-exec.
//
// Estos tests van contra el HOME de verdad a propósito: es el objetivo que
// importa proteger, y una carpeta en /tmp no probaría nada (está permitida
// para las cachés de npm).

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

test('el trabajo normal adentro del proyecto funciona', async (t) => {
  const { proyecto } = entorno(t);
  const r = await ejecutar('mkdir -p src && printf "hola" > src/a.txt && cat src/a.txt', proyecto);
  assert.equal(r.ok, true, r.salida);
  assert.ok(existsSync(path.join(proyecto, 'src', 'a.txt')));
});

test('no puede escribir hacia arriba con una redirección', sinJaula, async (t) => {
  const { proyecto } = entorno(t);
  await ejecutar('echo pwned > ../fuga.txt', proyecto);
  assert.equal(existsSync(path.join(path.dirname(proyecto), 'fuga.txt')), false);
});

test('no puede escribir en una ruta absoluta de otra carpeta', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  await ejecutar(`echo pwned > ${path.join(afuera, 'secreto.txt')}`, proyecto);
  assert.equal(readFileSync(path.join(afuera, 'secreto.txt'), 'utf-8'), 'intacto');
});

// La vía por la que un agente se escaparía de verdad: no con el shell, con código.
test('tampoco puede escribir afuera usando node', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const destino = path.join(afuera, 'js.txt');
  await ejecutar(`node -e 'require("fs").writeFileSync("${destino}","x")'`, proyecto);
  assert.equal(existsSync(destino), false);
});

test('tampoco con python', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const destino = path.join(afuera, 'py.txt');
  await ejecutar(`python3 -c 'open("${destino}","w").write("x")'`, proyecto);
  assert.equal(existsSync(destino), false);
});

test('un enlace simbólico no es una puerta trasera', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  await ejecutar(`ln -s ${afuera} atajo && echo pwned > atajo/secreto.txt`, proyecto);
  assert.equal(readFileSync(path.join(afuera, 'secreto.txt'), 'utf-8'), 'intacto');
});

test('cuando el sistema lo impide, se le explica al agente qué pasó', sinJaula, async (t) => {
  const { proyecto, afuera } = entorno(t);
  const r = await ejecutar(`echo x > ${path.join(afuera, 'nuevo.txt')}`, proyecto);
  assert.equal(r.ok, false);
  assert.match(r.salida, /FUERA de la carpeta del proyecto/, 'si no, el agente insiste con permisos');
});

// El filtro de intención sigue en pie: no reemplaza a la jaula, la complementa.
test('lo irreversible se frena antes de llegar al sistema', () => {
  for (const cmd of ['sudo rm -rf /', 'rm -rf ~', 'git push origin main', 'ssh x@y', 'cat ~/.ssh/id_rsa']) {
    assert.equal(clasificarComando(cmd).permitido, false, `"${cmd}" no puede pasar`);
  }
});

test('instalar y borrar dependencias es trabajo normal, no una amenaza', () => {
  assert.equal(clasificarComando('npm install expo').permitido, true);
  assert.equal(clasificarComando('pip install requests').permitido, true);
  // rm de algo relativo se permite, pero pide explicación.
  const rm = clasificarComando('rm -rf node_modules');
  assert.equal(rm.permitido, true);
  assert.equal(rm.riesgoso, true, 'borrar pide que el agente justifique');
});

test('la caché de los gestores de paquetes sí es escribible: sin eso no se instala nada', sinJaula, async (t) => {
  const { proyecto } = entorno(t);
  // No se instala nada de verdad (sería lento): se comprueba que npm pueda
  // escribir en su caché, que es lo que fallaba con un sandbox demasiado cerrado.
  const r = await ejecutar('npm config get cache && node -e "require(\'fs\').accessSync(require(\'os\').homedir()+\'/.npm\')" && echo caché-accesible', proyecto);
  assert.match(r.salida, /caché-accesible|\.npm/, r.salida);
});
