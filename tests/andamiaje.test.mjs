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

// El andamiaje dejó de ser un consejo: lo corre el motor. Está medido — de 18
// proyectos, la única app bien armada fue la única donde el agente lo corrió
// solo. Pedírselo no alcanzaba.

test('cada nicho tiene su forma de nacer', () => {
  for (const stack of ['web', 'movil-rn', 'android', 'python', 'automatizacion']) {
    const receta = recetaPara(stack);
    assert.ok(receta, `${stack} necesita andamiaje`);
    assert.ok(receta.cmd || receta.plantilla, `${stack} necesita un comando o una plantilla`);
    assert.ok(receta.que && receta.que.length > 10, `${stack} tiene que poder explicar qué creó`);
  }
});

test('un proyecto con trabajo adentro NO se vuelve a andamiar', async (t) => {
  const d = carpeta(t);
  writeFileSync(path.join(d, 'index.html'), '<!doctype html><html></html>');
  assert.equal(proyectoVacio(d), false);
  const r = await andamiar(d, 'web', { escribir: escritorPara(d) });
  assert.equal(r.hecho, false);
  assert.equal(r.yaEstaba, true, 'no puede pisar el trabajo que ya está');
});

test('la bitácora y el diseño no cuentan como proyecto empezado', async (t) => {
  const d = carpeta(t);
  writeFileSync(path.join(d, 'BITACORA.md'), '# Bitácora\n');
  writeFileSync(path.join(d, 'diseno.op'), '{}');
  writeFileSync(path.join(d, 'pantalla.png'), 'x');
  assert.equal(proyectoVacio(d), true, 'son artefactos de coordinación, no producto');
});

test('node_modules y build tampoco cuentan', async (t) => {
  const d = carpeta(t);
  mkdirSync(path.join(d, 'node_modules'));
  mkdirSync(path.join(d, 'build'));
  mkdirSync(path.join(d, '.venv'));
  assert.equal(proyectoVacio(d), true);
});

// Lo que pidió el usuario manda sobre el default.
test('si el usuario nombró un comando, se usa el suyo', () => {
  assert.equal(
    comandoPedidoPorElUsuario('quiero que lo hagas con `npm create vite@latest . -- --template react`'),
    'npm create vite@latest . -- --template react'
  );
  assert.match(
    comandoPedidoPorElUsuario('armalo con npx create-expo-app con expo-router') || '',
    /create-expo-app/
  );
});

test('un pedido normal no se confunde con un comando', () => {
  for (const texto of [
    'quiero una app de mates',
    'que se vea lindo y tenga un botón grande',
    'hola chicos como andan'
  ]) {
    assert.equal(comandoPedidoPorElUsuario(texto), null, `"${texto}" no es un comando`);
  }
});

test('Android nace con un proyecto Gradle que el motor reconoce como app', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'android', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  assert.equal(detectarProyecto(d), 'android', 'tiene que ser una app Android de verdad');

  // Las trampas verificadas de AGP 9: Kotlin ya viene, aplicarlo aparte rompe.
  const raiz = readFileSync(path.join(d, 'build.gradle.kts'), 'utf-8');
  assert.ok(!/kotlin\.android/.test(raiz), 'aplicar kotlin.android con AGP 9 rompe la build');
  assert.match(raiz, /com\.android\.application/);

  // El paquete del código y el namespace del módulo tienen que coincidir.
  const modulo = readFileSync(path.join(d, 'app/build.gradle.kts'), 'utf-8');
  const namespace = modulo.match(/namespace = "([^"]+)"/)?.[1];
  assert.ok(namespace, 'el módulo declara su namespace');
  assert.ok(existsSync(path.join(d, 'app/src/main/java', namespace.replace(/\./g, '/'), 'MainActivity.kt')));
});

test('Python nace con entorno, punto de entrada y dependencias declaradas', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'python', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  for (const f of ['main.py', 'pyproject.toml', 'requirements.txt']) {
    assert.ok(existsSync(path.join(d, f)), `falta ${f}`);
  }
  assert.match(readFileSync(path.join(d, 'main.py'), 'utf-8'), /__main__/, 'con su guard de entrada');
});

test('un flujo nace con package.json aunque la carpeta tenga un nombre raro', async (t) => {
  // `npm init` toma el nombre de la carpeta y falla si no es un nombre válido
  // de paquete: pasó de verdad con una carpeta que empezaba con punto.
  const d = carpeta(t, '.Raro Nombre ');
  const r = await andamiar(d, 'automatizacion', { escribir: escritorPara(d) });
  assert.equal(r.hecho, true, r.motivo);
  const pkg = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf-8'));
  assert.match(pkg.name, /^[a-z0-9-]+$/, `"${pkg.name}" tiene que ser un nombre npm válido`);
});

test('un nicho sin receta lo dice, no explota', async (t) => {
  const d = carpeta(t);
  const r = await andamiar(d, 'inventado', { escribir: escritorPara(d) });
  assert.equal(r.hecho, false);
  assert.match(r.motivo, /scaffolding/);
});

test('al agente se le dice que NO rehaga lo que ya está andamiado', () => {
  const aviso = renderAndamiaje({ hecho: true, que: 'proyecto Expo', cmd: 'npx create-expo-app .' });
  assert.match(aviso, /YA ESTÁ ANDAMIADO/);
  assert.match(aviso, /NO lo rehagas/);
  assert.match(aviso, /create-expo-app/);
  // Si no se andamió, no se le mete ruido en el prompt.
  assert.equal(renderAndamiaje({ hecho: false }), '');
  assert.equal(renderAndamiaje(null), '');
});
