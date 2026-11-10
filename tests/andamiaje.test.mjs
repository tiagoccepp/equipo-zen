import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  andamiar,
  comandoPedidoPorElUsuario,
  proyectoVacio,
  recetaPara,
  renderAndamiaje
} from '../server/lib/andamiaje.js';
import { detectarProyecto } from '../server/lib/native-build.js';

function carpeta(t, prefijo = 'equipo-and-') {
  const d = mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const escritorPara = (d) => async (rel, contenido) => {
  mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  writeFileSync(path.join(d, rel), contenido);
};

// Scaffolding is no longer advice: the engine runs it. Measured — out of 18
// projects, the only well-built app was the only one where the agent ran it
// alone. Asking for it was not enough.

test('each niche has its own way of being born', () => {
  for (const stack of ['web', 'movil-rn', 'android', 'python', 'automatizacion']) {
    const receta = recetaPara(stack);
    assert.ok(receta, `${stack} necesita andamiaje`);
    assert.ok(receta.cmd || receta.plantilla, `${stack} necesita un comando o una plantilla`);
    assert.ok(receta.que && receta.que.length > 10, `${stack} tiene que poder explicar qué creó`);
  }
});

test('a project with work inside is NOT scaffolded again', async (t) => {
  const d = carpeta(t);
  writeFileSync(path.join(d, 'index.html'), '<!doctype html><html></html>');
  assert.equal(proyectoVacio(d), false);
  const r = await andamiar(d, 'web', { escribir: escritorPara(d) });
  assert.equal(r.hecho, false);
  assert.equal(r.yaEstaba, true, 'no puede pisar el trabajo que ya está');
});

test('the log and the design do not count as a started project', async (t) => {
  const d = carpeta(t);
  writeFileSync(path.join(d, 'BITACORA.md'), '# Bitácora\n');
  writeFileSync(path.join(d, 'diseno.op'), '{}');
  writeFileSync(path.join(d, 'pantalla.png'), 'x');
  assert.equal(proyectoVacio(d), true, 'son artefactos de coordinación, no producto');
});

test('node_modules and build do not count either', async (t) => {
  const d = carpeta(t);
  mkdirSync(path.join(d, 'node_modules'));
  mkdirSync(path.join(d, 'build'));
  mkdirSync(path.join(d, '.venv'));
  assert.equal(proyectoVacio(d), true);
});

// What the user asked for wins over the default.
test('if the user named a command, theirs is used', () => {
  assert.equal(
    comandoPedidoPorElUsuario('quiero que lo hagas con `npm create vite@latest . -- --template react`'),
    'npm create vite@latest . -- --template react'
  );
  assert.match(
    comandoPedidoPorElUsuario('armalo con npx create-expo-app con expo-router') || '',
    /create-expo-app/
  );
});

test('a normal request is not mistaken for a command', () => {
  for (const texto of [
    'quiero una app de mates',
    'que se vea lindo y tenga un botón grande',
    'hola chicos como andan'
  ]) {
    assert.equal(comandoPedidoPorElUsuario(texto), null, `"${texto}" no es un comando`);
  }
});

test('Android is born with a Gradle project the engine recognizes as an app', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'android', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  assert.equal(detectarProyecto(d), 'android', 'tiene que ser una app Android de verdad');

  // Verified AGP 9 gotchas: Kotlin already ships, applying it separately breaks the build.
  const raiz = readFileSync(path.join(d, 'build.gradle.kts'), 'utf-8');
  assert.ok(!/kotlin\.android/.test(raiz), 'aplicar kotlin.android con AGP 9 rompe la build');
  assert.match(raiz, /com\.android\.application/);

  // The code package and the module namespace must match.
  const modulo = readFileSync(path.join(d, 'app/build.gradle.kts'), 'utf-8');
  const namespace = modulo.match(/namespace = "([^"]+)"/)?.[1];
  assert.ok(namespace, 'el módulo declara su namespace');
  assert.ok(existsSync(path.join(d, 'app/src/main/java', namespace.replace(/\./g, '/'), 'MainActivity.kt')));
});

test('Python is born with environment, entry point and declared dependencies', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'python', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  for (const f of ['main.py', 'pyproject.toml', 'requirements.txt']) {
    assert.ok(existsSync(path.join(d, f)), `falta ${f}`);
  }
  assert.match(readFileSync(path.join(d, 'main.py'), 'utf-8'), /__main__/, 'con su guard de entrada');
});

test('a flow is born with package.json even when the folder has a weird name', async (t) => {
  // `npm init` takes the folder name and fails if it is not a valid package
  // name: really happened with a folder starting with a dot.
  const d = carpeta(t, '.Raro Nombre ');
  const r = await andamiar(d, 'automatizacion', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  const pkg = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf-8'));
  assert.match(pkg.name, /^[a-z0-9-]+$/, `"${pkg.name}" tiene que ser un nombre npm válido`);
});

test('a niche without a recipe says so, it does not blow up', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'inventado', { escribir: escritorPara(d) });
  assert.equal(r.hecho, false);
  assert.match(r.motivo, /scaffolding/);
});

test('the agent is told NOT to redo what is already scaffolded', () => {
  const aviso = renderAndamiaje({ hecho: true, que: 'proyecto Expo', cmd: 'npx create-expo-app .' });
  assert.match(aviso, /YA ESTÁ ANDAMIADO/);
  assert.match(aviso, /NO lo rehagas/);
  assert.match(aviso, /create-expo-app/);
  // If nothing was scaffolded, no noise is added to the prompt.
  assert.equal(renderAndamiaje({ hecho: false }), '');
  assert.equal(renderAndamiaje(null), '');
});
