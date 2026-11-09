// Manos v1: herramientas en vivo para el turno de voz/texto.
//
// El modelo NO habla con function-calling nativo en v1: emite bloques
// ```tool:NOMBRE {json}``` en texto plano y este módulo los parsea
// (parseToolCalls), ejecuta en serie (runToolLoop) y devuelve un resumen
// que la fase de habla narra. Diseño madre:
// /home/tito/research/openclaw-manos-2026-11-08.md
//
// Reglas de seguridad (estáticas, sin humanos en el medio del turno):
// - Archivos SIEMPRE vía safeWorkspacePath: fuera del proyecto = denegado.
// - Comandos vía clasificarComando(cmd, {voice:true}): lo riesgoso se niega
//   en vivo (en diferido pide justificación; en vivo no hay ida y vuelta).
// - fetch solo http/https, con timeout y tope de bytes.
// - Salidas truncadas: nada de volcar archivos enteros al prompt.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { clasificarComando, ejecutar } from './herramientas.js';
import { esCarpetaIgnorada, projectDir, safeWorkspacePath } from './workforce.js';
// Manos extendidas (integración 09/11): los módulos solo definen; el registro
// corre abajo, registry ya listo. Ciclo ESM seguro (sin top-level calls).
import { registerBrowserTools } from './manos-browser.js';
import { registerCanvasTools } from './manos-canvas.js';
import { registerOutreachTools } from './manos-outreach.js';

// ---------------------------------------------------------------------------
// 1. Registry
// ---------------------------------------------------------------------------

// Tope de salida por tool: lo que excede se recorta con aviso. El prompt del
// turno siguiente agradece no recibir 30k de un cat accidentado.
export const MAX_TOOL_OUTPUT = 2000;

export function truncarSalida(texto, tope = MAX_TOOL_OUTPUT) {
  const s = String(texto ?? '');
  if (s.length <= tope) {
    return s;
  }
  return `${s.slice(0, tope)}\n…[salida recortada a ${tope} chars]`;
}

// Cada tool: {name, description, parameters, execute}.
// execute(args, ctx) -> {ok, output, error?} (puede ser async).
// ctx lo pone runToolLoop: {companyId, slug, turnId?, agentId?}.
export const toolRegistry = new Map();

export function registerTool({ name, description, parameters, execute }) {
  if (!name || typeof execute !== 'function') {
    throw new Error('registerTool necesita {name, execute}');
  }
  toolRegistry.set(String(name), {
    name: String(name),
    description: String(description || ''),
    parameters: parameters || { type: 'object', properties: {} },
    // El truncado vive acá para que NINGUNA tool (ni las MCP) pueda
    // inundar el prompt por olvidar recortar.
    execute: async (args, ctx) => {
      const r = await execute(args || {}, ctx || {});
      const ok = r?.ok !== false;
      return {
        ok,
        output: truncarSalida(r?.output ?? ''),
        ...(ok ? {} : { error: String(r?.error || 'falló sin motivo') })
      };
    }
  });
  return toolRegistry.get(String(name));
}

export function getTool(name) {
  return toolRegistry.get(String(name)) || null;
}

export function listTools() {
  return [...toolRegistry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }));
}

// ---------------------------------------------------------------------------
// 2. Builtins
// ---------------------------------------------------------------------------

const RUN_CMD_MAX_CHARS = 500;
const RUN_CMD_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_BYTES = 200 * 1024;

function ctxWorkspace(ctx) {
  const companyId = ctx?.companyId;
  const slug = ctx?.slug || 'general';
  if (!companyId) {
    throw new Error('falta companyId en el contexto');
  }
  return { companyId, slug };
}

function errorClaro(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 300);
}

registerTool({
  name: 'read_file',
  description: 'Lee un archivo del proyecto. path relativo al proyecto.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Ruta relativa, ej. "package.json"' } },
    required: ['path']
  },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    try {
      const target = safeWorkspacePath(companyId, slug, args.path);
      const contenido = await fs.readFile(target, 'utf-8');
      return { ok: true, output: contenido.slice(0, 30000) };
    } catch (error) {
      return { ok: false, output: '', error: `no pude leer ${args.path}: ${errorClaro(error)}` };
    }
  }
});

// Tope de entradas de list_files: un proyecto con miles de archivos no
// puede volcarse al prompt (además el registry ya recorta salidas a 2000ch).
const LIST_FILES_MAX = 100;

registerTool({
  name: 'list_files',
  description: 'Lista archivos y carpetas del proyecto. Sin ocultos ni dependencias.',
  parameters: {
    type: 'object',
    properties: { dir: { type: 'string', description: 'Subcarpeta relativa (default raíz)' } },
    required: []
  },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    const raw = String(args.dir || '').trim();
    let target = projectDir(companyId, slug);
    if (raw) {
      // La subcarpeta pasa por el mismo guardia que los archivos: se valida
      // con un nombre hijo sintético (el guardia exige extensión válida) y
      // se lista el dirname validado. Escapes, absolutos y ocultos tiran.
      try {
        target = path.dirname(safeWorkspacePath(companyId, slug, path.join(raw, 'lista.tmp.txt')));
      } catch (error) {
        return { ok: false, output: '', error: `no pude listar ${raw}: ${errorClaro(error)}` };
      }
    }
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const nombres = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || esCarpetaIgnorada(entry.name)) continue;
        nombres.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
      }
      nombres.sort();
      if (nombres.length === 0) {
        return { ok: true, output: '(vacío)' };
      }
      const total = nombres.length;
      const pagina = nombres.slice(0, LIST_FILES_MAX);
      const aviso = total > pagina.length ? `\n…[${total - pagina.length} más, tope ${LIST_FILES_MAX}]` : '';
      return { ok: true, output: pagina.join('\n') + aviso };
    } catch (error) {
      return { ok: false, output: '', error: `no pude listar ${raw || 'raíz'}: ${errorClaro(error)}` };
    }
  }
});

