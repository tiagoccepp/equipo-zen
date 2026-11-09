import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Entorno de trabajo real: los agentes ejecutan comandos de verdad dentro de la
// carpeta de su proyecto.
//
// Por qué existe: en FASA los agentes escribieron a mano el andamiaje de una app
// React Native y el proyecto quedó sin package.json ni app.json — o sea, sin ser
// una app. Un `create-expo-app` lo resuelve en un comando. Escribir a mano lo que
// una herramienta genera bien es la fuente principal de entregables roto.
//
// Decisión del usuario: pueden usar CUALQUIER comando. Lo que sí se les pide es
// que, cuando el comando es riesgoso, lo justifiquen antes de correrlo — y con
// la justificación, se ejecuta.
//
// La contención NO se hace con patrones. Se probó: `echo x > ../fuera.txt`,
// `cat /ruta/absoluta` y `node -e writeFileSync('/otra/parte')` se escapaban
// todos. Los patrones son un filtro de intención, no una jaula.
//
// La jaula real es sandbox-exec (el seatbelt de macOS): escritura permitida
// SOLO dentro de la carpeta del proyecto y de las cachés que npm/gradle
// necesitan para instalar. Verificado: con el sandbox puesto, ni el shell ni
// node pueden escribir en el home del usuario.
//
// En Linux o si sandbox-exec no está, se cae a los patrones y se AVISA: es
// mejor saber que estás sin jaula que creer que la tenés.

const TIMEOUT_MS = Number(process.env.HERRAMIENTA_TIMEOUT_MS || 300000);
const MAX_SALIDA = 24000;

// Comandos que se consideran RIESGOSOS: se permiten, pero el agente tiene que
// haber explicado para qué. Sin explicación se le pide y se le devuelve el paso.
const RIESGOSOS = [
  /\brm\b/, /\bmv\b/, /\bdd\b/, /\bchmod\b/, /\bchown\b/,
  /\bgit\s+(push|reset|clean|checkout\s+--)/, /\bnpm\s+publish\b/,
  /\bkill(all)?\b/, /\bbrew\s+(uninstall|remove)\b/, />\s*\//
];

// Lo único que NO se ejecuta nunca, con el motivo que se le devuelve al agente.
// Todo apunta a lo mismo: salir del proyecto o romper la máquina del usuario.
const PROHIBIDO = [
  [/\bsudo\b|\bdoas\b/, 'no need for root to build a product'],
  // Cualquier rm que apunte a una ruta absoluta o al home. `rm -rf node_modules`
  // (relativo, dentro del proyecto) sigue permitido: es trabajo normal.
  [/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\$\{HOME\})/, 'that would delete things outside the project'],
  [/\b(shutdown|reboot|halt|mkfs|diskutil|fdisk)\b/, 'leave the operating system alone'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba)?sh/, 'do not run a script downloaded from the internet without reading it'],
  [/\bgit\s+push\b/, 'work is delivered in the project folder, not published'],
  [/\b(ssh|scp|rsync)\b.*@/, 'no reaching out to other machines'],
  [/\b(launchctl|systemctl|crontab)\b/, 'no installing services or scheduled tasks'],
  [/\.\.\/\.\.\//, 'that path leaves the project folder'],
  [/\b(cd|pushd)\s+(\/|~|\$HOME)/, 'the command runs inside the project and stays there'],
  [/\bhistory\b|\.ssh\b|\.env\b|id_rsa|credentials/, 'no reading credentials or secrets']
];

