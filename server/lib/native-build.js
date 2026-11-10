import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Real compilation of the mobile apps.
//
// The mobile niches deliver a NATIVE APP, not a web page: the engine really
// compiles it and hands the compiler errors back to the agent, just like
// verify.js does with HTML. Without this, "delivering an app" is delivering
// text that looks like an app.
//
// Verified on this machine: Gradle 9.1 + AGP 9 + Kotlin 2.2 + Compose,
// compileSdk 36. A cold build takes minutes; a warm one, ~5s.

const SDK_ROOT = () => process.env.ANDROID_HOME
  || process.env.ANDROID_SDK_ROOT
  || path.join(process.env.HOME || '', 'Library', 'Android', 'sdk');

const BUILD_TIMEOUT_MS = Number(process.env.NATIVE_BUILD_TIMEOUT_MS || 600000);

function gradleBin() {
  // The project wrapper would be ideal, but agents cannot write
  // the wrapper's binary jar: the distribution already in the cache is used.
  const dists = path.join(process.env.HOME || '', '.gradle', 'wrapper', 'dists');
  let versiones = [];
  try {
    versiones = readdirSync(dists).filter((n) => n.startsWith('gradle-')).sort().reverse();
  } catch {
    return null;
  }
  for (const version of versiones) {
    let hashes = [];
    try {
      hashes = readdirSync(path.join(dists, version));
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const base = path.join(dists, version, hash);
      let carpetas = [];
      try {
        carpetas = readdirSync(base).filter((n) => n.startsWith('gradle-'));
      } catch {
        continue;
      }
      for (const carpeta of carpetas) {
        const bin = path.join(base, carpeta, 'bin', 'gradle');
        if (existsSync(bin)) {
          return bin;
        }
      }
    }
  }
  return null;
}

function javaHome() {
  // Java 17 is what AGP 9 requires. /usr/libexec/java_home is not on Linux, so
  // it falls back to JAVA_HOME when set.
  return process.env.JAVA_HOME || '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home';
}

function correr(cmd, args, { cwd, timeout = BUILD_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, ...env }
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        salida: `${stdout || ''}\n${stderr || ''}`.trim(),
        expiro: Boolean(error && error.killed)
      });
    });
  });
}

// What kind of project lives in the folder. Returns null when there is
// nothing to build. Order matters: an Android project may hold stray .py
// scripts and still be Android.
export function detectarProyecto(dir) {
  if (existsSync(path.join(dir, 'settings.gradle.kts')) || existsSync(path.join(dir, 'settings.gradle'))) {
    return 'android';
  }
  if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'App.jsx'))) {
    return 'react-native';
  }
  if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'App.js'))) {
    return 'react-native';
  }
  if (archivosPython(dir).length > 0) {
    return 'python';
  }
  return null;
}

// Every .py in the project, as relative paths. Intermediates and the
// virtual env are skipped: compiling a venv's stdlib is thousands of
// files and not one of them was written by the team.
const IGNORAR_PY = new Set(['__pycache__', 'node_modules', 'build', 'dist', 'venv', 'site-packages']);

