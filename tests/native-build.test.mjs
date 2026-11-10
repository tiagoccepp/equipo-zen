import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  detectarProyecto,
  parsearErroresKotlin,
  renderBuildReport,
  revisarReactNative
} from '../server/lib/native-build.js';

function carpeta() {
  return mkdtempSync(path.join(tmpdir(), 'equipo-nativa-'));
}

test('recognizes an Android project by its Gradle file', () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'settings.gradle.kts'), 'rootProject.name = "app"');
  assert.equal(detectarProyecto(dir), 'android');
  rmSync(dir, { recursive: true, force: true });
});

test('recognizes a React Native project by its entry point', () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'package.json'), '{}');
  writeFileSync(path.join(dir, 'App.jsx'), 'export default () => null;');
  assert.equal(detectarProyecto(dir), 'react-native');
  rmSync(dir, { recursive: true, force: true });
});

test('a folder with an index.html is not a mobile project', () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>');
  assert.equal(detectarProyecto(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

// The mistake that motivated all of this: shipping a web page and calling it an app.
test('a web page disguised as a mobile app is rejected', async () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
  writeFileSync(path.join(dir, 'App.jsx'), 'export default () => <div><h1>Hola</h1></div>;');

  const r = await revisarReactNative(dir);
  assert.equal(r.ok, false);
  const texto = r.errores.map((e) => e.que).join(' | ');
  assert.match(texto, /missing the react-native dependency/);
  assert.match(texto, /HTML <(h1|div)>/);
  rmSync(dir, { recursive: true, force: true });
});

test('browser APIs do not exist in a mobile app', async () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.75' } }));
  writeFileSync(path.join(dir, 'app.json'), '{"name":"app"}');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'Pantalla.jsx'), 'const guardar = () => localStorage.setItem("a", 1);');

  const r = await revisarReactNative(dir);
  assert.equal(r.ok, false);
  assert.match(r.errores.map((e) => e.que).join(' '), /browser APIs/);
  rmSync(dir, { recursive: true, force: true });
});

test('a well-formed React Native app passes', async () => {
  const dir = carpeta();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { react: '18.3.1', 'react-native': '0.75.4', expo: '~51.0.0' }
  }));
  writeFileSync(path.join(dir, 'app.json'), '{"expo":{"name":"Turnos","slug":"turnos"}}');
  writeFileSync(path.join(dir, 'App.jsx'), [
    "import { View, Text, Pressable, FlatList } from 'react-native';",
    'export default function App() {',
    '  return <View><Text>Turnos</Text></View>;',
    '}'
  ].join('\n'));

  assert.deepEqual(await revisarReactNative(dir), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test('Kotlin compiler errors come out with file and line', () => {
  const errores = parsearErroresKotlin([
    'e: file:///p/app/src/main/java/MainActivity.kt:17:2 Syntax error: Missing \'}\'.',
    'e: file:///p/app/src/main/java/ui/Home.kt:5:9 Unresolved reference: Modifier'
  ].join('\n'));

  assert.equal(errores.length, 2);
  assert.equal(errores[0].archivo, 'MainActivity.kt');
  assert.equal(errores[0].linea, 17);
  assert.match(errores[1].que, /Unresolved reference/);
});

test('a Gradle failure without Kotlin errors still returns something useful', () => {
  const errores = parsearErroresKotlin([
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    '> Failed to apply plugin.',
    '   > Cannot add extension with name \'kotlin\'.',
    '* Try:',
    '> Run with --stacktrace option to get the stack trace.'
  ].join('\n'));

  const texto = errores.map((e) => e.que).join(' ');
  assert.match(texto, /Cannot add extension|Failed to apply plugin/);
  assert.ok(!/--stacktrace/.test(texto), 'la ayuda de Gradle no es un error del agente');
});

test('the report tells the agent to fix before closing', () => {
  const informe = renderBuildReport({
    tipo: 'android',
    ok: false,
    errores: [{ archivo: 'MainActivity.kt', linea: 17, que: "Missing '}'" }]
  });
  assert.match(informe, /NO COMPILA/);
  assert.match(informe, /MainActivity\.kt:17/);
  assert.match(informe, /finish/);
});

test('if it compiled there is no report', () => {
  assert.equal(renderBuildReport({ tipo: 'android', ok: true }), '');
  assert.equal(renderBuildReport({ saltado: true, motivo: 'sin SDK' }), '');
});
