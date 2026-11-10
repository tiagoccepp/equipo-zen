import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { companyTemplates } from '../server/lib/config.js';
import { Store } from '../server/lib/store.js';
import {
  construirApp,
  detectarProyecto,
  parsearErroresKotlin,
  renderBuildReport,
  revisarReactNative
} from '../server/lib/native-build.js';
import {
  WORKSPACE_ROOT,
  esProyectoMovil,
  projectDir,
  safeWorkspacePath
} from '../server/lib/workforce.js';

// What the user asked the company for was an APP: something installed on the
// phone, not a page. These tests are about that promise — that the system
// tells an app from a web page, says it in words the team understands,
// and meanwhile does not let it write outside its folder.

const keyRing = { hasKeys: () => true };

// A company from a concrete niche, without depending on template names:
// picked by stack, which is what defines whether the deliverable must compile.
function nuevaEmpresa(stack) {
  const store = new Store(':memory:');
  const template = companyTemplates.templates.find((t) => t.stack === stack);
  assert.ok(template, `hay una plantilla de nicho ${stack}`);
  const company = store.createCompanyFromTemplate(template, 'test');
  assert.ok(keyRing.hasKeys());
  return { store, company };
}

// The real project folder, the same one the engine uses. The company's whole
// folder is deleted at the end: the workspace stays as it was.
function carpetaDelProyecto(t, company, project) {
  const dir = projectDir(company.id, project.slug);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(path.join(WORKSPACE_ROOT, company.id), { recursive: true, force: true }));
  return dir;
}

// Write like an employee writes: going through the sandbox guard.
function escribir(company, project, relativo, contenido) {
  const destino = safeWorkspacePath(company.id, project.slug, relativo);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
  return destino;
}

test('the Android studio ships a Gradle project and the engine treats it as an app, not a site', (t) => {
  const { store, company } = nuevaEmpresa('android');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  // The project inherits the niche: nobody had to clarify it is an app.
  assert.equal(project.stack, 'android');
  assert.equal(esProyectoMovil(project.stack), true, 'lo que entreguen tiene que compilar, no verse');

  escribir(company, project, 'settings.gradle.kts', 'rootProject.name = "turnos"\ninclude(":app")');
  escribir(company, project, 'app/build.gradle.kts', 'plugins { id("com.android.application") }');
  escribir(company, project, 'app/src/main/java/com/club/MainActivity.kt', 'class MainActivity');

  assert.equal(detectarProyecto(dir), 'android');
});

test('a React Native app is recognized by its entry point: package.json alone is not enough', (t) => {
  const { store, company } = nuevaEmpresa('movil-rn');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  assert.equal(project.stack, 'movil-rn');
  escribir(company, project, 'package.json', JSON.stringify({ dependencies: { 'react-native': '0.75.4' } }));
  assert.equal(detectarProyecto(dir), null, 'un package.json suelto todavía no es una app');

  const entrada = escribir(company, project, 'App.jsx', "import { View } from 'react-native';");
  assert.equal(detectarProyecto(dir), 'react-native');

  // The same team, another day, writes the entry point without JSX in the name.
  rmSync(entrada);
  escribir(company, project, 'App.js', "import { View } from 'react-native';");
  assert.equal(detectarProyecto(dir), 'react-native', 'App.js también es un punto de entrada válido');
});

test('a web project with its index.html does not go through the app compiler', (t) => {
  const { store, company } = nuevaEmpresa('web');
  const project = store.createProject({ companyId: company.id, title: 'Landing del club' });
  const dir = carpetaDelProyecto(t, company, project);

  escribir(company, project, 'index.html', '<!doctype html><html lang="es"><body><h1>Club</h1></body></html>');
  escribir(company, project, 'estilos.css', ':root { --fondo: #101014; }');

  assert.equal(esProyectoMovil(project.stack), false, 'el motor ni siquiera llama al compilador de apps');
  assert.equal(detectarProyecto(dir), null, 'una carpeta con index.html no es un proyecto móvil');
});

