import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Compilación real de las apps móviles.
//
// Los nichos móviles entregan una APP NATIVA, no una web: el motor la compila
// de verdad y le devuelve los errores del compilador al agente, igual que hace
// verify.js con el HTML. Sin esto, "entregar una app" es entregar un texto que
// se parece a una app.
//
// Verificado en esta máquina: Gradle 9.1 + AGP 9 + Kotlin 2.2 + Compose,
// compileSdk 36. Una compilación en frío tarda minutos; en caliente, ~5 s.

const SDK_ROOT = () => process.env.ANDROID_HOME
  || process.env.ANDROID_SDK_ROOT
  || path.join(process.env.HOME || '', 'Library', 'Android', 'sdk');

const BUILD_TIMEOUT_MS = Number(process.env.NATIVE_BUILD_TIMEOUT_MS || 600000);

function gradleBin() {
  // El wrapper del proyecto sería lo ideal, pero los agentes no pueden escribir
  // el jar binario del wrapper: se usa la distribución que ya está en la caché.
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
  // Java 17 es el que pide AGP 9. /usr/libexec/java_home no está en Linux, así
  // que se cae a JAVA_HOME si existe.
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

// Qué clase de proyecto hay en la carpeta. Devuelve null si no hay nada que
// compilar. El orden importa: un proyecto Android puede tener scripts .py
// sueltos y sigue siendo Android.
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

// Todos los .py del proyecto, en rutas relativas. Se saltean los intermedios y
// el entorno virtual: compilar la biblioteca estándar de un venv son miles de
// archivos y ni uno de ellos lo escribió el equipo.
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

// Los errores del compilador, tal como los necesita el agente: archivo, línea y
// qué está mal. Se recortan a los primeros porque arreglar el primero suele
// hacer desaparecer la cascada.
export function parsearErroresKotlin(salida) {
  const errores = [];
  for (const linea of String(salida || '').split('\n')) {
    // e: file:///ruta/Archivo.kt:12:5 Mensaje
    const kotlin = linea.match(/^e:\s+file:\/\/(\S+?):(\d+):(\d+)\s+(.+)$/);
    if (kotlin) {
      errores.push({ archivo: path.basename(kotlin[1]), linea: Number(kotlin[2]), que: kotlin[4].trim() });
      continue;
    }
    // Errores de Gradle (configuración, dependencias, plugins).
    const gradle = linea.match(/^\s*>\s+(.+)$/);
    if (gradle && !/^\s*>\s+Task/.test(linea) && errores.length < 8) {
      const texto = gradle[1].trim();
      if (texto && !/^Run with|^Get more help|^Try:/.test(texto)) {
        errores.push({ archivo: 'compilación', linea: null, que: texto });
      }
    }
  }
  // Sin nada reconocible, se devuelve la cola del log: mejor algo que nada.
  if (errores.length === 0) {
    const cola = String(salida || '').split('\n').filter(Boolean).slice(-12).join('\n');
    if (cola) {
      errores.push({ archivo: 'compilación', linea: null, que: cola.slice(0, 800) });
    }
  }
  return errores.slice(0, 8);
}

// Los errores de py_compile, con archivo y línea igual que los de Kotlin.
// Python los emite en DOS formatos distintos y hay que entender los dos:
//
//   1)   File "src/nucleo.py", line 12      ← SyntaxError y parientes
//          def sumar(a, b)
//                         ^
//        SyntaxError: expected ':'
//
//   2) Sorry: IndentationError: expected an indented block … (main.py, line 3)
//
// El segundo aparece para IndentationError y TabError, que son justo los que un
// modelo produce más seguido. Parsear solo el primero dejaba la falla más común
// sin archivo ni línea.
export function parsearErroresPython(salida, archivoPorDefecto = null) {
  const errores = [];
  const lineas = String(salida || '').split('\n');

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];

    // Formato 2: viene todo en un renglón, con el archivo y la línea al final.
    const corto = linea.match(/^\s*Sorry:\s*(\w*(?:Error|Warning)):\s*(.+?)\s*\(([^,()]+),\s*line\s+(\d+)\)\s*$/);
    if (corto) {
      errores.push({ archivo: corto[3].trim(), linea: Number(corto[4]), que: `${corto[1]}: ${corto[2].trim()}` });
      continue;
    }

    // Formato 1: la ubicación en un renglón y el mensaje unos renglones abajo.
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

  // Sin nada reconocible: mejor la cola del log que nada, igual que en Kotlin.
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

// Compila TODOS los .py del proyecto con py_compile. Devuelve { ok, errores } o
// { saltado, motivo } si no hay Python en la máquina.
//
// Se compila de a un archivo a propósito: py_compile con varios argumentos corta
// en el primero que falla, y el agente aprovecha mucho mejor un paso si recibe
// los tres módulos rotos de una que si los descubre de a uno por corrida.
//
// PYTHONPYCACHEPREFIX manda los .pyc a una carpeta temporal: sin eso, cada
// verificación dejaba un __pycache__ dentro del entregable del usuario.
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

// Compila la app Android. Devuelve { ok, apk, errores, motivo }.
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

  // Buscar el APK que quedó.
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

// Instala el APK en el emulador y lo abre. Solo si hay dispositivo.
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

  // El paquete sale del manifiesto; sin él no se puede lanzar.
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

// Punto único: compila lo que haya y devuelve el informe para el agente.
// `stackEsperado` es el nicho del proyecto: si es móvil y lo que hay en la
// carpeta no es una app, eso NO es "nada que compilar" — es haber entregado
// una web donde iba una app, que es justo lo que hay que impedir.
export async function construirApp(dir, stackEsperado = null) {
  const tipo = detectarProyecto(dir);

  // Python: el entregable es un programa que se ejecuta. Que no haya ni un .py
  // no es "nada que compilar" — es no haber entregado el programa.
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

  // Un .py suelto no convierte un proyecto móvil en compilable: si acá iba una
  // app, la falta de app se reporta igual que antes.
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
    // La app multiplataforma se valida sin instalar dependencias: se comprueba
    // que el proyecto tenga forma de app móvil y que su JSX parsee. Un
    // `npm install` por proyecto son cientos de MB y minutos por corrida.
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

// Revisión de un proyecto React Native SIN instalar dependencias: que sea una
// app móvil de verdad y no una web disfrazada.
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

  // Etiquetas HTML en el código: el error clásico de entregar una web.
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

// El informe tal como lo lee el agente en su próximo paso.
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