export function archivosPython(dir) {
  const out = [];
  const walk = (base, prefijo) => {
    let entradas = [];
    try {
      entradas = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (entrada.name.startsWith('.') || IGNORAR_PY.has(entrada.name) || out.length >= 200) {
        continue;
      }
      const rel = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) {
        walk(path.join(base, entrada.name), rel);
      } else if (entrada.name.endsWith('.py')) {
        out.push(rel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

// Compiler errors, as the agent needs them: file, line, and
// what is wrong. Trimmed to the first ones because fixing the first
// usually makes the cascade disappear.
export function parsearErroresKotlin(salida) {
  const errores = [];
  for (const linea of String(salida || '').split('\n')) {
    // e: file:///path/File.kt:12:5 Message
    const kotlin = linea.match(/^e:\s+file:\/\/(\S+?):(\d+):(\d+)\s+(.+)$/);
    if (kotlin) {
      errores.push({ archivo: path.basename(kotlin[1]), linea: Number(kotlin[2]), que: kotlin[4].trim() });
      continue;
    }
    // Gradle errors (configuration, dependencies, plugins).
    const gradle = linea.match(/^\s*>\s+(.+)$/);
    if (gradle && !/^\s*>\s+Task/.test(linea) && errores.length < 8) {
      const texto = gradle[1].trim();
      if (texto && !/^Run with|^Get more help|^Try:/.test(texto)) {
        errores.push({ archivo: 'compilación', linea: null, que: texto });
      }
    }
  }
  // With nothing recognizable, return the log tail: something beats nothing.
  if (errores.length === 0) {
    const cola = String(salida || '').split('\n').filter(Boolean).slice(-12).join('\n');
    if (cola) {
      errores.push({ archivo: 'compilación', linea: null, que: cola.slice(0, 800) });
    }
  }
  return errores.slice(0, 8);
}

// py_compile errors, with file and line just like the Kotlin ones.
// Python emits them in TWO different formats and both must be understood:
//
//   1)   File "src/nucleo.py", line 12      ← SyntaxError and relatives
//          def sumar(a, b)
//                         ^
//        SyntaxError: expected ':'
//
//   2) Sorry: IndentationError: expected an indented block … (main.py, line 3)
//
// The second shows up for IndentationError and TabError, which are exactly
// what a model produces most often. Parsing only the first left the most
// common failure without file or line.
export function parsearErroresPython(salida, archivoPorDefecto = null) {
  const errores = [];
  const lineas = String(salida || '').split('\n');

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];

    // Format 2: everything on one line, with file and line at the end.
    const corto = linea.match(/^\s*Sorry:\s*(\w*(?:Error|Warning)):\s*(.+?)\s*\(([^,()]+),\s*line\s+(\d+)\)\s*$/);
    if (corto) {
      errores.push({ archivo: corto[3].trim(), linea: Number(corto[4]), que: `${corto[1]}: ${corto[2].trim()}` });
      continue;
    }

    // Format 1: location on one line, message a few lines below.
    const ubicacion = linea.match(/^\s*File "([^"]+)", line (\d+)/);
    if (ubicacion) {
      let que = '';
      for (let j = i + 1; j < Math.min(lineas.length, i + 6); j += 1) {
        const mensaje = lineas[j].match(/^\s*(\w*(?:Error|Warning)):\s*(.+)$/);
        if (mensaje) {
          que = `${mensaje[1]}: ${mensaje[2].trim()}`;
          break;
        }
      }
      errores.push({
        archivo: ubicacion[1].trim(),
        linea: Number(ubicacion[2]),
        que: que || 'does not compile (the interpreter could not read the file)'
      });
      continue;
    }
  }

  // With nothing recognizable: the log tail beats nothing, same as in Kotlin.
  if (errores.length === 0) {
    const cola = lineas.filter(Boolean).slice(-12).join('\n');
    if (cola) {
      errores.push({ archivo: archivoPorDefecto || 'compilación', linea: null, que: cola.slice(0, 800) });
    }
  }
  return errores.slice(0, 8);
}

function pythonBin() {
  return process.env.PYTHON_BIN || 'python3';
}

// Compiles EVERY .py in the project with py_compile. Returns { ok, errores } or
// { saltado, motivo } when there is no Python on the machine.
//
// One file at a time on purpose: py_compile with several args stops
// at the first failure, and the agent gets far more out of one step when it
// receives all three broken modules at once instead of discovering them one
// per run.
//
// PYTHONPYCACHEPREFIX sends .pyc files to a temp folder: without it, every
// verification left a __pycache__ inside the user's deliverable.
export async function compilarPython(dir) {
  const python = pythonBin();
  const version = await correr(python, ['--version'], { cwd: dir, timeout: 15000 });
  if (!version.ok) {
    return { ok: false, saltado: true, motivo: 'Python 3 not found on this machine.' };
  }

  const archivos = archivosPython(dir);
  if (archivos.length === 0) {
    return { ok: false, saltado: true, motivo: 'No .py files to compile.' };
  }

  const cache = path.join(process.env.TMPDIR || '/tmp', 'equipo-pycache');
  const errores = [];
  for (const archivo of archivos) {
    const r = await correr(python, ['-m', 'py_compile', archivo], {
      cwd: dir,
      timeout: 60000,
      env: { PYTHONPYCACHEPREFIX: cache, PYTHONDONTWRITEBYTECODE: '' }
    });
    if (r.expiro) {
      errores.push({ archivo, linea: null, que: 'compiling this file took too long and was cut off' });
    } else if (!r.ok) {
      errores.push(...parsearErroresPython(r.salida, archivo));
    }
    if (errores.length >= 8) {
      break;
    }
  }

  return errores.length ? { ok: false, errores: errores.slice(0, 8) } : { ok: true, archivos: archivos.length };
}

// Compiles the Android app. Returns { ok, apk, errores, motivo }.
export async function compilarAndroid(dir) {
  const gradle = gradleBin();
  if (!gradle) {
    return { ok: false, saltado: true, motivo: 'No Gradle distribution in the cache.' };
  }
  const sdk = SDK_ROOT();
  if (!existsSync(sdk)) {
    return { ok: false, saltado: true, motivo: 'Android SDK not found.' };
  }

  const r = await correr(gradle, ['assembleDebug', '--console=plain'], {
    cwd: dir,
    env: { ANDROID_HOME: sdk, JAVA_HOME: javaHome() }
  });

  if (r.expiro) {
    return { ok: false, errores: [{ archivo: 'compilación', linea: null, que: 'The build took too long and was cut off.' }] };
  }
  if (!r.ok || /BUILD FAILED/.test(r.salida)) {
    return { ok: false, errores: parsearErroresKotlin(r.salida) };
  }

  // Find the APK that was produced.
  const buscarApk = async (base) => {
    for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
      const completo = path.join(base, entry.name);
      if (entry.isDirectory()) {
        const hallado = await buscarApk(completo);
        if (hallado) return hallado;
      } else if (entry.name.endsWith('.apk')) {
        return completo;
      }
    }
    return null;
  };
  const apk = await buscarApk(path.join(dir, 'app', 'build', 'outputs')).catch(() => null);
  return { ok: true, apk };
}

