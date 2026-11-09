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

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { clasificarComando, ejecutar } from './herramientas.js';
import { projectDir, safeWorkspacePath } from './workforce.js';

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

export function renderManosPrompt() {
  const lineas = listTools().map(
    (t) => `- ${t.name}: ${t.description} Parámetros: ${JSON.stringify(t.parameters.properties || {})}`
  );
  return [
    'Tenés MANOS: podés actuar en el proyecto con estas herramientas:',
    ...lineas,
    '',
    'FORMATO: para usar una herramienta, emití un bloque cercado así (SOLO así, sin texto pegado al JSON):',
    '```tool:read_file',
    '{"path": "package.json"}',
    '```',
    'Varios bloques por mensaje valen; se ejecutan en orden.',
    '',
    'REGLAS:',
    '- Workspace-only: solo rutas relativas dentro del proyecto. Nada de /absolutas, ../ ni secretos (.env, claves).',
    '- Nunca pongas secretos, tokens ni contraseñas en los argumentos.',
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
  /\bfijate\b/, /\brevis[ao]\w*\b/, /\bmir[ao]\b/, /\bcheck\b/, /\blook at\b/
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
  signal = null
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
    slug: srcObj.slug ?? slug ?? 'general'
  };
  const base = { turnId: srcObj.turnId ?? turnId, agentId: srcObj.agentId ?? agentId };

  const chat = [
    { role: 'system', content: [system, renderManosPrompt()].filter(Boolean).join('\n\n') },
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