test('if they ship a web page disguised as an app, the rejection says which file it is and what goes instead of the div', async (t) => {
  const { store, company } = nuevaEmpresa('movil-rn');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  escribir(company, project, 'package.json', JSON.stringify({ dependencies: { react: '18.3.1' } }));
  escribir(company, project, 'App.jsx', 'export default () => <div><h1>Turnos</h1></div>;');

  const revision = await revisarReactNative(dir);
  assert.equal(revision.ok, false, 'esto no se puede instalar en un celular');

  const texto = revision.errores.map((e) => `${e.archivo}: ${e.que}`).join('\n');
  assert.match(texto, /missing the react-native dependency/, 'dice qué le falta al package.json');
  assert.match(texto, /missing app\.json/, 'dice que sin app.json la app no tiene ni nombre ni ícono');
  assert.match(texto, /App\.jsx/, 'dice en qué archivo está el problema');
  assert.match(texto, /HTML <(div|h1)>/, 'nombra la etiqueta que no va');
  assert.match(texto, /View, Text, Pressable/, 'y dice qué usar en su lugar');

  const informe = renderBuildReport({ tipo: 'react-native', ok: false, errores: revision.errores });
  assert.match(informe, /NO ES UNA APP MÓVIL VÁLIDA/);
  assert.match(informe, /arreglalo con edit_file/i);
  assert.match(informe, /finish/, 'no puede cerrar la tarea hasta arreglarlo');
});

test('saving to localStorage does not work on a phone and the team finds out before closing the task', async (t) => {
  const { store, company } = nuevaEmpresa('movil-rn');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  escribir(company, project, 'package.json', JSON.stringify({
    dependencies: { react: '18.3.1', 'react-native': '0.75.4', expo: '~51.0.0' }
  }));
  escribir(company, project, 'app.json', JSON.stringify({ expo: { name: 'Turnos', slug: 'turnos' } }));
  escribir(company, project, 'App.jsx', [
    "import { View, Text } from 'react-native';",
    'export default function App() {',
    '  return <View><Text>Turnos del club</Text></View>;',
    '}'
  ].join('\n'));
  const guardado = escribir(company, project, 'src/almacenamiento.js', [
    'export function guardarTurno(turno) {',
    '  localStorage.setItem("turno", JSON.stringify(turno));',
    '}'
  ].join('\n'));

  const revision = await revisarReactNative(dir);
  assert.equal(revision.ok, false);
  const culpable = revision.errores.find((e) => /browser APIs/.test(e.que));
  assert.ok(culpable, 'el rechazo explica que esas APIs no existen en una app móvil');
  assert.equal(culpable.archivo, path.join('src', 'almacenamiento.js'), 'y señala el archivo exacto');

  // With the guilty file removed, the same app passes: no false positives
  // sending the team to break code that was fine.
  rmSync(guardado);
  assert.deepEqual(await revisarReactNative(dir), { ok: true });
});

test('when the Android app does not compile, the team gets file and line, not the whole Gradle log', () => {
  const salida = [
    '> Task :app:preBuild UP-TO-DATE',
    '> Task :app:compileDebugKotlin FAILED',
    'e: file:///Users/nino/Equipo/workspace/emp/turnos/app/src/main/java/com/club/MainActivity.kt:17:9 Unresolved reference: Modifier',
    "e: file:///Users/nino/Equipo/workspace/emp/turnos/app/src/main/java/com/club/ui/Pantalla.kt:42:5 Expecting '}'",
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    "Execution failed for task ':app:compileDebugKotlin'.",
    '> Compilation error. See log for more details',
    '* Try:',
    '> Run with --stacktrace option to get the stack trace.',
    'BUILD FAILED in 12s'
  ].join('\n');

  const errores = parsearErroresKotlin(salida);
  const conLinea = errores.filter((e) => e.linea !== null);
  assert.deepEqual(conLinea.map((e) => [e.archivo, e.linea]), [['MainActivity.kt', 17], ['Pantalla.kt', 42]]);
  assert.match(conLinea[0].que, /Unresolved reference: Modifier/);

  const todo = errores.map((e) => e.que).join(' ');
  assert.ok(!/--stacktrace/.test(todo), 'la ayuda de Gradle no es un error para arreglar');
  assert.ok(!/UP-TO-DATE|Task :app/.test(todo), 'las tareas de Gradle no son errores');

  const informe = renderBuildReport({ tipo: 'android', ok: false, errores });
  assert.match(informe, /NO COMPILA/);
  assert.match(informe, /MainActivity\.kt:17/, 'el agente sabe adónde ir a arreglar');
  assert.match(informe, /Pantalla\.kt:42/);
  assert.match(informe, /finish/);
});

