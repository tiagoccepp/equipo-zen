// Adaptador MCP -> Manos.
// Lee PABLO_MCP_SERVERS, mantiene un McpClient lazy por server y expone
// getMcpTools()/callMcpTool() con el CONTRATO que manos.js importa dinámicamente.
// Sin dependencias: solo builtins de node.

import { McpClient, DEFAULT_TIMEOUT_MS } from './mcp.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

// Path del config por archivo (fallback cuando PABLO_MCP_SERVERS ausente).
// Usa $HOME primero para permitir override en tests.
function configFilePath() {
  const h = process.env.HOME || homedir();
  return join(h, '.config', 'equipo-mcp.json');
}

// Valida/normaliza array [{name, cmd, args?, env?}]. Entradas inválidas se saltean.
// `env` opcional: objeto plano string->string.
function normalizeEntries(parsed) {
  const out = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name !== 'string' || !e.name.trim()) continue;
    if (typeof e.cmd !== 'string' || !e.cmd.trim()) continue;
    const args = e.args === undefined ? [] : e.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) continue;
    let env;
    if (e.env !== undefined) {
      if (!e.env || typeof e.env !== 'object' || Array.isArray(e.env)) continue;
      const kv = Object.entries(e.env);
      if (!kv.every(([k, v]) => typeof k === 'string' && typeof v === 'string')) continue;
      env = {};
      for (const [k, v] of kv) env[k] = v;
    }
    out.push({ name: e.name.trim(), cmd: e.cmd.trim(), args, ...(env ? { env } : {}) });
  }
  return out;
}

// Parsea PABLO_MCP_SERVERS = JSON [{name, cmd, args?, env?}].
// Si ausente (unset/vacío), fallback a ~/.config/equipo-mcp.json (mismo schema).
// Ausente o inválido -> [] (nunca throw). Entradas inválidas se saltean.
export function readMcpConfig() {
  const raw = process.env[ENV_SERVERS];
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return normalizeEntries(parsed);
  }
  try {
    const content = readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return normalizeEntries(parsed);
  } catch {
    return [];
  }
}

