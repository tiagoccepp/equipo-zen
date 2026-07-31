import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ejecutar } from './herramientas.js';
import { esCarpetaIgnorada } from './workforce-fs.js';

// El andamiaje NO es un consejo del playbook: lo corre el motor.
//
// Está medido: de 18 proyectos producidos, la ÚNICA app bien armada fue la única
// donde el agente corrió `create-expo-app` por su cuenta. Las otras escribieron
// el andamiaje a mano y quedaron sin package.json, sin app.json y sin punto de
// entrada — dos archivos sueltos en una carpeta, no una app.
//
// La conclusión es que no se le puede pedir: hay que hacerlo. Un proyecto vacío
// se andamia con la herramienta oficial ANTES de que el primer agente entre, y
// el agente encuentra la estructura ya hecha y trabaja sobre ella.
//
// Si el usuario pidió un comando concreto ("hacelo con Vite", "usá expo router"),
// manda ese: el andamiaje por defecto es un default, no una imposición.

// Cuánto se le da a cada uno: bajar dependencias tarda.
const TIMEOUT_MS = Number(process.env.ANDAMIAJE_TIMEOUT_MS || 480000);

const RECETAS = {
  'movil-rn': {
    // El template blank deja App.js, app.json, package.json y los assets.
    cmd: 'npx --yes create-expo-app@latest . --template blank --no-install && npm install --no-audit --no-fund',
    prueba: (dir) => existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'app.json')),
    que: 'proyecto Expo (React Native) con su package.json, app.json y punto de entrada'
  },
  android: {
    // No hay CLI oficial sin Android Studio, así que el andamiaje es una
    // plantilla propia. Es la misma que se verificó que compila con
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
    // El package.json se escribe, no se genera con `npm init`: ese toma el
    // nombre de la carpeta y falla si el slug del proyecto no es un nombre
    // válido de paquete npm (pasó con una carpeta que empezaba con punto).
    plantilla: 'automatizacion',
    prueba: (dir) => existsSync(path.join(dir, 'flujo.js')) && existsSync(path.join(dir, 'package.json')),
    que: 'flujo con su package.json y datos de ejemplo'
  }
};

// Plantilla mínima de Android, escrita a mano porque no hay CLI. Los valores
// están verificados: AGP 9 trae Kotlin, aplicar kotlin.android aparte rompe.
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

// ¿La carpeta está vacía de trabajo real? Los artefactos de coordinación
// (BITACORA.md, diseno.op) no cuentan como proyecto.
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

// Busca en lo que pidió el usuario un comando de andamiaje explícito. Si lo hay,
// manda ese: el default es un default.
export function comandoPedidoPorElUsuario(textos) {
  const texto = Array.isArray(textos) ? textos.join(' ') : String(textos || '');
  // Un comando entre backticks o que arranca con npx/npm/yarn/pnpm/python.
  const entreComillas = texto.match(/`([^`]{6,200})`/);
  if (entreComillas && /^(npx|npm|yarn|pnpm|python3?|gradle|expo)\b/.test(entreComillas[1].trim())) {
    return entreComillas[1].trim();
  }
  const suelto = texto.match(/\b((?:npx|npm|yarn|pnpm)\s+(?:create|init)[^.\n,;]{4,160})/i);
  return suelto ? suelto[1].trim() : null;
}

// Andamia el proyecto. Devuelve qué se hizo, para poder contárselo al agente y
// al usuario. No lanza: si falla, el agente lo va a tener que hacer a mano y se
// le dice por qué.
export async function andamiar(dir, stack, { pedidoDelUsuario = '', escribir } = {}) {
  const receta = recetaPara(stack);
  if (!receta) {
    return { hecho: false, motivo: `no hay andamiaje definido para "${stack}"` };
  }
  if (!proyectoVacio(dir)) {
    return { hecho: false, yaEstaba: true };
  }

  // Lo que pidió el usuario gana.
  const explicito = comandoPedidoPorElUsuario(pedidoDelUsuario);

  if (!explicito && receta.plantilla === 'automatizacion') {
    // Nombre saneado para npm: minúsculas, sin puntos al inicio, sin espacios.
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
      : { hecho: false, motivo: 'no pude escribir la plantilla del flujo' };
  }

  if (!explicito && receta.plantilla === 'android') {
    const nombre = path.basename(dir).replace(/[^\w -]/g, '') || 'App';
    for (const [rel, contenido] of plantillaAndroid(nombre)) {
      await escribir(rel, contenido);
    }
    return receta.prueba(dir)
      ? { hecho: true, como: 'plantilla', que: receta.que }
      : { hecho: false, motivo: 'no pude escribir la plantilla de Android' };
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
    motivo: `el andamiaje no dejó la estructura esperada. Salida:\n${r.salida.slice(-800)}`
  };
}

// Lo que el agente lee cuando el motor ya andamió por él.
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
