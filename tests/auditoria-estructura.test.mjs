import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { auditarApp } from '../scripts/auditar-app.mjs';
import { STACKS } from '../server/lib/playbooks.js';

// Structure audit: is what lives in the folder a well-built app?
// Everything is measured on real folders in a temp dir, never on workspace/,
// and by STACK, never by template name.

function carpeta(t, archivos) {
  const dir = mkdtempSync(path.join(tmpdir(), 'auditoria-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, contenido] of Object.entries(archivos)) {
    const completo = path.join(dir, rel);
    mkdirSync(path.dirname(completo), { recursive: true });
    writeFileSync(completo, contenido, 'utf-8');
  }
  return dir;
}

const falta = (r, aguja) => r.mal.some((m) => m.que.includes(aguja));
const grave = (r, aguja) => r.mal.some((m) => m.grave && m.que.includes(aguja));
const acta = (r) => `${r.veredicto}\n  OK: ${r.bien.join(' / ')}\n  MAL: ${r.mal.map((m) => m.que).join(' / ')}`;

const HTML_SANO = [
  '<!DOCTYPE html>',
  '<html lang="es"><head><meta charset="utf-8">',
  '<title>Menú de la casa</title>',
  '<meta name="description" content="El menú del día con precios y horarios de atención.">',
  '<style>:root{--fondo:#101a12;--texto:#eef5ef}body{background:var(--fondo);color:var(--texto)}</style>',
  '</head><body><h1>Menú de la casa</h1><p>Empanadas de carne cortada a cuchillo.</p></body></html>'
].join('\n');

const APP_JSON = JSON.stringify({ expo: { name: 'Contador', slug: 'contador' } });
const PKG_RN = JSON.stringify({ name: 'contador', dependencies: { expo: '~52.0.0', 'react-native': '0.76.5' } });

test('every declared niche has its auditor: a new one cannot pass silently', async (t) => {
  for (const stack of STACKS) {
    const dir = carpeta(t, { 'algo.txt': 'nada' });
    const r = await auditarApp(dir, stack);
    assert.ok(r.veredicto, `el nicho ${stack} tiene que devolver un veredicto`);
    assert.ok(!r.error, `el nicho ${stack} no tiene auditor: ${r.error}`);
  }
});

test('an empty folder is not a half-done app: nothing was delivered', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'auditoria-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await auditarApp(dir, 'web');
  assert.equal(r.veredicto, 'VACÍA', acta(r));
});

test('web: index.html with header, tokens and no broken references is well-built', async (t) => {
  const r = await auditarApp(carpeta(t, { 'index.html': HTML_SANO }), 'web');
  assert.equal(r.graves, 0, acta(r));
  assert.match(r.veredicto, /BIEN ARMADA/, acta(r));
});

test('web: a web without an entry point does not open, and documents are not the product', async (t) => {
  // The most common real case in workspace/: the run wrote PROYECTO.md,
  // a log and the tokens, and no product.
  const r = await auditarApp(carpeta(t, {
    'PROYECTO.md': '# Plan\n\nEtapas del trabajo.\n',
    'BITACORA.md': '- alguien dejó los tokens\n',
    'tokens.css': ':root{--fondo:#101a12}'
  }), 'web');
  assert.ok(grave(r, 'falta index.html'), acta(r));
  assert.equal(r.veredicto, 'NO ES UNA APP BIEN ARMADA', acta(r));
});

test('web: it relies on verify.js for broken HTML and missing references', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'index.html': HTML_SANO.replace('</body>', '<script src="app.js"></script><div>')
  }), 'web');
  assert.ok(grave(r, 'no existen'), acta(r));
  assert.ok(grave(r, 'balanceado'), acta(r));
});

test('web: without tokens.css or :root every block invents its own palette', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'index.html': HTML_SANO.replace(/<style>[\s\S]*?<\/style>/, '<style>body{background:#101a12}</style>')
  }), 'web');
  assert.ok(grave(r, 'no hay tokens.css ni un :root'), acta(r));
});

test('movil-rn: with manifest, entry point and mounted screens it is well-built', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'package.json': PKG_RN,
    'app.json': APP_JSON,
    'App.js': "import PantallaContador from './src/screens/PantallaContador';\nexport default function App(){ return <PantallaContador />; }\n",
    'src/screens/PantallaContador.jsx': "import { View, Text } from 'react-native';\nexport default function PantallaContador(){ return <View><Text>Mates de hoy</Text></View>; }\n",
    'theme.js': 'export const colores = { fondo: "#101a12" };\n'
  }), 'movil-rn');
  assert.equal(r.graves, 0, acta(r));
  assert.match(r.veredicto, /BIEN ARMADA/, acta(r));
});

test('movil-rn: src/ alone is not an app, it is the code folder of a missing app', async (t) => {
  // Exactly as it appeared in workspace/: the run wrote the screens and ran
  // out of steps before scaffolding the project.
  const r = await auditarApp(carpeta(t, {
    'src/screens/Principal.jsx': "import { View } from 'react-native';\nexport default () => <View />;\n"
  }), 'movil-rn');
  assert.ok(grave(r, 'falta package.json'), acta(r));
  assert.ok(grave(r, 'falta app.json'), acta(r));
  assert.equal(r.veredicto, 'NO ES UNA APP BIEN ARMADA', acta(r));
});