function entryKey(entry) {
  return entry.cmd + '\n' + entry.args.join('\n') + '\n' + JSON.stringify(entry.env ?? {});
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
    const client = new McpClient({ cmd: entry.cmd, args: entry.args, timeoutMs: timeoutMs(), env: entry.env });
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

// F-05: catálogo ESTÁTICO de servers conocidos (conocimiento curado, no
// spawn). El search no prende ningún proceso; ensure() prende SOLO el
// server con matches. needsKey = figura igual (el search avisa).
export const MCP_STATIC_CATALOG = [
  { server: 'fs', needsKey: false, tools: [
    ['read_text_file', 'Lee un archivo de texto (root permitido)'],
    ['read_media_file', 'Lee imagen/audio como base64'],
    ['read_multiple_files', 'Lee varios archivos de una vez'],
    ['write_file', 'Escribe un archivo (root permitido)'],
    ['append_file', 'Agrega al final de un archivo'],
    ['list_directory', 'Lista un directorio'],
    ['search_files', 'Busca archivos por patrón'],
    ['get_file_info', 'Metadata de un archivo']
  ] },
  { server: 'fetch', needsKey: false, tools: [
    ['fetch', 'Trae una URL como markdown limpio']
  ] },
  { server: 'git', needsKey: false, tools: [
    ['git_status', 'Estado del repo'],
    ['git_diff', 'Diff de cambios'],
    ['git_log', 'Historial de commits'],
    ['git_add', 'Agrega archivos al stage'],
    ['git_commit', 'Crea un commit'],
    ['git_branch', 'Ramas: listar/crear']
  ] },
  { server: 'hora', needsKey: false, tools: [
    ['get_current_time', 'Hora actual por zona'],
    ['convert_time', 'Convierte entre zonas horarias'],
    ['get_time_ago', 'Hace cuánto fue un timestamp']
  ] },
  { server: 'sqlite', needsKey: false, tools: [
    ['read_query', 'SELECT sobre el .db'],
    ['write_query', 'Escritura SQL (cuidado)'],
    ['list_tables', 'Tablas del .db']
  ] },
  { server: 'memoria', needsKey: false, tools: [
    ['create_entities', 'Crea nodos de memoria'],
    ['search_nodes', 'Busca en el grafo'],
    ['add_observations', 'Agrega observaciones'],
    ['create_relations', 'Relaciona nodos']
  ] },
  { server: 'pensar', needsKey: false, tools: [
    ['sequentialthinking', 'Razonamiento paso a paso encadenado']
  ] },
  { server: 'brave', needsKey: true, tools: [
    ['brave_web_search', 'Búsqueda web'],
    ['brave_image_search', 'Búsqueda de imágenes'],
    ['brave_news_search', 'Noticias'],
    ['brave_video_search', 'Videos']
  ] },
  { server: 'tavily', needsKey: true, tools: [
    ['tavily_search', 'Búsqueda web con IA'],
    ['tavily_extract', 'Extrae contenido de URLs'],
    ['tavily_crawl', 'Crawlea un sitio']
  ] },
  { server: 'docs', needsKey: true, tools: [
    ['resolve-library-id', 'Resuelve id de librería'],
    ['get-library-docs', 'Docs actualizadas de una lib']
  ] },
  { server: 'scrape', needsKey: true, tools: [
    ['scrape', 'Scrapea una URL (JS incluido)'],
    ['crawl', 'Crawlea + scrapea'],
    ['extract', 'Extrae datos con esquema']
  ] },
  { server: 'github', needsKey: true, tools: [
    ['search_repositories', 'Busca repos'],
    ['get_file_contents', 'Lee archivos de un repo'],
    ['create_issue', 'Crea un issue'],
    ['list_issues', 'Lista issues']
  ] },
  { server: 'slack', needsKey: true, tools: [
    ['list_channels', 'Canales del workspace'],
    ['post_message', 'Publica un mensaje'],
    ['read_messages', 'Lee mensajes']
  ] }
];

// Búsqueda pura sobre el catálogo (cero procesos). Solo servers
// CONFIGURADOS (los demás ni se mencionan: no existen acá).
export function searchMcpCatalog(query, { configured = null, max = 5 } = {}) {
  const words = String(query || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ' ')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) {
    return [];
  }
  const only = configured ? new Set(configured) : null;
  const scored = [];
  for (const entry of MCP_STATIC_CATALOG) {
    if (only && !only.has(entry.server)) {
      continue;
    }
    for (const [tool, desc] of entry.tools) {
      const hay = `${tool} ${desc} ${entry.server}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) {
          score += w.length > 5 ? 2 : 1;
        }
      }
      if (score > 0) {
        scored.push({ server: entry.server, tool, name: `mcp_${entry.server}_${tool}`, description: desc, needsKey: entry.needsKey, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

// Prende (si hace falta) + lista + registra las tools pedidas. Solo toca
// los servers involucrados — el resto ni se entera (diferido real).
export async function ensureMcpTools(names) {
  const wanted = [...new Set((names || []).filter((n) => typeof n === 'string' && n.startsWith('mcp_')))];
  if (wanted.length === 0) {
    return [];
  }
  const entries = new Map(readMcpConfig().map((e) => [e.name, e]));
  const byServer = new Map();
  for (const full of wanted) {
    const rest = full.slice(4);
    // server = prefijo más largo que matchee un server configurado.
    let found = null;
    for (const server of entries.keys()) {
      if (rest === server || rest.startsWith(`${server}_`)) {
        if (!found || server.length > found.length) {
          found = server;
        }
      }
    }
    if (found) {
      if (!byServer.has(found)) {
        byServer.set(found, []);
      }
      byServer.get(found).push(full);
    }
  }
  const registered = [];
  const { registerTool } = await import('./manos.js');
  for (const [server, tools] of byServer) {
    let client;
    try {
      client = await getClient(entries.get(server));
    } catch {
      continue;
    }
    let live;
    try {
      live = await client.listTools();
    } catch {
      await dropClient(server);
      continue;
    }
    const liveByName = new Map((live || []).map((x) => [x?.name, x]));
    for (const full of tools) {
      const short = full.slice(4 + server.length + 1);
      const def = liveByName.get(short);
      if (!def) {
        continue;
      }
      try {
        registerTool({
          name: full,
          description: typeof def.description === 'string' && def.description
            ? def.description
            : `Tool MCP ${short} (server ${server})`,
          parameters: def.inputSchema && typeof def.inputSchema === 'object'
            ? def.inputSchema
            : { type: 'object', properties: {} },
          execute: (args) => callMcpTool(full, args || {})
        });
        registered.push(full);
      } catch {
        // Ya registrada o inválida: seguir.
      }
    }
  }
  return registered;
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