// En VIVO (turno de voz/texto con Manos) no hay ida y vuelta para pedir
// justificación: lo riesgoso se NIEGA en vez de pedir el "porque".
// Lista que se niega en vivo (además de PROHIBIDO, que niega siempre):
// - `rm -rf` y cualquier rm/mv (borrado o movimiento, aunque sea relativo)
// - `dd`, `chmod`, `chown` (disco y permisos)
// - `git push --force` / reset / clean / checkout -- (reescritura)
// - `npm publish`, `kill`, `brew uninstall/remove` (publicar, matar, desinstalar)
// - `chmod -R 777` (permisos abiertos de par en par)
// - fork bomb `:(){ :|:& };:` (no está en RIESGOSOS: patrón propio acá)
// Ya negados SIEMPRE por PROHIBIDO (figuran igual para que la lista sea
// completa): mkfs, shutdown/reboot, curl|wget pipeado a shell, git push.
const RIESGOSO_SOLO_VIVO = [
  [/:\(\)\s*\{/, 'fork bomb']
];

export function clasificarComando(comando, { voice = false } = {}) {
  const texto = String(comando || '').trim();
  if (!texto) {
    return { permitido: false, motivo: 'empty command' };
  }
  if (texto.length > 2000) {
    return { permitido: false, motivo: 'command too long' };
  }
  for (const [patron, motivo] of PROHIBIDO) {
    if (patron.test(texto)) {
      return { permitido: false, motivo };
    }
  }
  const riesgoso = RIESGOSOS.some((p) => p.test(texto))
    || RIESGOSO_SOLO_VIVO.some(([p]) => p.test(texto));
  if (voice && riesgoso) {
    return { permitido: false, riesgoso: true, motivo: 'risky command denied live — ask me as project work and I will do it there' };
  }
  return { permitido: true, riesgoso };
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function contencionReal() {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

// Perfil de seatbelt: se puede LEER casi todo (node, gradle y npm necesitan
// leer el sistema entero) pero ESCRIBIR solo en el proyecto y en las cachés de
// los gestores de paquetes. Sin esas cachés, `npm install` falla.
// El perfil necesita rutas CANÓNICAS: en macOS /var es un enlace a /private/var
// y el seatbelt resuelve los enlaces, así que una ruta sin resolver no matchea
// y termina negando escrituras legítimas (rompió el trabajo en /tmp).
function canonica(ruta) {
  try {
    return realpathSync(ruta);
  } catch {
    return ruta;
  }
}

function escribirPerfil(cwd) {
  const home = os.homedir();
  const cacheables = [
    path.join(home, '.npm'),
    path.join(home, '.cache'),
    path.join(home, '.gradle'),
    path.join(home, '.expo'),
    path.join(home, '.bun'),
    path.join(home, 'Library', 'Caches'),
    path.join(home, 'Library', 'Android'),
    os.tmpdir()
  ];
  // Las dos formas de cada ruta (la de siempre y la canónica): así matchea
  // tanto si el proceso usa /var como /private/var.
  const permitidas = [...new Set([cwd, canonica(cwd), ...cacheables, ...cacheables.map(canonica)])];
  const perfil = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...permitidas.map((r) => `  (subpath ${JSON.stringify(r)})`),
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper") (literal "/dev/tty")',
    '  (regex #"^/dev/fd/")',
    ')'
  ].join('\n');

  const dir = path.join(os.tmpdir(), 'equipo-sandbox');
  mkdirSync(dir, { recursive: true });
  const ruta = path.join(dir, `perfil-${Buffer.from(cwd).toString('hex').slice(-24)}.sb`);
  writeFileSync(ruta, perfil, 'utf-8');
  return ruta;
}

// Ejecuta dentro de la carpeta del proyecto. Nunca lanza: los errores son
// resultado, porque para el agente un comando que falla es información.
export function ejecutar(comando, cwd, { timeoutMs = TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(cwd)) {
      resolve({ ok: false, codigo: -1, salida: `La carpeta del proyecto no existe: ${cwd}` });
      return;
    }
    // Shell de login NO: no se heredan alias ni funciones del usuario, y el
    // comando es exactamente el que se ve en el registro.
    const [programa, argumentos] = contencionReal()
      ? [SANDBOX_EXEC, ['-f', escribirPerfil(path.resolve(cwd)), '/bin/sh', '-c', comando]]
      : ['/bin/sh', ['-c', comando]];
    const hijo = spawn(programa, argumentos, {
      cwd,
      env: {
        ...process.env,
        ...env,
        // Sin color ni paginador: la salida va a un prompt, no a una terminal.
        NO_COLOR: '1',
        CI: '1',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        npm_config_yes: 'true',
        // Los agentes no pueden responder preguntas interactivas.
        DEBIAN_FRONTEND: 'noninteractive'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let salida = '';
    let cortada = false;
    const sumar = (trozo) => {
      if (salida.length < MAX_SALIDA) {
        salida += trozo;
      } else {
        cortada = true;
      }
    };
    hijo.stdout.on('data', (d) => sumar(String(d)));
    hijo.stderr.on('data', (d) => sumar(String(d)));

    const reloj = setTimeout(() => {
      hijo.kill('SIGKILL');
      resolve({
        ok: false,
        codigo: -1,
        expiro: true,
        salida: `${salida.slice(0, MAX_SALIDA)}\n[el comando tardó más de ${Math.round(timeoutMs / 1000)}s y se cortó]`
      });
    }, timeoutMs);

    hijo.on('error', (error) => {
      clearTimeout(reloj);
      resolve({ ok: false, codigo: -1, salida: `No pude ejecutarlo: ${error.message}` });
    });

    hijo.on('close', (codigo) => {
      clearTimeout(reloj);
      let texto = salida.slice(0, MAX_SALIDA) + (cortada ? '\n[salida recortada]' : '');
      // "Operation not permitted" con el sandbox puesto casi siempre es un
      // intento de escribir afuera: se le explica, porque si no el agente
      // insiste con permisos.
      if (/Operation not permitted/.test(texto) && contencionReal()) {
        texto += '\n[el comando quiso escribir FUERA de la carpeta del proyecto y el sistema lo impidió. Trabajá adentro del proyecto.]';
      }
      resolve({ ok: codigo === 0, codigo, salida: texto.trim() || '(sin salida)', contenido: contencionReal() });
    });
  });
}

// El bloque del prompt que le enseña la herramienta. Corto a propósito: el
// protocolo de acciones compite con todo lo demás que hay en el prompt.
export function renderHerramientas(stack) {
  const porNicho = {
    'movil-rn': [
      'npx create-expo-app@latest . --template blank   ← ANDAMIÁ ASÍ, no a mano',
      'npx tsc --noEmit          (¿compila?)',
      'npx expo-doctor           (¿el proyecto está sano?)'
    ],
    android: [
      'gradle assembleDebug      (¿compila?)',
      'gradle tasks              (qué hay disponible)'
    ],
    web: [
      'npx prettier --write .    (formatear)',
      'node app.js               (probar un script)'
    ],
    automatizacion: [
      'node flujo.js             (correrlo de verdad con los datos de ejemplo)',
      'npx prettier --write .'
    ],
    python: [
      'python3 main.py           ← CORRELO con los datos de ejemplo',
      'python3 -m pytest -q      (¿pasan las pruebas?)',
      'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
      'python3 -m ruff check .   (si está)'
    ]
  };
  const utiles = porNicho[stack] || porNicho.web;
  return [
    '- Para EJECUTAR un comando en la carpeta del proyecto:',
    '{"action":"comando","cmd":"lo que sea","porque":"para qué lo necesitás"}',
    '  Tenés una terminal de verdad. Usala: andamiar con la herramienta oficial sale',
    '  mejor que escribir el andamiaje a mano, y podés VERIFICAR lo que hiciste.',
    `  Útiles acá: ${utiles.join(' · ')}`,
    '  Si el comando es riesgoso (borra, mueve, mata procesos), explicá en "porque"',
    '  por qué hace falta: con eso se ejecuta.'
  ].join('\n');
}

// Lo que el agente lee después de correr algo.
export function renderResultado(comando, resultado) {
  const cabeza = resultado.ok
    ? `El comando terminó bien (código 0):`
    : `El comando falló (código ${resultado.codigo}):`;
  return [
    `$ ${comando}`,
    cabeza,
    resultado.salida.slice(0, 6000),
    resultado.ok
      ? ''
      : 'Leé el error y arreglalo. Si el comando no era el adecuado, probá otro.'
  ].filter(Boolean).join('\n');
}