test('movil-rn: the entry point mounting no screen is the niche signature failure', async (t) => {
  // The app opens showing the Expo template while the work lives in
  // src/screens/. That is what the niche flow attacks head-on.
  const r = await auditarApp(carpeta(t, {
    'package.json': PKG_RN,
    'app.json': APP_JSON,
    'App.jsx': "import { View, Text } from 'react-native';\nexport default function App(){ return <View><Text>Open up App.jsx to start working</Text></View>; }\n",
    'src/screens/PantallaJuego.jsx': "import { View } from 'react-native';\nexport default () => <View />;\n"
  }), 'movil-rn');
  assert.ok(grave(r, 'no monta ninguna pantalla'), acta(r));
});

test('movil-rn: a web disguised as an app does not pass', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'package.json': PKG_RN,
    'app.json': APP_JSON,
    'App.jsx': "export default function App(){ return <div>hola</div>; }\n",
    'src/screens/Pantalla.jsx': "export default () => { document.title = 'x'; return <span>hola</span>; };\n"
  }), 'movil-rn');
  assert.ok(grave(r, 'HTML <'), acta(r));
  assert.ok(grave(r, 'browser APIs'), acta(r));
});

test('android: the module namespace must match the code package', async (t) => {
  const base = {
    'settings.gradle.kts': 'include(":app")',
    'app/src/main/AndroidManifest.xml': '<manifest><application><activity android:name=".MainActivity" /></application></manifest>',
    'app/src/main/java/com/equipo/app/MainActivity.kt': 'package com.equipo.app\n\nclass MainActivity\n',
    'app/src/main/java/com/equipo/app/ui/Tema.kt': 'package com.equipo.app.ui\n'
  };

  const bien = await auditarApp(carpeta(t, {
    ...base,
    'app/build.gradle.kts': 'android {\n    namespace = "com.equipo.app"\n    compileSdk = 36\n}\n'
  }), 'android');
  assert.equal(bien.graves, 0, acta(bien));

  const mal = await auditarApp(carpeta(t, {
    ...base,
    'app/build.gradle.kts': 'android {\n    namespace = "com.otra.cosa"\n    compileSdk = 36\n}\n'
  }), 'android');
  assert.ok(grave(mal, 'no coincide con el paquete del código'), acta(mal));
});

test('android: without a Gradle project there is no app to compile', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'app/src/main/java/com/equipo/app/MainActivity.kt': 'package com.equipo.app\nclass MainActivity\n'
  }), 'android');
  assert.ok(grave(r, 'settings.gradle.kts'), acta(r));
  assert.ok(grave(r, 'app/build.gradle.kts'), acta(r));
});

test('python: it really compiles, and a broken .py is flagged with file and line', async (t) => {
  const bien = await auditarApp(carpeta(t, {
    'main.py': 'def principal():\n    print("hola")\n\n\nif __name__ == "__main__":\n    principal()\n',
    'requirements.txt': '# sin dependencias externas\n'
  }), 'python');
  assert.equal(bien.graves, 0, acta(bien));
  assert.ok(bien.bien.some((b) => /compilan/.test(b)), acta(bien));

  const roto = await auditarApp(carpeta(t, {
    'main.py': 'def principal():\nprint("mal indentado")\n',
    'requirements.txt': '\n'
  }), 'python');
  assert.ok(roto.graves >= 1, acta(roto));
  assert.ok(roto.mal.some((m) => m.que.includes('main.py')), acta(roto));
});

test('python: without entry point or declared dependencies nobody knows what to run', async (t) => {
  const r = await auditarApp(carpeta(t, { 'src/util.py': 'def sumar(a, b):\n    return a + b\n' }), 'python');
  assert.ok(grave(r, 'no hay punto de entrada'), acta(r));
  assert.ok(grave(r, 'requirements.txt'), acta(r));
});

test('the declared niche rules: a web delivered in a mobile project fails as mobile', async (t) => {
  const dir = carpeta(t, { 'index.html': HTML_SANO });
  const comoMovil = await auditarApp(dir, 'movil-rn');
  assert.equal(comoMovil.veredicto, 'NO ES UNA APP BIEN ARMADA', acta(comoMovil));
  const comoWeb = await auditarApp(dir, 'web');
  assert.match(comoWeb.veredicto, /BIEN ARMADA/, acta(comoWeb));
});

test('without a declared niche it is inferred from the contents, and disclosed', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'package.json': PKG_RN,
    'app.json': APP_JSON,
    'App.js': "import P from './src/screens/P';\nexport default () => <P />;\n",
    'src/screens/P.jsx': "import { View } from 'react-native';\nexport default () => <View />;\n"
  }));
  assert.equal(r.stack, 'movil-rn', acta(r));
  assert.equal(r.stackDeducido, 'movil-rn', 'tiene que quedar dicho que el nicho se dedujo');
});

test('build intermediates are not audited: they would ruin the measurement', async (t) => {
  const r = await auditarApp(carpeta(t, {
    'index.html': HTML_SANO,
    'node_modules/algo/roto.js': 'function ( {',
    'build/intermedio.js': 'function ( {',
    '.expo/cache.js': 'function ( {'
  }), 'web');
  assert.equal(r.graves, 0, acta(r));
  assert.ok(!r.archivos.some((rel) => /node_modules|build|\.expo/.test(rel)), r.archivos.join(', '));
});
