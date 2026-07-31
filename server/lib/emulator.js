import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { PORT } from './config.js';

const run = promisify(execFile);

// Emulador de Android y simulador de iOS, para ver los entregables móviles
// corriendo en un dispositivo de verdad y no solo en un marco dibujado.
//
// El detalle que hace que esto funcione: desde DENTRO del emulador de Android,
// 10.0.2.2 es el loopback de la máquina anfitriona. Así el emulador abre el
// workspace servido en 127.0.0.1 sin exponer nada a la red.
const HOST_DESDE_EMULADOR = '10.0.2.2';

function sdkRoot() {
  return process.env.ANDROID_HOME
    || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library', 'Android', 'sdk');
}

function binario(nombre, subcarpeta) {
  const ruta = path.join(sdkRoot(), subcarpeta, nombre);
  return existsSync(ruta) ? ruta : null;
}

const adbPath = () => binario('adb', 'platform-tools');
const emulatorPath = () => binario('emulator', 'emulator');

// Nada de esto puede tirar abajo el servidor: si una herramienta falta o cuelga,
// se responde "no disponible" con el motivo y la app sigue andando.
async function correr(cmd, args, timeout = 15000) {
  try {
    const { stdout } = await run(cmd, args, { timeout, encoding: 'utf-8' });
    return { ok: true, salida: String(stdout || '').trim() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

// Pantalla encendida y sin bloqueo. Sin esto, el dispositivo dormido devuelve
// capturas negras y no deja que ninguna app tome el foco.
async function despertarPantalla(adb) {
  await correr(adb, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 6000);
  await correr(adb, ['shell', 'wm', 'dismiss-keyguard'], 6000);
  // Cierra el panel de notificaciones si quedó desplegado.
  await correr(adb, ['shell', 'input', 'keyevent', 'KEYCODE_HOME'], 6000);
}

export async function androidStatus() {
  const adb = adbPath();
  const emulador = emulatorPath();
  if (!adb || !emulador) {
    return {
      disponible: false,
      motivo: 'No encontré el SDK de Android. Instalá Android Studio o definí ANDROID_HOME.',
      avds: [],
      dispositivos: []
    };
  }

  const listado = await correr(emulador, ['-list-avds']);
  const avds = listado.ok ? listado.salida.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  const devices = await correr(adb, ['devices']);
  const dispositivos = devices.ok
    ? devices.salida.split('\n').slice(1)
      .map((linea) => linea.trim().split(/\s+/))
      .filter(([serie, estado]) => serie && estado === 'device')
      .map(([serie]) => serie)
    : [];

  return {
    disponible: avds.length > 0,
    motivo: avds.length === 0 ? 'El SDK está, pero no hay ningún dispositivo virtual creado.' : '',
    avds,
    dispositivos,
    arrancado: dispositivos.length > 0
  };
}

// Arranca el AVD y NO espera a que termine de bootear: el proceso del emulador
// vive lo que dure la sesión del usuario, así que se lo desprende. Quien llame
// después a openInAndroid va a esperar con `adb wait-for-device`.
export async function startAndroid(avd) {
  const emulador = emulatorPath();
  if (!emulador) {
    return { ok: false, error: 'No encontré el emulador de Android.' };
  }
  const estado = await androidStatus();
  if (estado.arrancado) {
    return { ok: true, yaEstaba: true, dispositivos: estado.dispositivos };
  }
  const elegido = avd && estado.avds.includes(avd) ? avd : estado.avds[0];
  if (!elegido) {
    return { ok: false, error: 'No hay ningún dispositivo virtual creado en Android Studio.' };
  }

  const proceso = execFile(emulador, ['-avd', elegido, '-netdelay', 'none', '-netspeed', 'full'], () => {
    // El emulador termina cuando el usuario lo cierra: no es un error nuestro.
  });
  proceso.unref();
  return { ok: true, avd: elegido, arrancando: true };
}

// Abre la URL del proyecto en el navegador del emulador.
export async function openInAndroid(companyId, slug, { esperaMs = 90000 } = {}) {
  const adb = adbPath();
  if (!adb) {
    return { ok: false, error: 'No encontré adb.' };
  }

  const espera = await correr(adb, ['wait-for-device'], esperaMs);
  if (!espera.ok) {
    return { ok: false, error: 'El emulador no terminó de arrancar. Probá de nuevo en unos segundos.' };
  }
  // wait-for-device vuelve apenas responde adb, pero el sistema todavía puede
  // estar booteando: sin esto, el intent se pierde en silencio.
  for (let intento = 0; intento < 30; intento += 1) {
    const boot = await correr(adb, ['shell', 'getprop', 'sys.boot_completed'], 5000);
    if (boot.ok && boot.salida === '1') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const url = `http://${HOST_DESDE_EMULADOR}:${PORT}/workspace/${companyId}/${slug || 'general'}/`;

  await despertarPantalla(adb);

  // Chrome viene sin configurar en un emulador recién creado y se traba en su
  // pantalla de bienvenida. Este archivo de flags la saltea; si el sistema no
  // deja escribirlo, se sigue igual (a lo sumo aparece la bienvenida una vez).
  await correr(adb, [
    'shell',
    'echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
  ], 8000);

  // El intent GENÉRICO no sirve: sin navegador por defecto, `am start` sale con
  // código 0 y no abre nada — daba un "listo" que era mentira. Se apunta a
  // Chrome explícitamente y recién si no está se cae al intent genérico.
  const chrome = await correr(adb, [
    'shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main',
    '-a', 'android.intent.action.VIEW', '-d', url
  ]);
  if (!chrome.ok || /Error|does not exist/i.test(chrome.salida || '')) {
    const generico = await correr(adb, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
    if (!generico.ok) {
      return { ok: false, error: 'No pude abrir el navegador del emulador.' };
    }
  }

  // Confirmar que de verdad quedó algo abierto: el código de salida de
  // `am start` no alcanza como prueba.
  for (let intento = 0; intento < 8; intento += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const act = await correr(adb, ['shell', 'dumpsys activity activities | grep ResumedActivity'], 8000);
    const linea = act.salida || '';
    if (/FirstRun/i.test(linea)) {
      return {
        ok: true,
        url,
        aviso: 'Chrome abrió en su pantalla de bienvenida: aceptala una vez y volvé a tocar el botón.'
      };
    }
    if (/chrome|browser/i.test(linea)) {
      return { ok: true, url };
    }
  }
  return {
    ok: false,
    error: 'Mandé la orden pero el navegador no llegó a abrirse. Probá de nuevo en unos segundos.'
  };
}

// ── Pantalla y control DENTRO de la app ─────────────────────────────────
//
// El emulador se ve y se toca sin salir de Simulaciones: el servidor saca una
// captura del dispositivo y la manda como PNG, y los clics del usuario vuelven
// como toques reales. No hace falta ninguna ventana aparte.

const execFileBuffer = (cmd, args, timeout = 12000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? null : stdout);
  });
});

// Captura de pantalla en PNG. Devuelve null si no hay dispositivo.
export async function screenshot(platform = 'android') {
  if (platform === 'ios') {
    // simctl escribe a un archivo o a stdout con '-'.
    return execFileBuffer('xcrun', ['simctl', 'io', 'booted', 'screenshot', '--type=png', '-'], 15000);
  }
  const adb = adbPath();
  if (!adb) {
    return null;
  }
  // exec-out evita la traducción de saltos de línea que corrompía el PNG.
  return execFileBuffer(adb, ['exec-out', 'screencap', '-p'], 12000);
}

// Despertar bajo demanda desde la app, para cuando el dispositivo se durmió
// mientras lo estabas mirando.
export async function wakeAndroid() {
  const adb = adbPath();
  if (!adb) {
    return { ok: false, error: 'No encontré adb.' };
  }
  await despertarPantalla(adb);
  return { ok: true };
}

// Tamaño real de la pantalla, para escalar los toques desde el tamaño al que
// se muestra la imagen en el navegador.
export async function screenSize() {
  const adb = adbPath();
  if (!adb) {
    return null;
  }
  const salida = await correr(adb, ['shell', 'wm', 'size'], 8000);
  const m = (salida.salida || '').match(/(\d+)x(\d+)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// Un toque, un deslizamiento o una tecla. Solo Android: simctl no sabe
// inyectar eventos, así que el simulador de iPhone se ve pero no se toca.
export async function sendInput(accion) {
  const adb = adbPath();
  if (!adb) {
    return { ok: false, error: 'No encontré adb.' };
  }
  const n = (valor) => Math.max(0, Math.round(Number(valor) || 0));

  if (accion.type === 'tap') {
    return correr(adb, ['shell', 'input', 'tap', String(n(accion.x)), String(n(accion.y))], 8000);
  }
  if (accion.type === 'swipe') {
    return correr(adb, [
      'shell', 'input', 'swipe',
      String(n(accion.x1)), String(n(accion.y1)),
      String(n(accion.x2)), String(n(accion.y2)),
      String(Math.min(2000, Math.max(50, n(accion.ms) || 250)))
    ], 8000);
  }
  if (accion.type === 'key') {
    // Lista cerrada: nada de pasar texto arbitrario al shell del dispositivo.
    const TECLAS = {
      atras: 'KEYCODE_BACK',
      inicio: 'KEYCODE_HOME',
      recientes: 'KEYCODE_APP_SWITCH',
      enter: 'KEYCODE_ENTER',
      borrar: 'KEYCODE_DEL'
    };
    const code = TECLAS[accion.key];
    if (!code) {
      return { ok: false, error: 'tecla no permitida' };
    }
    return correr(adb, ['shell', 'input', 'keyevent', code], 8000);
  }
  if (accion.type === 'text') {
    // El texto se pasa como argumento (no por shell), así que un espacio o una
    // comilla no pueden inyectar un comando.
    const texto = String(accion.text || '').slice(0, 200);
    if (!texto) {
      return { ok: false, error: 'texto vacío' };
    }
    return correr(adb, ['shell', 'input', 'text', texto.replace(/ /g, '%s')], 8000);
  }
  return { ok: false, error: 'acción desconocida' };
}

// ── iOS ─────────────────────────────────────────────────────────────────
//
// Sale casi gratis: simctl ya está con Xcode y openurl no necesita compilar
// nada. Acá 127.0.0.1 sirve tal cual — el simulador comparte la red del Mac,
// a diferencia del emulador de Android.

export async function iosStatus() {
  const listado = await correr('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  if (!listado.ok) {
    return { disponible: false, motivo: 'No encontré Xcode ni sus simuladores.', dispositivos: [] };
  }
  let datos = {};
  try {
    datos = JSON.parse(listado.salida);
  } catch {
    return { disponible: false, motivo: 'No pude leer la lista de simuladores.', dispositivos: [] };
  }
  const dispositivos = Object.values(datos.devices || {})
    .flat()
    .filter((d) => d.isAvailable && /iPhone/i.test(d.name))
    .map((d) => ({ udid: d.udid, nombre: d.name, arrancado: d.state === 'Booted' }));
  return {
    disponible: dispositivos.length > 0,
    motivo: dispositivos.length === 0 ? 'No hay simuladores de iPhone instalados.' : '',
    dispositivos,
    arrancado: dispositivos.some((d) => d.arrancado)
  };
}

export async function openInIos(companyId, slug) {
  const estado = await iosStatus();
  if (!estado.disponible) {
    return { ok: false, error: estado.motivo };
  }
  const destino = estado.dispositivos.find((d) => d.arrancado) || estado.dispositivos[0];
  if (!destino.arrancado) {
    const arranque = await correr('xcrun', ['simctl', 'boot', destino.udid], 60000);
    if (!arranque.ok) {
      return { ok: false, error: 'No pude arrancar el simulador.' };
    }
    await correr('open', ['-a', 'Simulator']);
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  const url = `http://127.0.0.1:${PORT}/workspace/${companyId}/${slug || 'general'}/`;
  const abrir = await correr('xcrun', ['simctl', 'openurl', 'booted', url], 20000);
  return abrir.ok ? { ok: true, url, dispositivo: destino.nombre } : { ok: false, error: abrir.error };
}
