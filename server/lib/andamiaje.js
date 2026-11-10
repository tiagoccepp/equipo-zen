import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ejecutar } from './herramientas.js';
import { esCarpetaIgnorada } from './workforce-fs.js';

// Scaffolding is NOT playbook advice: the engine runs it.
//
// Measured: out of 18 produced projects, the ONLY well-built app was the one
// where the agent ran `create-expo-app` on its own. The others hand-wrote
// the scaffolding and ended up with no package.json, no app.json and no entry
// point — two loose files in a folder, not an app.
//
// The takeaway is you can't ask for it: you have to do it. An empty project
// gets scaffolded with the official tool BEFORE the first agent enters, and
// the agent finds the structure already built and works on top of it.
//
// If the user asked for a concrete command ("hacelo con Vite", "usá expo router"),
// that one wins: default scaffolding is a default, not an imposition.

// How much time each one gets: downloading dependencies takes a while.
const TIMEOUT_MS = Number(process.env.ANDAMIAJE_TIMEOUT_MS || 480000);

const RECETAS = {
  'movil-rn': {
    // The blank template leaves App.js, app.json, package.json and the assets.
    cmd: 'npx --yes create-expo-app@latest . --template blank --no-install && npm install --no-audit --no-fund',
    prueba: (dir) => existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'app.json')),
    que: 'proyecto Expo (React Native) con su package.json, app.json y punto de entrada'
  },
  android: {
    // No official CLI without Android Studio, so scaffolding is a
    // homegrown template. It's the same one verified to compile with
    // Gradle 9 + AGP 9 + Kotlin 2.2 + Compose.
    plantilla: 'android',
    prueba: (dir) => existsSync(path.join(dir, 'settings.gradle.kts')),
    que: 'proyecto Gradle con Compose, listo para compilar'
  },
  web: {
    cmd: 'npm create vite@latest . -- --template vanilla --yes',
    prueba: (dir) => existsSync(path.join(dir, 'index.html')) && existsSync(path.join(dir, 'package.json')),
    que: 'proyecto web con index.html y su package.json'
  },
  python: {
    cmd: 'python3 -m venv .venv && printf "[project]\\nname = \\"app\\"\\nversion = \\"0.1.0\\"\\n" > pyproject.toml && printf "def main():\\n    pass\\n\\n\\nif __name__ == \\"__main__\\":\\n    main()\\n" > main.py && printf "# dependencias del proyecto\\n" > requirements.txt',
    prueba: (dir) => existsSync(path.join(dir, 'main.py')) && existsSync(path.join(dir, 'pyproject.toml')),
    que: 'proyecto Python con entorno virtual, main.py y requirements.txt'
  },
  automatizacion: {
    // package.json is written, not generated with `npm init`: that one takes
    // the folder name and fails if the project slug is not a valid
    // npm package name (happened with a folder starting with a dot).
    plantilla: 'automatizacion',
    prueba: (dir) => existsSync(path.join(dir, 'flujo.js')) && existsSync(path.join(dir, 'package.json')),
    que: 'flujo con su package.json y datos de ejemplo'
  }
};

// Minimal Android template, hand-written because there is no CLI. Values
// are verified: AGP 9 brings Kotlin, applying kotlin.android separately breaks.
function plantillaAndroid(nombre) {
  const paquete = 'com.equipo.app';
  const ruta = paquete.replace(/\./g, '/');
  return [
    ['settings.gradle.kts', [
      'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }',
      'dependencyResolutionManagement { repositories { google(); mavenCentral() } }',
      `rootProject.name = ${JSON.stringify(nombre)}`,
      'include(":app")',
      ''
    ].join('\n')],
    ['build.gradle.kts', [
      'plugins {',
      '  id("com.android.application") version "9.0.0" apply false',
      '  id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false',
      '}',
      ''
    ].join('\n')],
    ['gradle.properties', 'org.gradle.jvmargs=-Xmx2g\nandroid.useAndroidX=true\n'],
    ['app/build.gradle.kts', [
      'plugins {',
      '  id("com.android.application")',
      '  id("org.jetbrains.kotlin.plugin.compose")',
      '}',
      'android {',
      `  namespace = ${JSON.stringify(paquete)}`,
      '  compileSdk = 36',
      `  defaultConfig { applicationId = ${JSON.stringify(paquete)}; minSdk = 26; targetSdk = 36; versionCode = 1; versionName = "1.0" }`,
      '  buildFeatures { compose = true }',
      '  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }',
      '}',
      'kotlin { jvmToolchain(17) }',
      'dependencies {',
      '  implementation(platform("androidx.compose:compose-bom:2024.09.00"))',
      '  implementation("androidx.compose.material3:material3")',
      '  implementation("androidx.compose.ui:ui")',
      '  implementation("androidx.activity:activity-compose:1.9.2")',
      '}',
      ''
    ].join('\n')],
    ['app/src/main/AndroidManifest.xml', [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      `  <application android:label=${JSON.stringify(nombre)} android:theme="@android:style/Theme.Material.Light">`,
      '    <activity android:name=".MainActivity" android:exported="true">',
      '      <intent-filter>',
      '        <action android:name="android.intent.action.MAIN" />',
      '        <category android:name="android.intent.category.LAUNCHER" />',
      '      </intent-filter>',
      '    </activity>',
      '  </application>',
      '</manifest>',
      ''
    ].join('\n')],
    [`app/src/main/java/${ruta}/MainActivity.kt`, [
      `package ${paquete}`,
      '',
      'import android.os.Bundle',
      'import androidx.activity.ComponentActivity',
      'import androidx.activity.compose.setContent',
      'import androidx.compose.material3.MaterialTheme',
      'import androidx.compose.material3.Surface',
      'import androidx.compose.material3.Text',
      '',
      'class MainActivity : ComponentActivity() {',
      '    override fun onCreate(savedInstanceState: Bundle?) {',
      '        super.onCreate(savedInstanceState)',
      '        setContent {',
      '            MaterialTheme {',
      '                Surface {',
      `                    Text(${JSON.stringify(nombre)})`,
      '                }',
      '            }',
      '        }',
      '    }',
      '}',
      ''
    ].join('\n')]
  ];
}

