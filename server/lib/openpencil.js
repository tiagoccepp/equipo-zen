import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// OpenPencil como entorno de diseño real del equipo.
// https://github.com/ZSeven-W/openpencil — MIT, Rust, self-contained.
//
// Qué resuelve: la diseñadora dejaba de "diseñar" escribiendo un theme.js a
// mano y el dev tenía que adivinar la intención. Ahora hay un archivo de diseño
// de verdad (.op, JSON versionable) con sus tokens, que el dev CONSUME en vez de
// reinterpretar. Es el handoff diseño→código que en FASA no existía.
//
// Cómo se maneja: `op` es un cliente HTTP/MCP contra un servidor headless por
// proyecto. Un servidor por proyecto, en su propio puerto, arrancado bajo
// demanda y apagado cuando el proyecto queda quieto.
//
// Verificado en esta máquina: v0.8.2, 160 herramientas MCP, tokens que se
// escriben y se leen, y exportación a PNG del nodo.

const OP_BIN = process.env.OP_BIN || path.join(process.env.HOME || '', '.local', 'bin', 'op');
const DESKTOP_BIN = process.env.OPENPENCIL_DESKTOP_BIN
  || path.join(process.env.HOME || '', '.local', 'bin', 'openpencil-desktop');

// Un puerto por proyecto, estable para el mismo proyecto entre corridas.
const PUERTO_BASE = Number(process.env.OPENPENCIL_PORT_BASE || 3300);
const ARCHIVO_DISENO = 'diseno.op';

// slug → { puerto, arrancando }
const servidores = new Map();

export function disponible() {
  return existsSync(OP_BIN) && existsSync(DESKTOP_BIN);
}

export function motivoNoDisponible() {
  if (!existsSync(OP_BIN)) {
    return 'Falta el CLI de OpenPencil (op). Instalalo con scripts/instalar-openpencil.sh';
  }
  if (!existsSync(DESKTOP_BIN)) {
    return 'Falta el editor de OpenPencil. Instalalo con scripts/instalar-openpencil.sh';
  }
  return '';
}

// Puerto determinístico a partir de la clave del proyecto: el mismo proyecto
// siempre cae en el mismo puerto, así reabrirlo reusa el servidor.
function puertoPara(clave) {
  let hash = 0;
  for (const c of String(clave)) {
    hash = (hash * 31 + c.charCodeAt(0)) % 500;
  }
  return PUERTO_BASE + hash;
}

function correrOp(args, { cwd, puerto, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(OP_BIN, ['--port', String(puerto), ...args], {
      cwd,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENPENCIL_DESKTOP_BIN: DESKTOP_BIN, NO_COLOR: '1' }
    }, (error, stdout, stderr) => {
      const salida = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ ok: !error, salida });
    });
  });
}

// Arranca el servidor de diseño del proyecto (idempotente).
export async function abrirDiseno(dir, clave) {
  if (!disponible()) {
    return { ok: false, motivo: motivoNoDisponible() };
  }
  const puerto = puertoPara(clave);
  const yaEsta = await correrOp(['status'], { cwd: dir, puerto, timeout: 8000 });
  if (yaEsta.ok && /"running"\s*:\s*true/.test(yaEsta.salida)) {
    servidores.set(clave, { puerto });
    return { ok: true, puerto, yaEstaba: true };
  }

  // El editor headless vive lo que dure la sesión: se lo desprende para que no
  // se caiga con el comando que lo arrancó.
  const proceso = spawn(OP_BIN, ['start', '--headless', '--file', ARCHIVO_DISENO, '--port', String(puerto)], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OPENPENCIL_DESKTOP_BIN: DESKTOP_BIN }
  });
  proceso.unref();

  // Esperar a que acepte conexiones. Sin esto, el primer comando falla.
  for (let intento = 0; intento < 20; intento += 1) {
    await new Promise((r) => setTimeout(r, 700));
    const estado = await correrOp(['status'], { cwd: dir, puerto, timeout: 6000 });
    if (estado.ok && /"running"\s*:\s*true/.test(estado.salida)) {
      servidores.set(clave, { puerto });
      return { ok: true, puerto };
    }
  }
  return { ok: false, motivo: 'El editor de diseño no llegó a arrancar.' };
}

export async function cerrarDiseno(dir, clave) {
  const puerto = servidores.get(clave)?.puerto ?? puertoPara(clave);
  await correrOp(['stop'], { cwd: dir, puerto, timeout: 10000 });
  servidores.delete(clave);
}

// Un comando de OpenPencil, con el servidor levantado si hace falta.
export async function diseno(dir, clave, args, { timeout = 120000 } = {}) {
  const abierto = await abrirDiseno(dir, clave);
  if (!abierto.ok) {
    return { ok: false, salida: abierto.motivo };
  }
  return correrOp(args, { cwd: dir, puerto: abierto.puerto, timeout });
}

// ── Lo que el dev consume ───────────────────────────────────────────────
//
// Los tokens del diseño, traducidos al formato del nicho. Esto es el handoff:
// el dev no reinterpreta el diseño, importa exactamente sus valores.