test('the team can write the whole native project, but nothing outside the project folder', (t) => {
  const { store, company } = nuevaEmpresa('android');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  // All of this is a mobile niche's deliverable: if the sandbox blocks it,
  // the app does not exist.
  const delProyecto = [
    'settings.gradle.kts',
    'build.gradle.kts',
    'gradle.properties',
    'gradle/wrapper/gradle-wrapper.properties',
    'gradlew',
    'app/build.gradle.kts',
    'app/proguard-rules.pro',
    'app/src/main/AndroidManifest.xml',
    'app/src/main/java/com/club/MainActivity.kt',
    'app/src/main/java/com/club/ui/Tema.kt',
    'app/src/main/res/values/strings.xml',
    'App.jsx',
    'app.json',
    'src/screens/Turnos.tsx',
    'src/theme.js'
  ];
  for (const relativo of delProyecto) {
    const destino = safeWorkspacePath(company.id, project.slug, relativo);
    assert.ok(destino.startsWith(dir + path.sep), `${relativo} tiene que caer dentro del proyecto`);
  }

  // And what is nobody's deliverable stays out.
  assert.throws(() => safeWorkspacePath(company.id, project.slug, '../../../etc/passwd'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath(company.id, project.slug, '/etc/passwd'), /inválida/);
  assert.throws(() => safeWorkspacePath(company.id, project.slug, 'app/../../fuera.kt'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath(company.id, project.slug, '.ssh/config'), /fuera del proyecto/);
  assert.throws(() => safeWorkspacePath(company.id, project.slug, 'app/libs/exploit.jar'), /Extensión no permitida/);
  assert.throws(() => safeWorkspacePath(company.id, project.slug, 'instalar.sh'), /Extensión no permitida.*Usá:/s,
    'y el mensaje dice qué sí puede escribir');
});

// FAILS ON PURPOSE: real product bug.
// construirApp() is only called when the project is from a mobile niche
// (workforce.js: `esProyectoMovil(goal?.stack)`). If the folder has neither
// Gradle nor an entry point, it returns { saltado: true } and renderBuildReport()
// says nothing: the task closes as good. That is, the web page disguised as an app
// is detected once it already looks like an app, but the crudest disguise —shipping
// an index.html and done— sails through.
test('if the project is an app and the folder holds a web page, the engine must reject it', async (t) => {
  const { store, company } = nuevaEmpresa('movil-rn');
  const project = store.createProject({ companyId: company.id, title: 'Turnos del club' });
  const dir = carpetaDelProyecto(t, company, project);

  escribir(company, project, 'index.html', '<!doctype html><html lang="es"><body><h1>Turnos</h1></body></html>');
  escribir(company, project, 'estilos.css', ':root { --fondo: #101014; }');

  assert.equal(esProyectoMovil(project.stack), true, 'el usuario pidió una app');
  assert.equal(detectarProyecto(dir), null, 'y en la carpeta no hay ninguna app');

  // The project niche travels to the engine: the folder alone cannot know that
  // an app belonged here and not a site.
  const build = await construirApp(dir, project.stack);
  assert.notEqual(
    renderBuildReport(build),
    '',
    'BUG: entregaron una web en un proyecto de app móvil y el motor la deja pasar sin decir nada'
  );
  assert.match(renderBuildReport(build), /APP|app/, 'el mensaje tiene que decir que faltaba una app');
});