// Is the folder empty of real work? Coordination artifacts
// (BITACORA.md, diseno.op) don't count as a project.
export function proyectoVacio(dir) {
  let entradas = [];
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  const utiles = entradas.filter((e) =>
    !e.name.startsWith('.')
    && !esCarpetaIgnorada(e.name)
    && !['BITACORA.md', 'PROYECTO.md', 'diseno.op'].includes(e.name)
    && !e.name.endsWith('.png'));
  return utiles.length === 0;
}

export function recetaPara(stack) {
  return RECETAS[stack] || null;
}

// Looks for an explicit scaffolding command in what the user asked. If found,
// that one wins: the default is a default.
export function comandoPedidoPorElUsuario(textos) {
  const texto = Array.isArray(textos) ? textos.join(' ') : String(textos || '');
  // A command in backticks or one starting with npx/npm/yarn/pnpm/python.
  const entreComillas = texto.match(/`([^`]{6,200})`/);
  if (entreComillas && /^(npx|npm|yarn|pnpm|python3?|gradle|expo)\b/.test(entreComillas[1].trim())) {
    return entreComillas[1].trim();
  }
  const suelto = texto.match(/\b((?:npx|npm|yarn|pnpm)\s+(?:create|init)[^.\n,;]{4,160})/i);
  return suelto ? suelto[1].trim() : null;
}

// Scaffolds the project. Returns what was done, so it can be told to the agent and
// the user. Never throws: on failure the agent will have to do it by hand and is
// told why.
export async function andamiar(dir, stack, { pedidoDelUsuario = '', escribir } = {}) {
  const receta = recetaPara(stack);
  if (!receta) {
    return { hecho: false, motivo: `no scaffolding defined for "${stack}"` };
  }
  if (!proyectoVacio(dir)) {
    return { hecho: false, yaEstaba: true };
  }

  // What the user asked for wins.
  const explicito = comandoPedidoPorElUsuario(pedidoDelUsuario);

  if (!explicito && receta.plantilla === 'automatizacion') {
    // Sanitized name for npm: lowercase, no leading dots, no spaces.
    const nombre = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'flujo';
    await escribir('package.json', `${JSON.stringify({
      name: nombre,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { start: 'node flujo.js' }
    }, null, 2)}\n`);
    await escribir('flujo.js', '// Punto de entrada del flujo.\n');
    await escribir('datos-ejemplo.csv', '# Datos de ejemplo para poder ver el flujo funcionando\n');
    await escribir('README.md', `# ${nombre}\n\nQué hace, qué necesita y cómo correrlo.\n`);
    return receta.prueba(dir)
      ? { hecho: true, como: 'plantilla', que: receta.que }
      : { hecho: false, motivo: 'could not write the flow template' };
  }

  if (!explicito && receta.plantilla === 'android') {
    const nombre = path.basename(dir).replace(/[^\w -]/g, '') || 'App';
    for (const [rel, contenido] of plantillaAndroid(nombre)) {
      await escribir(rel, contenido);
    }
    return receta.prueba(dir)
      ? { hecho: true, como: 'plantilla', que: receta.que }
      : { hecho: false, motivo: 'could not write the Android template' };
  }

  const cmd = explicito || receta.cmd;
  const r = await ejecutar(cmd, dir, { timeoutMs: TIMEOUT_MS });
  if (receta.prueba(dir)) {
    return {
      hecho: true,
      como: explicito ? 'comando del usuario' : 'comando por defecto',
      cmd,
      que: receta.que,
      salida: r.salida.slice(-600)
    };
  }
  return {
    hecho: false,
    cmd,
    motivo: `scaffolding did not leave the expected structure. Output:\n${r.salida.slice(-800)}`
  };
}

// What the agent reads when the engine already scaffolded for it.
export function renderAndamiaje(resultado) {
  if (!resultado || !resultado.hecho) {
    return '';
  }
  return [
    '',
    '━━ EL PROYECTO YA ESTÁ ANDAMIADO ━━',
    `Se creó el ${resultado.que} con la herramienta oficial${resultado.cmd ? ` (${resultado.cmd})` : ''}.`,
    'NO lo rehagas ni escribas a mano lo que ya está: abrí lo que hay con read_file',
    'y trabajá SOBRE esa estructura. El punto de entrada y la configuración ya existen.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}