// Installs the APK on the emulator and opens it. Only with a device present.
export async function instalarYAbrir(apk, dir) {
  const adb = path.join(SDK_ROOT(), 'platform-tools', 'adb');
  if (!existsSync(adb) || !apk) {
    return { ok: false, motivo: 'No adb or no APK.' };
  }
  const devices = await correr(adb, ['devices'], { timeout: 10000 });
  const hayDispositivo = (devices.salida || '').split('\n').slice(1).some((l) => /\sdevice$/.test(l.trim()));
  if (!hayDispositivo) {
    return { ok: false, motivo: 'No emulator is running.' };
  }

  const install = await correr(adb, ['install', '-r', apk], { timeout: 180000 });
  if (!install.ok || /Failure/.test(install.salida)) {
    return { ok: false, motivo: `Could not install: ${install.salida.slice(-200)}` };
  }

  // The package comes from the manifest; without it there is nothing to launch.
  const manifiesto = await fs.readFile(path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8').catch(() => '');
  const gradleApp = await fs.readFile(path.join(dir, 'app', 'build.gradle.kts'), 'utf-8').catch(() => '');
  const paquete = manifiesto.match(/package="([^"]+)"/)?.[1]
    || gradleApp.match(/applicationId\s*=\s*"([^"]+)"/)?.[1]
    || gradleApp.match(/namespace\s*=\s*"([^"]+)"/)?.[1];
  if (!paquete) {
    return { ok: true, instalado: true, motivo: 'Installed, but could not figure out the package to open it.' };
  }

  await correr(adb, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { timeout: 8000 });
  await correr(adb, ['shell', 'wm', 'dismiss-keyguard'], { timeout: 8000 });
  await correr(adb, ['shell', 'monkey', '-p', paquete, '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 15000 });
  return { ok: true, instalado: true, paquete };
}

// Single entry point: builds whatever is there and returns the agent report.
// `stackEsperado` is the project niche: if it is mobile and what sits in the
// folder is not an app, that is NOT "nothing to build" — it is having delivered
// a web page where an app belonged, which is exactly what must be prevented.
export async function construirApp(dir, stackEsperado = null) {
  const tipo = detectarProyecto(dir);

  // Python: the deliverable is a program that runs. Having not a single .py
  // is not "nothing to build" — it is not having delivered the program.
  if (stackEsperado === 'python' && tipo !== 'python') {
    const hayWeb = existsSync(path.join(dir, 'index.html'));
    return {
      tipo: null,
      esperado: 'python',
      ok: false,
      errores: [{
        archivo: hayWeb ? 'index.html' : 'el proyecto',
        linea: null,
        que: hayWeb
          ? 'you delivered a web page. This needs a Python program run with python3, not something opened in a browser'
          : 'no .py files: the program is missing (main.py, plus src/<module>.py if split)'
      }]
    };
  }

  // A stray .py does not make a mobile project buildable: if an app belonged
  // here, the missing app is reported just as before.
  const esperaMovil = stackEsperado === 'android' || stackEsperado === 'movil-rn';
  if (esperaMovil && tipo !== 'android' && tipo !== 'react-native') {
    const hayWeb = existsSync(path.join(dir, 'index.html'));
    return {
      tipo: null,
      ok: false,
      errores: [{
        archivo: hayWeb ? 'index.html' : 'el proyecto',
        linea: null,
        que: stackEsperado === 'android'
          ? 'this is not an Android app: the Gradle project is missing (settings.gradle.kts, app/build.gradle.kts, app/src/main/AndroidManifest.xml and MainActivity.kt)'
          : 'this is not a mobile app: the React Native project is missing (package.json with react-native, app.json and App.jsx)'
      }, ...(hayWeb ? [{
        archivo: 'index.html',
        linea: null,
        que: 'you delivered a web page. This project is an APP installed on the phone, not a site opened in a browser'
      }] : [])]
    };
  }
  if (tipo === 'android') {
    const build = await compilarAndroid(dir);
    if (build.saltado) {
      return { tipo, saltado: true, motivo: build.motivo };
    }
    if (!build.ok) {
      return { tipo, ok: false, errores: build.errores };
    }
    const run = await instalarYAbrir(build.apk, dir);
    return { tipo, ok: true, apk: build.apk, ejecucion: run };
  }
  if (tipo === 'react-native') {
    // The cross-platform app is validated without installing dependencies: check
    // that the project looks like a mobile app and that its JSX parses. An
    // `npm install` per project is hundreds of MB and minutes per run.
    return { tipo, ...(await revisarReactNative(dir)) };
  }
  if (tipo === 'python') {
    const build = await compilarPython(dir);
    if (build.saltado) {
      return { tipo, saltado: true, motivo: build.motivo };
    }
    return { tipo, ...build };
  }
  return { tipo: null, saltado: true, motivo: 'Nothing to build here.' };
}

// Review of a React Native project WITHOUT installing dependencies: that it is
// a real mobile app and not a disguised web page.
export async function revisarReactNative(dir) {
  const errores = [];
  const pkgTexto = await fs.readFile(path.join(dir, 'package.json'), 'utf-8').catch(() => '');
  let pkg = {};
  try {
    pkg = JSON.parse(pkgTexto);
  } catch {
    errores.push({ archivo: 'package.json', linea: null, que: 'not valid JSON' });
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (!deps['react-native']) {
    errores.push({ archivo: 'package.json', linea: null, que: 'missing the react-native dependency: this is not a mobile app' });
  }
  if (!existsSync(path.join(dir, 'app.json'))) {
    errores.push({ archivo: 'app.json', linea: null, que: 'missing app.json (the app name, slug, icon and splash)' });
  }

  // HTML tags in the code: the classic delivered-a-web-page mistake.
  const revisarJsx = async (base) => {
    for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const completo = path.join(base, entry.name);
      if (entry.isDirectory()) {
        await revisarJsx(completo);
      } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
        const texto = await fs.readFile(completo, 'utf-8').catch(() => '');
        const html = texto.match(/<\/(div|span|p|h[1-6]|button|input|a|ul|li|img|section|header|footer|nav)>/);
        if (html) {
          errores.push({
            archivo: path.relative(dir, completo),
            linea: null,
            que: `uses HTML <${html[1]}>. In React Native use View, Text, Pressable, FlatList — this is not a web page`
          });
        }
        if (/document\.|window\.|localStorage/.test(texto)) {
          errores.push({
            archivo: path.relative(dir, completo),
            linea: null,
            que: 'uses browser APIs (document/window/localStorage), which do not exist in a mobile app'
          });
        }
      }
    }
  };
  await revisarJsx(dir);

  return errores.length ? { ok: false, errores: errores.slice(0, 8) } : { ok: true };
}

function tituloDelInforme(resultado) {
  if (resultado.tipo === 'python') {
    return 'EL PROGRAMA NO COMPILA';
  }
  if (resultado.esperado === 'python') {
    return 'ESTO NO ES UN PROGRAMA PYTHON';
  }
  if (resultado.tipo === 'android') {
    return 'LA APP NO COMPILA';
  }
  return 'LA APP NO ES UNA APP MÓVIL VÁLIDA';
}

// The report as the agent reads it on its next step.
export function renderBuildReport(resultado) {
  if (!resultado || resultado.ok || resultado.saltado) {
    return '';
  }
  const titulo = tituloDelInforme(resultado);
  return [
    `━━ ${titulo} (${resultado.errores.length} ${resultado.errores.length === 1 ? 'error' : 'errores'}) ━━`,
    'Esto lo dijo el compilador, no una opinión. Arreglalo con edit_file y recién después finish.',
    '',
    ...resultado.errores.map((e, i) => `${i + 1}. ${e.archivo}${e.linea ? `:${e.linea}` : ''} — ${e.que}`),
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}