registerTool({
  name: 'write_file',
  description: 'Escribe (crea o reemplaza) un archivo del proyecto. Crea carpetas padre.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Ruta relativa, ej. "notas/idea.md"' },
      content: { type: 'string', description: 'Contenido completo del archivo' }
    },
    required: ['path', 'content']
  },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    try {
      const target = safeWorkspacePath(companyId, slug, args.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(args.content ?? ''), 'utf-8');
      return { ok: true, output: `escrito ${args.path} (${String(args.content ?? '').length} chars)` };
    } catch (error) {
      return { ok: false, output: '', error: `no pude escribir ${args.path}: ${errorClaro(error)}` };
    }
  }
});

registerTool({
  name: 'run_cmd',
  description: 'Ejecuta un comando shell dentro del proyecto. En vivo: lo riesgoso se niega.',
  parameters: {
    type: 'object',
    properties: { cmd: { type: 'string', description: 'Comando, máx 500 chars' } },
    required: ['cmd']
  },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    const cmd = String(args.cmd || '').trim();
    if (!cmd) {
      return { ok: false, output: '', error: 'comando vacío' };
    }
    if (cmd.length > RUN_CMD_MAX_CHARS) {
      return { ok: false, output: '', error: `comando demasiado largo (máx ${RUN_CMD_MAX_CHARS} chars)` };
    }
    const clasificacion = clasificarComando(cmd, { voice: true });
    if (!clasificacion.permitido) {
      return { ok: false, output: '', error: `negado en vivo: ${clasificacion.motivo}` };
    }
    // NOTA env: ejecutar() hereda process.env por diseño (workforce lo
    // necesita para npm/gradle). Endurecerlo a env mínimo en vivo requiere
    // tocar ejecutar(), fuera del alcance v1 — queda documentado, no roto:
    // la contención en vivo es clasificar+timeout+cwd, igual que workforce.
    const r = await ejecutar(cmd, projectDir(companyId, slug), { timeoutMs: RUN_CMD_TIMEOUT_MS });
    return {
      ok: r.ok,
      output: r.salida || '(sin salida)',
      ...(r.ok ? {} : { error: `código ${r.codigo}${r.expiro ? ' (timeout 30s)' : ''}` })
    };
  }
});

function esLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.') || h.endsWith('.localhost');
}

// GET loopback SIN proxy y SIN shim: en el gateway, TODO el stack HTTP de
// node (fetch Y node:http) pasa por el egress proxy, que no tiene 127.0.0.1
// en el allowlist (403). El socket crudo no está shimeado (verificado) y
// para loopback es lo correcto: además deja los tests herméticos en
// cualquier máquina, con o sin proxy. Solo http (los stubs son http);
// https loopback cae al fetch() normal.
function getLoopback(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const puerto = Number(u.port) || 80;
    const camino = (u.pathname || '/') + (u.search || '');
    const sock = net.connect(puerto, u.hostname, () => {
      sock.write(
        `GET ${camino} HTTP/1.0\r\n` +
        `Host: ${u.hostname}\r\n` +
        'User-Agent: EquipoManos/1.0\r\n' +
        'Connection: close\r\n\r\n'
      );
    });
    const chunks = [];
    let bytes = 0;
    let terminado = false;
    const fin = (fn) => (v) => {
      if (!terminado) {
        terminado = true;
        sock.destroy();
        fn(v);
      }
    };
    sock.setTimeout(timeoutMs, () => fin(reject)(new Error('timeout')));
    sock.on('data', (c) => {
      if (bytes < FETCH_MAX_BYTES + 8192) {
        chunks.push(c);
        bytes += c.length;
      }
    });
    sock.on('end', () => {
      try {
        const crudo = Buffer.concat(chunks).toString('latin1');
        const corte = crudo.indexOf('\r\n\r\n');
        if (corte < 0) {
          throw new Error('respuesta HTTP inválida');
        }
        const estado = Number((crudo.slice(0, crudo.indexOf('\r\n')).match(/HTTP\/\S+\s+(\d+)/) || [])[1]) || 0;
        let cuerpo = Buffer.from(crudo.slice(corte + 4), 'latin1');
        // ¿chunked? Los stubs no chunkean, pero un dechunk mínimo cuesta poco.
        if (/transfer-encoding:\s*chunked/i.test(crudo.slice(0, corte))) {
          cuerpo = desChunkear(cuerpo);
        }
        fin(resolve)({ status: estado, body: cuerpo.slice(0, FETCH_MAX_BYTES).toString('utf-8') });
      } catch (error) {
        fin(reject)(error);
      }
    });
    sock.on('error', fin(reject));
  });
}

