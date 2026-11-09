// Adaptador MCP -> Manos.
// Lee PABLO_MCP_SERVERS, mantiene un McpClient lazy por server y expone
// getMcpTools()/callMcpTool() con el CONTRATO que manos.js importa dinámicamente.
// Sin dependencias: solo builtins de node.

import { McpClient, DEFAULT_TIMEOUT_MS } from './mcp.js';

// Largo máximo del output que devolvemos por tool (contrato: ≤2000).
export const MAX_MCP_OUTPUT = 2000;
const ENV_SERVERS = 'PABLO_MCP_SERVERS';
// Override solo para tests/debug; si no está, vale DEFAULT_TIMEOUT_MS (20s).
const ENV_TIMEOUT = 'PABLO_MCP_TIMEOUT_MS';

// Caché por proceso: nombre server -> { key, client, starting }
const cache = new Map();
let exitHook = false;

function timeoutMs() {
  const raw = Number(process.env[ENV_TIMEOUT]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

// Parsea PABLO_MCP_SERVERS = JSON [{name, cmd, args}].
// Ausente o inválido -> [] (nunca throw). Entradas inválidas se saltean.
export function readMcpConfig() {
  const raw = process.env[ENV_SERVERS];
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name !== 'string' || !e.name.trim()) continue;
    if (typeof e.cmd !== 'string' || !e.cmd.trim()) continue;
    const args = e.args === undefined ? [] : e.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) continue;
    out.push({ name: e.name.trim(), cmd: e.cmd.trim(), args });
  }
  return out;
}

function entryKey(entry) {
  return entry.cmd + '\n' + entry.args.join('\n');
}

function ensureExitHook() {
  if (exitHook) return;
  exitHook = true;
  // Best-effort: en 'exit' no hay async, solo matar hijos.
  process.on('exit', () => {
    for (const slot of cache.values()) {
      try { slot.client?.closeSync(); } catch { /* best-effort */ }
    }
  });
}

// Cliente lazy por server: se crea y arranca al primer uso, se reusa después.
// Si el server murió o cambió su config, se descarta y se crea de nuevo.
async function getClient(entry) {
  ensureExitHook();
  const key = entryKey(entry);
  let slot = cache.get(entry.name);
  if (slot && (slot.key !== key || !slot.client.isAlive())) {
    cache.delete(entry.name);
    await slot.client.close().catch(() => {});
    slot = undefined;
  }
  if (!slot) {
    const client = new McpClient({ cmd: entry.cmd, args: entry.args, timeoutMs: timeoutMs() });
    slot = { key, client, starting: null };
    cache.set(entry.name, slot);
  }
  if (!slot.starting) {
    slot.starting = slot.client.start().catch(async (err) => {
      // Arranque fallido: sacar del caché para reintentar la próxima.
      if (cache.get(entry.name) === slot) cache.delete(entry.name);
      await slot.client.close().catch(() => {});
      throw err;
    });
  }
  await slot.starting;
  return slot.client;
}

async function dropClient(serverName) {
  const slot = cache.get(serverName);
  if (!slot) return;
  cache.delete(serverName);
  await slot.client.close().catch(() => {});
}

// CONTRATO: lista aplanada de todas las tools de todos los servers.
// Nombres `mcp_<server>_<tool>`. Un server caído se saltea, no rompe el resto.
export async function getMcpTools() {
  const entries = readMcpConfig();
  const out = [];
  for (const entry of entries) {
    let client;
    try {
      client = await getClient(entry);
    } catch {
      continue;
    }
    let tools;
    try {
      tools = await client.listTools();
    } catch {
      // Falló list (timeout/caída): descartar para reintentar luego.
      await dropClient(entry.name);
      continue;
    }
    for (const t of tools) {
      if (!t || typeof t.name !== 'string' || !t.name) continue;
      out.push({
        name: `mcp_${entry.name}_${t.name}`,
        description: typeof t.description === 'string' && t.description
          ? t.description
          : `Tool MCP ${t.name} (server ${entry.name})`,
        parameters: t.inputSchema && typeof t.inputSchema === 'object'
          ? t.inputSchema
          : { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

// CONTRATO: ejecuta `mcp_<server>_<tool>` ruteando por prefijo.
// Siempre resuelve {ok, output:string, error?}; errores -> {ok:false}, nunca throw.
export async function callMcpTool(name, args = {}) {
  try {
    if (typeof name !== 'string' || !name) return fail('nombre de tool inválido');
    const entries = readMcpConfig();
    // Nombre largo primero: desambigua servers donde uno es prefijo de otro.
    const sorted = [...entries].sort((a, b) => b.name.length - a.name.length);
    let entry = null;
    let toolName = null;
    for (const e of sorted) {
      const prefix = `mcp_${e.name}_`;
      if (name.startsWith(prefix) && name.length > prefix.length) {
        entry = e;
        toolName = name.slice(prefix.length);
        break;
      }
    }
    if (!entry) return fail(`tool desconocida: ${name}`);
    const client = await getClient(entry);
    let res;
    try {
      res = await client.callTool(toolName, args ?? {});
    } catch (err) {
      // Server caído a mitad de llamada: descartar para reintentar luego.
      await dropClient(entry.name);
      throw err;
    }
    // MCP marca errores de tool con isError:true (el transporte anduvo bien).
    if (res && res.isError) {
      return { ok: false, output: '', error: truncate(stringifyResult(res), 500) };
    }
    return { ok: true, output: truncate(stringifyResult(res), MAX_MCP_OUTPUT) };
  } catch (err) {
    return fail(err?.message ?? String(err));
  }
}

function fail(error) {
  return { ok: false, output: '', error };
}

// MCP devuelve {content:[{type:'text',text}, ...]}; lo aplanamos a string.
// Cualquier otra forma -> JSON.
function stringifyResult(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  const content = res.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else {
        try { parts.push(JSON.stringify(item)); } catch { parts.push(String(item)); }
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(res);
  } catch {
    return String(res);
  }
}

function truncate(s, max) {
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) : s;
}

// Cierra todos los clientes cacheados (tests y apagado ordenado).
export async function shutdown() {
  const slots = [...cache.values()];
  cache.clear();
  for (const slot of slots) {
    try {
      await slot.client.close();
    } catch { /* best-effort */ }
  }
}
