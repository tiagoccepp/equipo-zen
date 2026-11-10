import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// OpenPencil as the team's real design environment.
// https://github.com/ZSeven-W/openpencil — MIT, Rust, self-contained.
//
// What it solves: the designer used to "design" by hand-writing a theme.js and
// the dev had to guess the intent. Now there is a real design file
// (.op, versionable JSON) with its tokens, which the dev CONSUMES instead of
// reinterpreting. It is the design→code handoff that did not exist in FASA.
//
// How it is driven: `op` is an HTTP/MCP client against one headless server per
// project. One server per project, on its own port, started on
// demand and stopped when the project goes idle.
//
// Verified on this machine: v0.8.2, 160 MCP tools, tokens that
// round-trip, and PNG export of the node.

const OP_BIN = process.env.OP_BIN || path.join(process.env.HOME || '', '.local', 'bin', 'op');
const DESKTOP_BIN = process.env.OPENPENCIL_DESKTOP_BIN
  || path.join(process.env.HOME || '', '.local', 'bin', 'openpencil-desktop');

// One port per project, stable for the same project across runs.
const PUERTO_BASE = Number(process.env.OPENPENCIL_PORT_BASE || 3300);
const ARCHIVO_DISENO = 'diseno.op';

// slug → { puerto, arrancando }
const servidores = new Map();

export function disponible() {
  return existsSync(OP_BIN) && existsSync(DESKTOP_BIN);
}

export function motivoNoDisponible() {
  if (!existsSync(OP_BIN)) {
    return 'Missing the OpenPencil CLI (op). Install it with scripts/instalar-openpencil.sh';
  }
  if (!existsSync(DESKTOP_BIN)) {
    return 'Missing the OpenPencil editor. Install it with scripts/instalar-openpencil.sh';
  }
  return '';
}

// Deterministic port from the project key: the same project
// always lands on the same port, so reopening it reuses the server.
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

  // The headless editor lives as long as the session: it is detached so it
  // does not die with the command that started it.
  const proceso = spawn(OP_BIN, ['start', '--headless', '--file', ARCHIVO_DISENO, '--port', String(puerto)], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OPENPENCIL_DESKTOP_BIN: DESKTOP_BIN }
  });
  proceso.unref();

  // Wait until it accepts connections. Without this, the first command fails.
  for (let intento = 0; intento < 20; intento += 1) {
    await new Promise((r) => setTimeout(r, 700));
    const estado = await correrOp(['status'], { cwd: dir, puerto, timeout: 6000 });
    if (estado.ok && /"running"\s*:\s*true/.test(estado.salida)) {
      servidores.set(clave, { puerto });
      return { ok: true, puerto };
    }
  }
  return { ok: false, motivo: 'The design editor failed to start.' };
}

export async function cerrarDiseno(dir, clave) {
  const puerto = servidores.get(clave)?.puerto ?? puertoPara(clave);
  await correrOp(['stop'], { cwd: dir, puerto, timeout: 10000 });
  servidores.delete(clave);
}

// One OpenPencil command, bringing the server up when needed.
export async function diseno(dir, clave, args, { timeout = 120000 } = {}) {
  const abierto = await abrirDiseno(dir, clave);
  if (!abierto.ok) {
    return { ok: false, salida: abierto.motivo };
  }
  return correrOp(args, { cwd: dir, puerto: abierto.puerto, timeout });
}

// ── What the dev consumes ───────────────────────────────────────────────
//
// The design tokens, translated to the niche format. This is the handoff:
// the dev does not reinterpret the design, it imports its exact values.

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

// The tokens as the niche code expects them. Generated, never asked from the
// model: translating a JSON is deterministic and spending a call on that is
// throwing the API key away.
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
        '// Generated from the design (diseno.op). Do not edit by hand:',
        '// values are defined by the designer in OpenPencil.',
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
        '// Generated from the design (diseno.op). Do not edit by hand.',
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
  // web and automatizacion: CSS variables.
  return {
    archivo: 'tokens.css',
    contenido: [
      '/* Generated from the design (diseno.op). Do not edit by hand:',
      '   values are defined by the designer in OpenPencil. */',
      ':root {',
      ...entradas.map((e) => `  ${e.css}: ${e.tipo === 'number' ? `${e.valor}px` : e.valor};`),
      '}',
      ''
    ].join('\n')
  };
}

// The prompt block. Different per craft: the designer DESIGNS in
// OpenPencil; the dev READS that design and implements it.
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

// Is this agent the designer? By craft, not by name.
export function esAgenteDeDiseno(agent) {
  const texto = `${agent.title} ${(agent.domains || []).join(' ')}`.toLowerCase();
  return /dise[ñn]|arte|ux|ui|material|producto m[oó]vil/.test(texto);
}