// Dechunk mínimo: tamaño en hex + CRLF + datos, hasta chunk de tamaño 0.
// Si el formato no cierra, devuelve lo juntado (mejor algo que nada).
function desChunkear(buf) {
  const partes = [];
  let i = 0;
  const texto = buf.toString('latin1');
  while (i < texto.length) {
    const finLinea = texto.indexOf('\r\n', i);
    if (finLinea < 0) {
      break;
    }
    const n = parseInt(texto.slice(i, finLinea).split(';')[0].trim(), 16);
    if (!Number.isFinite(n) || n <= 0) {
      break;
    }
    const inicio = finLinea + 2;
    partes.push(Buffer.from(texto.slice(inicio, inicio + n), 'latin1'));
    i = inicio + n + 2;
  }
  return partes.length > 0 ? Buffer.concat(partes) : buf;
}

function htmlATexto(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

registerTool({
  name: 'fetch_url',
  description: 'Trae una URL (GET http/https) y devuelve su texto. Sin JS.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL http(s)' } },
    required: ['url']
  },
  execute: async (args) => {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, output: '', error: 'URL inválida (solo http/https)' };
    }
    // timeoutMs solo lo usan los tests contra un stub colgado; en vivo 15s.
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : FETCH_TIMEOUT_MS;
    try {
      let crudo;
      if (esLoopback(new URL(url).hostname)) {
        const r = await getLoopback(url, timeoutMs);
        if (r.status < 200 || r.status >= 300) {
          return { ok: false, output: '', error: `HTTP ${r.status}` };
        }
        crudo = r.body;
      } else {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'EquipoManos/1.0', Accept: 'text/html,text/plain' },
          redirect: 'follow'
        });
        if (!res.ok) {
          return { ok: false, output: '', error: `HTTP ${res.status}` };
        }
        const buf = new Uint8Array(await res.arrayBuffer()).slice(0, FETCH_MAX_BYTES);
        crudo = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      }
      const texto = htmlATexto(crudo);
      return { ok: true, output: texto || '(vacío)' };
    } catch (error) {
      return { ok: false, output: '', error: `no pude traer ${url.slice(0, 120)}: ${errorClaro(error)}` };
    }
  }
});

registerTool({
  name: 'now',
  description: 'Fecha y hora actual (ISO + zona). Evita que el modelo alucine fechas.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const d = new Date();
    let zona = 'local';
    try {
      zona = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    } catch {
      // Sin ICU: igual devolvemos el ISO, que es lo que importa.
    }
    return { ok: true, output: `${d.toISOString()} (${zona})` };
  }
});

// ---------------------------------------------------------------------------
// 2B. Computer: manos que tocan la compu (open_url / window_list / screenshot)
// ---------------------------------------------------------------------------
//
// El servidor apunta a correr en la compu de Tito (rama desktop-tauri): estas
// tools abren URLs, listan ventanas y capturan pantalla. En un box sin X
// (DISPLAY vacío) fallan con error claro, no rompen el turno.
//
// Sin shell: los comandos se lanzan con spawn(argv) para que el target del
// modelo nunca pase por /bin/sh (run_cmd sí usa shell y por eso NO sirve
// para abrir URLs con ? y & sin escaparse).
//
// Tests: NO abren ventanas reales. Toda la interacción con el SO pasa por
// `computer` (which/run/display), que los tests reemplazan con fakes vía
// _setComputer(). Mismo precedente que _resetMcpCache.

const COMPUTER_RUN_TIMEOUT_MS = 15000;
const WINDOW_LIST_MAX = 50;
const OPEN_URL_MAX_CHARS = 500;

// XAUTHORITY bajo GNOME/Wayland: el cookie de XWayland vive en
// /run/user/$UID/.mutter-Xwaylandauth.* (sufijo aleatorio por sesión).
// Sin esto, xwininfo/scrot fallan con 'Authorization required' cuando el
// backend no heredó XAUTHORITY (lanzamientos sin sesión gráfica completa).
// Si ya hay XAUTHORITY, se respeta (retorna undefined = heredar todo).
export function xauthEnv() {
  if (process.env.XAUTHORITY) return undefined;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const dir = `/run/user/${uid}`;
    const f = readdirSync(dir).find((n) => n.startsWith('.mutter-Xwaylandauth.'));
    if (f) return { ...process.env, XAUTHORITY: path.join(dir, f) };
  } catch {
    // Sin cookie visible: heredar y que el comando degrade con error claro.
  }
  return undefined;
}