export async function leerTokensDelDiseno(dir) {
  const ruta = path.join(dir, ARCHIVO_DISENO);
  const texto = await fs.readFile(ruta, 'utf-8').catch(() => '');
  if (!texto) {
    return null;
  }
  try {
    const doc = JSON.parse(texto);
    return doc.variables && Object.keys(doc.variables).length ? doc.variables : null;
  } catch {
    return null;
  }
}

// Los tokens como el código del nicho los espera. Se genera, no se pide al
// modelo: traducir un JSON es determinista y gastar una llamada en eso es
// tirar la clave de API a la basura.
export function tokensComoCodigo(variables, stack) {
  if (!variables) {
    return null;
  }
  const entradas = Object.entries(variables).map(([nombre, def]) => ({
    nombre,
    // color/acento → colorAcento ; espacio/md → espacioMd
    js: nombre.split('/').map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('').replace(/[^\w]/g, ''),
    css: `--${nombre.replace(/\//g, '-')}`,
    valor: def?.value,
    tipo: def?.type
  }));

  if (stack === 'movil-rn') {
    return {
      archivo: 'src/theme.js',
      contenido: [
        '// Generado desde el diseño (diseno.op). No editar a mano:',
        '// los valores los define la diseñadora en OpenPencil.',
        'export const tokens = {',
        ...entradas.map((e) => `  ${e.js}: ${typeof e.valor === 'number' ? e.valor : JSON.stringify(e.valor)},`),
        '};',
        ''
      ].join('\n')
    };
  }
  if (stack === 'android') {
    return {
      archivo: 'app/src/main/java/com/equipo/app/ui/Tokens.kt',
      contenido: [
        'package com.equipo.app.ui',
        '',
        '// Generado desde el diseño (diseno.op). No editar a mano.',
        'import androidx.compose.ui.graphics.Color',
        'import androidx.compose.ui.unit.dp',
        '',
        'object Tokens {',
        ...entradas.map((e) => (e.tipo === 'color'
          ? `    val ${e.js} = Color(0xFF${String(e.valor).replace('#', '').toUpperCase()})`
          : `    val ${e.js} = ${e.valor}.dp`)),
        '}',
        ''
      ].join('\n')
    };
  }
  // web y automatización: variables CSS.
  return {
    archivo: 'tokens.css',
    contenido: [
      '/* Generado desde el diseño (diseno.op). No editar a mano:',
      '   los valores los define la diseñadora en OpenPencil. */',
      ':root {',
      ...entradas.map((e) => `  ${e.css}: ${e.tipo === 'number' ? `${e.valor}px` : e.valor};`),
      '}',
      ''
    ].join('\n')
  };
}

// El bloque del prompt. Distinto según el oficio: la diseñadora DISEÑA en
// OpenPencil; el dev LEE ese diseño y lo implementa.
export function renderDiseno({ esDisenador, hayDiseno, tokens, stack }) {
  if (!disponible()) {
    return '';
  }
  if (esDisenador) {
    return [
      '',
      '━━ TU HERRAMIENTA DE DISEÑO: OpenPencil ━━',
      'Tenés un editor de diseño de verdad en la carpeta del proyecto (diseno.op).',
      'Diseñás ahí, no escribiendo código: el dev implementa DESDE tu diseño.',
      '',
      'Con {"action":"comando","cmd":"..."} podés usar:',
      '  op design "<describí la pantalla en palabras>"   ← genera el diseño',
      '  op design:upsert-vars --key tokens:tema.css --file tokens.json',
      '        ↑ tus tokens. El formato es {"color/fondo":{"type":"color","value":"#0F1226"},',
      '          "espacio/md":{"type":"number","value":16}}',
      '  op read-nodes                     (qué hay en el lienzo)',
      '  op export --item <id> --output pantalla.png --format png',
      '        ↑ HACELO: la captura es lo que el usuario mira para aprobar.',
      '  op design:lint                    (¿el diseño es coherente?)',
      '',
      'Tu entregable es diseno.op + al menos una captura .png. Los tokens que',
      'definas ahí se convierten solos en código para el dev: no los escribas vos.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');
  }
  if (!hayDiseno) {
    return '';
  }
  return [
    '',
    '━━ HAY UN DISEÑO HECHO. IMPLEMENTALO, NO LO REINVENTES ━━',
    'La diseñadora dejó el diseño en diseno.op. Sus tokens EXACTOS:',
    tokens ? tokens.contenido : '(sin tokens todavía)',
    '',
    `Ese contenido va en ${tokens ? tokens.archivo : 'el archivo de tokens'} y se usa por referencia.`,
    'Para ver el diseño: {"action":"comando","cmd":"op read-nodes"} te da la estructura,',
    'y las capturas .png del proyecto te muestran cómo tiene que verse.',
    'Si algo del diseño no se puede implementar, consultá a quien lo diseñó — no lo cambies por tu cuenta.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

// ¿Este agente es el que diseña? Por oficio, no por nombre.
export function esAgenteDeDiseno(agent) {
  const texto = `${agent.title} ${(agent.domains || []).join(' ')}`.toLowerCase();
  return /dise[ñn]|arte|ux|ui|material|producto m[oó]vil/.test(texto);
}