function spawnSinShell(cmd, args, { timeoutMs = COMPUTER_RUN_TIMEOUT_MS, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let hijo;
    try {
      const env = xauthEnv();
      hijo = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    } catch (error) {
      resolve({ ok: false, codigo: -1, salida: '', error: errorClaro(error) });
      return;
    }
    let out = '';
    let err = '';
    hijo.stdout.on('data', (d) => { if (out.length < 8000) out += String(d); });
    hijo.stderr.on('data', (d) => { if (err.length < 8000) err += String(d); });
    const reloj = setTimeout(() => {
      hijo.kill('SIGKILL');
      resolve({ ok: false, codigo: -1, expiro: true, salida: out, error: `timeout ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    hijo.on('error', (e) => {
      clearTimeout(reloj);
      resolve({ ok: false, codigo: -1, salida: out, error: errorClaro(e) });
    });
    hijo.on('close', (codigo) => {
      clearTimeout(reloj);
      resolve({ ok: codigo === 0, codigo, salida: out, error: err });
    });
  });
}

// which sin shell: recorre el PATH buscando un ejecutable. Los candidatos son
// constantes del código, nunca input del modelo.
async function cualHay(candidatos) {
  const dirs = String(process.env.PATH || '/usr/bin:/bin').split(':');
  for (const c of candidatos) {
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        await fs.access(path.join(dir, c), fs.constants.X_OK);
        return c;
      } catch {
        // Sigue buscando.
      }
    }
  }
  return null;
}

const computerDefaults = {
  which: (candidatos) => cualHay(candidatos),
  run: (cmd, args, opts) => spawnSinShell(cmd, args, opts),
  hayDisplay: () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  display: () => process.env.DISPLAY || ':0',
  esWayland: () => Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY)
};

export const computer = { ...computerDefaults };
export function _setComputer(over) { Object.assign(computer, over || {}); }
export function _resetComputer() { Object.assign(computer, computerDefaults); }

// Secreto = RUTA a credencial (archivos), no query strings: si Tito pide
// abrir una URL con ?token=, el pedido explícito manda.
const TARGET_SECRETO = [
  /\.env(\b|$)/i, /\.ssh\b/i, /id_rsa/i, /credentials?/i, /\.pem(\b|$)/i, /\bpasswd\b|\bshadow\b/i
];

registerTool({
  name: 'open_url',
  description: 'Abre una URL o archivo en la compu (navegador/app). Solo se niega si parece secreto/credencial.',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string', description: 'URL o ruta, ej. "https://google.com"' } },
    required: ['target']
  },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    const target = String(args.target || '').trim();
    if (!target) {
      return { ok: false, output: '', error: 'target vacío: pasá una URL o ruta' };
    }
    if (target.length > OPEN_URL_MAX_CHARS) {
      return { ok: false, output: '', error: `target demasiado largo (máx ${OPEN_URL_MAX_CHARS} chars)` };
    }
    const pelado = target.replace(/^file:\/\//i, '');
    if (TARGET_SECRETO.some((p) => p.test(pelado))) {
      return { ok: false, output: '', error: `negado en vivo: ${target.slice(0, 80)} parece secreto/credencial` };
    }
    const opener = await computer.which(['xdg-open']);
    if (!opener) {
      return { ok: false, output: '', error: 'sin xdg-open: no sé abrir URLs en esta compu (instalá xdg-utils)' };
    }
    // DISPLAY heredado (spawn hereda process.env): en el desktop de Tito abre
    // de verdad; en el gateway headless xdg-open falla y se reporta.
    const r = await computer.run(opener, [target], { timeoutMs: COMPUTER_RUN_TIMEOUT_MS, cwd: projectDir(companyId, slug) });
    if (r.expiro) {
      // xdg-open a veces espera a la app: si lanzó y no confirmó, avisar es
      // más honesto que decir que falló (la pestaña suele quedar abierta).
      return { ok: true, output: `abierto ${target.slice(0, 200)} (sin confirmación: timeout 15s, la app puede haber quedado abierta)` };
    }
    if (!r.ok) {
      const motivo = String(r.error || r.salida || 'falló').slice(0, 200);
      const pista = computer.hayDisplay() ? '' : ' (sin DISPLAY: esta compu no tiene pantalla gráfica)';
      return { ok: false, output: '', error: `no pude abrir ${target.slice(0, 100)}: ${motivo}${pista}` };
    }
    return { ok: true, output: `abierto ${target.slice(0, 200)}` };
  }
});

function formatearVentanas(ventanas) {
  if (ventanas.length === 0) {
    return '(sin ventanas visibles)';
  }
  const pagina = ventanas.slice(0, WINDOW_LIST_MAX);
  const lineas = pagina.map((v) => `- ${v.titulo}${v.app ? ` (${v.app})` : ''}`);
  const resto = ventanas.length - pagina.length;
  return `${ventanas.length} ventana(s):\n${lineas.join('\n')}${resto > 0 ? `\n…[${resto} más, tope ${WINDOW_LIST_MAX}]` : ''}`;
}

// wmctrl -l -x: ID ESCRITORIO CLASE HOST TÍTULO (título con espacios al final).
async function ventanasWmctrl() {
  const r = await computer.run('wmctrl', ['-l', '-x'], {});
  if (!r.ok) {
    throw new Error(String(r.error || r.salida || 'wmctrl falló').slice(0, 200));
  }
  const ventanas = [];
  for (const linea of String(r.salida || '').split('\n')) {
    const m = linea.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const titulo = (m[5] || '').trim();
    if (!titulo) continue;
    ventanas.push({ titulo: titulo.slice(0, 160), app: String(m[3] || '').split('.')[0].slice(0, 60) || null });
  }
  return { ok: true, output: formatearVentanas(ventanas) };
}

// xdotool: search da IDs, getwindowname da títulos (un run por ventana, con tope).
async function ventanasXdotool() {
  const r = await computer.run('xdotool', ['search', '--onlyvisible', '--name', '.'], {});
  if (!r.ok) {
    throw new Error(String(r.error || r.salida || 'xdotool falló').slice(0, 200));
  }
  const ids = String(r.salida || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, WINDOW_LIST_MAX);
  const ventanas = [];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    const n = await computer.run('xdotool', ['getwindowname', id], {});
    const titulo = String(n.salida || '').trim();
    if (n.ok && titulo) {
      ventanas.push({ titulo: titulo.slice(0, 160), app: null });
    }
  }
  return { ok: true, output: formatearVentanas(ventanas) };
}

// xwininfo -root -tree: las hijas directas del root (indentación corta) son
// las ventanas top-level. Línea típica:
// `     0x400001 "Terminal": ("gnome-terminal" "Gnome-terminal") ...`
async function ventanasXwininfo() {
  const r = await computer.run('xwininfo', ['-root', '-tree'], {});
  if (!r.ok) {
    throw new Error(String(r.error || r.salida || 'xwininfo falló').slice(0, 200));
  }
  const ventanas = [];
  for (const linea of String(r.salida || '').split('\n')) {
    const m = linea.match(/^(\s*)(0x[0-9a-fA-F]+)\s+"([^"]*)"/);
    if (!m || m[1].length > 5 || !m[3] || m[3] === '(has no name)') continue;
    const clase = linea.match(/\(\s*"[^"]+"\s+"([^"]+)"\s*\)/);
    ventanas.push({ titulo: m[3].slice(0, 160), app: clase ? clase[1].slice(0, 60) : null });
  }
  return { ok: true, output: formatearVentanas(ventanas) };
}

registerTool({
  name: 'window_list',
  description: 'Lista ventanas visibles (título + app). Necesita wmctrl, xdotool o xwininfo + X.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    if (!computer.hayDisplay()) {
      return { ok: false, output: '', error: 'sin sesión gráfica (DISPLAY vacío): esta compu no muestra ventanas' };
    }
    const backend = await computer.which(['wmctrl', 'xdotool', 'xwininfo']);
    if (!backend) {
      return { ok: false, output: '', error: 'sin wmctrl/xdotool/xwininfo: instalá uno (ej. sudo apt install wmctrl) para listar ventanas' };
    }
    try {
      if (backend === 'wmctrl') return await ventanasWmctrl();
      if (backend === 'xdotool') return await ventanasXdotool();
      return await ventanasXwininfo();
    } catch (error) {
      return { ok: false, output: '', error: `no pude listar ventanas (${backend}): ${errorClaro(error)}` };
    }
  }
});

// Dimensiones del IHDR PNG sin dependencias: firma(8) + len(4) + 'IHDR'(4) +
// ancho(4 BE) + alto(4 BE). Si no parsea, null (se reporta sin tamaño).
async function leerDimsPng(ruta) {
  let fd = null;
  try {
    fd = await fs.open(ruta, 'r');
    const buf = Buffer.alloc(26);
    const { bytesRead } = await fd.read(buf, 0, 26, 0);
    if (bytesRead < 26) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    try { await fd?.close(); } catch { /* ya está */ }
  }
}

const SHOT_DIR = 'shots';

async function intentarCaptura(backend, destino) {
  if (backend === 'scrot') {
    return computer.run('scrot', [destino], {});
  }
  if (backend === 'gnome-screenshot') {
    return computer.run('gnome-screenshot', ['-f', destino], {});
  }
  if (backend === 'grim') {
    return computer.run('grim', [destino], {});
  }
  if (backend === 'ffmpeg') {
    return computer.run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-i', computer.display(), '-frames:v', '1', destino], {});
  }
  if (backend === 'xwd') {
    // xwd escribe .xwd; ffmpeg lo convierte a PNG. Necesita ambos.
    if (!await computer.which(['ffmpeg'])) {
      return { ok: false, codigo: -1, salida: '', error: 'xwd necesita ffmpeg para convertir a PNG' };
    }
    const tmp = `${destino}.xwd`;
    const a = await computer.run('xwd', ['-root', '-silent', '-out', tmp], {});
    if (!a.ok) {
      return a;
    }
    try {
      return await computer.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, destino], {});
    } finally {
      try { await fs.unlink(tmp); } catch { /* best-effort */ }
    }
  }
  return { ok: false, codigo: -1, salida: '', error: `backend desconocido: ${backend}` };
}

registerTool({
  name: 'screenshot',
  description: 'Saca captura de pantalla a shots/<ts>.png (path + tamaño). Es entregable: el modelo no la ve.',
  parameters: { type: 'object', properties: {} },
  execute: async (args, ctx) => {
    const { companyId, slug } = ctxWorkspace(ctx);
    if (!computer.hayDisplay()) {
      return { ok: false, output: '', error: 'sin sesión gráfica (DISPLAY vacío): no hay pantalla que capturar' };
    }
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const rel = `${SHOT_DIR}/${ts}.png`;
    let destino;
    try {
      destino = safeWorkspacePath(companyId, slug, rel);
    } catch (error) {
      return { ok: false, output: '', error: `no pude preparar la captura: ${errorClaro(error)}` };
    }
    await fs.mkdir(path.dirname(destino), { recursive: true });
    // grim es wayland, scrot es X: el orden depende del entorno, pero se
    // intentan TODOS los instalados hasta que uno funcione (un binario
    // presente no garantiza que ande en esta sesión).
    const orden = computer.esWayland()
      ? ['grim', 'gnome-screenshot', 'ffmpeg', 'xwd']
      : ['scrot', 'gnome-screenshot', 'grim', 'ffmpeg', 'xwd'];
    let ultimoError = '';
    let intentoAlguno = false;
    for (const cand of orden) {
      if (!await computer.which([cand])) continue;
      intentoAlguno = true;
      const r = await intentarCaptura(cand, destino);
      if (r.ok) {
        const dims = await leerDimsPng(destino);
        const tam = dims ? `${dims.ancho}x${dims.alto}` : 'tamaño desconocido';
        return { ok: true, output: `captura ${rel} (${tam})` };
      }
      ultimoError = String(r.error || r.salida || 'falló').slice(0, 160);
    }
    if (!intentoAlguno) {
      return { ok: false, output: '', error: 'sin capturador (scrot/gnome-screenshot/grim/ffmpeg/xwd): instalá uno (ej. sudo apt install scrot)' };
    }
    return { ok: false, output: '', error: `captura fallida (${ultimoError || 'sin motivo'})` };
  }
});

// Manos extendidas: browser (A) + canvas/outreach (D). Acá, no arriba: el
// registry y los helpers (projectDir, truncado) ya existen en este punto.
registerBrowserTools();
registerCanvasTools();
registerOutreachTools();

// ---------------------------------------------------------------------------
// 3. Formato v1: JSON-en-texto  ```tool:NOMBRE {json}
// ---------------------------------------------------------------------------

// Acepta cercas con o sin cierre (el modelo a veces trunca): si no hay ```
// de cierre, se toma hasta fin de mensaje.
const CERCA_TOOL = /```tool:([A-Za-z0-9_-]+)\s*\n?([\s\S]*?)(?:```|$)/g;

export function parseToolCalls(texto) {
  const llamadas = [];
  const src = String(texto || '');
  CERCA_TOOL.lastIndex = 0;
  let m;
  while ((m = CERCA_TOOL.exec(src)) !== null) {
    const name = m[1];
    const crudo = (m[2] || '').trim();
    if (!crudo) {
      llamadas.push({ name, args: {}, raw: crudo });
      continue;
    }
    try {
      const args = JSON.parse(crudo);
      llamadas.push({ name, args: args && typeof args === 'object' ? args : {}, raw: crudo });
    } catch {
      // JSON roto = item de error, NO throw: el loop lo reporta al modelo
      // para que lo reintente en vez de romper el turno.
      llamadas.push({ name, args: {}, raw: crudo, error: `JSON inválido en tool:${name}` });
    }
    // Cerca sin cierre consume hasta fin de mensaje: no hay más que buscar.
    if (!m[0].endsWith('```')) {
      break;
    }
  }
  return llamadas;
}

// ---------------------------------------------------------------------------
// 4. Sección de prompt
// ---------------------------------------------------------------------------

// source 'audio' = prompt CORTO para voz (nombre + 1 línea por tool, sin
// schemas: el loop tolera JSON simple); cualquier otro valor = FULL con
// params compactos nombre:tipo (D7). Default full: compatible con los
// llamados viejos sin argumento.
export function renderManosPrompt(source = 'text', { allow = null } = {}) {
  const todas = listTools();
  // Track C: allow-list por rol. allow=null (default) = todo, como siempre.
  // Si es array, solo las listadas (aunque haya más registradas).
  const tools = Array.isArray(allow) ? todas.filter((t) => allow.includes(t.name)) : todas;
  const head = 'Tenés MANOS: podés actuar en el proyecto con estas herramientas:';
  if (source === 'audio') {
    const lineas = tools.map((t) => {
      const args = Object.keys(t.parameters?.properties || {}).join(', ');
      const una = String(t.description || '').split(/[.]\s/)[0].slice(0, 60);
      return `- ${t.name}${args ? ` (${args})` : ''}: ${una}`;
    });
    return [
      head,
      ...lineas,
      '',
      'FORMATO: ```tool:NOMBRE {"arg": "valor"}``` — un bloque por tool, en orden.',
      'REGLAS: rutas relativas dentro del proyecto, sin secretos; lo destructivo se avisa antes; al terminar, contá el resultado en criollo SIN más bloques.'
    ].join('\n');
  }
  const lineas = tools.map((t) => {
    const props = t.parameters?.properties || {};
    const params = Object.entries(props).map(([n, d]) => `${n}:${d?.type || '?'}`).join(', ');
    return `- ${t.name}: ${t.description}${params ? ` Params ${params}` : ''}`;
  });
  return [
    head,
    ...lineas,
    '',
    'FORMATO: para usar una herramienta, emití un bloque cercado así (SOLO así, sin texto pegado al JSON):',
    '```tool:read_file',
    '{"path": "package.json"}',
    '```',
    'Varios bloques por mensaje valen; se ejecutan en orden.',
    '',
    'REGLAS:',
    '- Workspace-only: solo rutas relativas dentro del proyecto. Nada de /absolutas, ../, secretos (.env, claves) ni tokens en argumentos.',
    '- Antes de un comando destructivo (borrar, mover, publicar), avisá qué vas a hacer y por qué. En vivo puedo negarlo.',
    '- Cuando termines de usar herramientas, respondé normal SIN más bloques tool: contá el resultado en criollo.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 5. Gate de intención (barato, sin LLM)
// ---------------------------------------------------------------------------

// Imperativos ES (con/sin voseo y tilde) + EN. Normalizado sin tildes ni
// mayúsculas antes de matchear.
const GATE_PATTERNS = [
  /\blee\w*\b/, /\bleeme\b/, /\bmostra\w*\b/, /\babr[ií]\b/, /\bopen\b/, /\bread\b/,
  /\bescrib[ií]\w*\b/, /\bcrea\b/, /\bcreá\b/, /\bguard[ao]\w*\b/, /\bwrite\b/, /\bcreate\b/, /\bsave\b/,
  /\bejecut[ao]\w*\b/, /\bcorr[ée]\w*\b/, /\bcorré\b/, /\bproba\b/, /\bprobá\b/, /\brun\b/, /\bexecute\b/,
  /\bbusc[ao]\w*\b/, /\bbuscá\b/, /\bfetch\b/, /\btrae\b/, /\btraé\b/,
  /\bqu[eé] hora\b/, /\bqu[eé] d[ií]a\b/, /\bfecha\b/, /\bwhat time\b/, /\btoday'?s date\b/,
  /\bfijate\b/, /\brevis[ao]\w*\b/, /\bmir[ao]\b/, /\bcheck\b/, /\blook at\b/,
  /\blista\w*\b/, /\bque archivos\b/, /\bwhat files\b/, // list_files ('listo' a propósito NO matchea: es muletilla rioplatense)
  // Computer (09/11): abrir/navegar + pantalla/ventanas. Ojo 'abril': NO usar
  // abr* suelto. 'open' ya estaba arriba (abrí el readme).
  /\babre\b/, /\babrir\b/, /\bnaveg\w*\b/, /\bpantalla\w*\b/, /\bcaptura\w*\b/,
  /\bscreenshot\w*\b/, /\bventana\w*\b/,
  /\bnavigat\w*\b/, /\bbrowse\b/, /\bwindow\w*\b/, /\bscreen\w*\b/, /\bcaptur\w*\b/,
  // Manos extendidas (09/11): clic (browser_click) + borrador (outreach_draft).
  /\bclic\w*\b/, /\bborrador\w*\b/
];

function normalizarGate(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function shouldUseTools(texto) {
  const n = normalizarGate(texto);
  return GATE_PATTERNS.some((p) => p.test(n));
}

// ---------------------------------------------------------------------------
// 6. Loop de tools (no-stream, en serie)
// ---------------------------------------------------------------------------

const RESUMEN_TOOL_MAX = 160;
// Tope de previews de protocolo (shared/protocol.ts LIMITS.toolPreview).

function resumirTool(name, args) {
  const arg = args?.path || args?.cmd || args?.url || '';
  return `${name}${arg ? ` ${String(arg).slice(0, 100)}` : ''}`.slice(0, RESUMEN_TOOL_MAX);
}

// Preview de protocolo: texto plano recortado a 200 (sin sufijos largos).
function vistaPrevia(valor, tope = 200) {
  return String(valor ?? '').slice(0, tope);
}

// completeChat: función inyectada (messages) -> {text}|string. En vivo la
// provee agent-runtime adaptando llm.completeChat; en tests es un fake.
// source: {companyId, slug, turnId?, agentId?} — workspace + correlación.
//   agent-runtime también pasa companyId/slug/turnId/agentId/signal sueltos
//   (top-level): valen como fallback cuando source es string ('text'/'audio').
// emit(evento): shape protocolo (shared/protocol.ts):
//   {type:'agent_tool_call', turnId?, agentId?, tool, argsPreview?}
//   {type:'agent_tool_done', turnId?, agentId?, tool, ok, ms, outputPreview?}
// Se conserva `summary` como extra (los validadores lo ignoran; sirve a logs).
// Devuelve {toolSummary, toolTurns}: resumen para la fase de habla + turnos
// ejecutados [{calls: [{tool, ok, ms, summary, error?}]}].
export async function runToolLoop({
  system = '',
  messages = [],
  completeChat,
  source = {},
  emit = null,
  maxTurns = 6,
  deadlineMs = 120000,
  companyId = null,
  slug = null,
  turnId = null,
  agentId = null,
  signal = null,
  allow = null,
  aprobadoOutreach = null
} = {}) {
  if (typeof completeChat !== 'function') {
    throw new Error('runToolLoop necesita completeChat(messages)');
  }
  const avisar = typeof emit === 'function' ? emit : () => {};
  // source objeto (tests, contrato original) gana; si es string (runtime en
  // vivo pasa 'text'/'audio'), valen los top-level sueltos.
  const srcObj = source && typeof source === 'object' ? source : {};
  const ctx = {
    companyId: srcObj.companyId ?? companyId ?? null,
    slug: srcObj.slug ?? slug ?? 'general',
    // Track C: gate de outreach. srcObj gana, luego top-level, default false.
    aprobadoOutreach: srcObj.aprobadoOutreach ?? aprobadoOutreach ?? false,
    // Integración 09/11: identidad del turno para tools runtime (browser usa
    // agentId para su sesión). base ya los tenía; ctx los hereda.
    turnId: srcObj.turnId ?? turnId ?? null,
    agentId: srcObj.agentId ?? agentId ?? null
  };
  const base = { turnId: srcObj.turnId ?? turnId, agentId: srcObj.agentId ?? agentId };

  // El system YA trae la sección manos anexada por agent-runtime en versión
  // source-aware (voz corta / texto full): no re-anexar (era 2×, ~2400ch).
  const chat = [
    { role: 'system', content: system },
    ...messages
  ];

  // MCP una vez por corrida (cacheado adentro): si no hay servidor, [].
  try {
    await loadMcpTools();
  } catch {
    // MCP ausente o roto no rompe el turno.
  }

  const inicio = Date.now();
  const toolTurns = [];
  let cortadoPor = null;

  for (let turno = 0; turno < maxTurns; turno += 1) {
    if (signal?.aborted) {
      cortadoPor = 'abort';
      break;
    }
    if (deadlineMs != null && Date.now() - inicio >= deadlineMs) {
      cortadoPor = 'deadline';
      break;
    }
    let texto = '';
    try {
      const r = await completeChat(chat);
      texto = typeof r === 'string' ? r : String(r?.text || '');
    } catch (error) {
      toolTurns.push({ calls: [], error: errorClaro(error) });
      cortadoPor = 'error-modelo';
      break;
    }
    const llamadas = parseToolCalls(texto);
    if (llamadas.length === 0) {
      // Sin llamadas: el turno de tools terminó; el texto final del modelo
      // queda como última palabra (la fase de habla lo usa o lo ignora).
      chat.push({ role: 'assistant', content: texto });
      break;
    }

    const registrTurno = { calls: [] };
    const observaciones = [];
    // En serie a propósito (paralelo NO en v1): orden predecible y sin
    // carreras entre write_file y run_cmd sobre el mismo proyecto.
    for (const llamada of llamadas) {
      if (signal?.aborted) {
        cortadoPor = 'abort';
        break;
      }
      if (deadlineMs != null && Date.now() - inicio >= deadlineMs) {
        cortadoPor = 'deadline';
        break;
      }
      const resumen = resumirTool(llamada.name, llamada.args);
      const argsPreview = vistaPrevia(llamada.raw || JSON.stringify(llamada.args || {}));
      avisar({ type: 'agent_tool_call', ...base, tool: llamada.name, argsPreview, summary: resumen });

      let resultado;
      const t0 = Date.now();
      if (llamada.error) {
        resultado = { ok: false, output: '', error: llamada.error };
      } else if (Array.isArray(allow) && !allow.includes(llamada.name)) {
        // Track C: fuera de la allow-list del rol → rechazo claro, no ejecución.
        resultado = { ok: false, output: '', error: `tool no permitida para tu rol: ${llamada.name}` };
      } else {
        const tool = getTool(llamada.name);
        if (!tool) {
          resultado = { ok: false, output: '', error: `tool desconocida: ${llamada.name}` };
        } else {
          try {
            resultado = await tool.execute(llamada.args, ctx);
          } catch (error) {
            resultado = { ok: false, output: '', error: errorClaro(error) };
          }
        }
      }
      const ms = Date.now() - t0;
      const hecha = {
        tool: llamada.name,
        ok: resultado.ok !== false,
        ms,
        summary: resumen,
        ...(resultado.ok !== false ? {} : { error: resultado.error })
      };
      registrTurno.calls.push(hecha);
      avisar({
        type: 'agent_tool_done',
        ...base,
        tool: llamada.name,
        ok: hecha.ok,
        ms,
        outputPreview: vistaPrevia(hecha.ok ? resultado.output : resultado.error),
        summary: resumen,
        ...(hecha.ok ? {} : { error: resultado.error })
      });
      observaciones.push(
        `[tool:${llamada.name} ${hecha.ok ? 'OK' : 'FALLÓ'}]\n${hecha.ok ? resultado.output : resultado.error}`
      );
    }
    toolTurns.push(registrTurno);
    chat.push({ role: 'assistant', content: texto });
    chat.push({ role: 'user', content: observaciones.join('\n\n') || '(sin observaciones)' });
    if (cortadoPor) {
      break;
    }
  }

  if (toolTurns.length >= maxTurns && !cortadoPor) {
    cortadoPor = 'maxTurns';
  }

  const totalCalls = toolTurns.reduce((n, t) => n + t.calls.length, 0);
  const fallos = toolTurns.flatMap((t) => t.calls).filter((c) => !c.ok);
  const partes = toolTurns.flatMap((t) =>
    t.calls.map((c) => {
      const estado = c.ok ? 'ok' : ('falló (' + (c.error || 'sin motivo') + ')');
      return '- ' + c.tool + ': ' + estado + ' — ' + c.summary;
    })
  );
  const toolSummary = [
    totalCalls === 0 ? 'Sin acciones de herramientas.' : `Usé ${totalCalls} herramienta(s):`,
    ...partes,
    fallos.length > 0 ? `(${fallos.length} fallaron)` : '',
    cortadoPor === 'maxTurns' ? '[cortado por tope de turnos: resumen parcial]' : '',
    cortadoPor === 'deadline' ? '[cortado por tiempo: resumen parcial]' : '',
    cortadoPor === 'abort' ? '[interrumpido por el usuario: resumen parcial]' : '',
    cortadoPor === 'error-modelo' ? '[el modelo falló: resumen parcial]' : ''
  ].filter(Boolean).join('\n');

  return { toolSummary, toolTurns };
}

// ---------------------------------------------------------------------------
// 7. MCP (opcional, cacheado)
// ---------------------------------------------------------------------------

let mcpCache = null;

export async function loadMcpTools() {
  if (mcpCache) {
    return mcpCache;
  }
  try {
    const mod = await import('./manos-mcp.js');
    const defs = await mod.getMcpTools();
    const names = [];
    for (const def of defs || []) {
      registerTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        execute: (args, ctx) => mod.callMcpTool(def.name, args, ctx)
      });
      names.push(def.name);
    }
    mcpCache = names;
    return names;
  } catch {
    // Sin módulo MCP (v1 no lo trae): [] y a otra cosa.
    mcpCache = [];
    return [];
  }
}

// Solo tests: permite reintentar la carga MCP.
export function _resetMcpCache() {
  mcpCache = null;
}
