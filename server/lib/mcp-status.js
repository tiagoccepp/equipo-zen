// T5 — Manager MCP/skills: status PURO, sin spawnear servers.
// Lee config vía readMcpConfig (existe, manos-mcp.js) y skills vía loadSkills.
// alive/tools NUNCA se sondean acá: vienen de un snapshot inyectable que
// main actualiza tras listar (el route POST /api/mcp/reconnect lo refresca).
// Este módulo NO importa McpClient, NO llama getMcpTools/callMcpTool, NO hace spawn.

import { readMcpConfig } from './manos-mcp.js';
import { loadSkills } from './skills.js';

// Snapshot en memoria: { alive: {name: bool}, tools: {name: string[]} }.
// Default vacío = todo configured pero no-vivo (honesto: sin datos no inventamos).
let snapshot = { alive: {}, tools: {} };

function cloneSnapshot(s) {
  const alive = {};
  const tools = {};
  if (s && typeof s === 'object') {
    if (s.alive && typeof s.alive === 'object' && !Array.isArray(s.alive)) {
      for (const [k, v] of Object.entries(s.alive)) {
        if (typeof k === 'string' && k) alive[k] = v === true;
      }
    }
    if (s.tools && typeof s.tools === 'object' && !Array.isArray(s.tools)) {
      for (const [k, v] of Object.entries(s.tools)) {
        if (typeof k === 'string' && k && Array.isArray(v)) {
          tools[k] = v.filter((t) => typeof t === 'string' && t);
        }
      }
    }
  }
  return { alive, tools };
}

/** Main/tests inyectan el estado vivo observado (tras listTools real). */
export function setMcpStatusSnapshot(s) {
  snapshot = cloneSnapshot(s);
  return snapshot;
}

/** Snapshot actual (copia). */
export function getMcpStatusSnapshot() {
  return cloneSnapshot(snapshot);
}

// Solo tests.
export function __resetMcpStatusSnapshot() {
  snapshot = { alive: {}, tools: {} };
}

function skillsSummary(skillsList) {
  const out = [];
  for (const s of skillsList || []) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    const scopes = Array.isArray(s.scopes) && s.scopes.length > 0
      ? [...s.scopes]
      : [typeof s.scope === 'string' && s.scope ? s.scope : 'all'];
    out.push({ name: s.name, scopes });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// getMcpStatus(opts?) → { servers, skills, gaps }.
// opts.config: override de readMcpConfig (tests). opts.skillsList: override
// de loadSkills. opts.snapshot: override puntual (no pisa el global).
// Sin opts: lee config real + skills reales + snapshot global. Nunca throw.
export function getMcpStatus(opts = {}) {
  let config;
  try {
    config = Array.isArray(opts.config) ? opts.config : readMcpConfig();
  } catch {
    config = [];
  }
  let skillsList;
  try {
    skillsList = Array.isArray(opts.skillsList) ? opts.skillsList : loadSkills();
  } catch {
    skillsList = [];
  }
  const snap = opts.snapshot !== undefined ? cloneSnapshot(opts.snapshot) : snapshot;

  const servers = [];
  const seen = new Set();
  for (const entry of config) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    servers.push({
      name: entry.name,
      configured: true,
      alive: snap.alive?.[entry.name] === true,
      tools: Array.isArray(snap.tools?.[entry.name]) ? [...snap.tools[entry.name]] : [],
    });
  }
  // Stale: el snapshot conoce servers que ya no están configurados.
  const staleNames = new Set([
    ...Object.keys(snap.alive || {}),
    ...Object.keys(snap.tools || {}),
  ]);
  for (const name of [...staleNames].sort()) {
    if (seen.has(name)) continue;
    servers.push({
      name,
      configured: false,
      alive: snap.alive?.[name] === true,
      tools: Array.isArray(snap.tools?.[name]) ? [...snap.tools[name]] : [],
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));

  const skills = skillsSummary(skillsList);

  // Gaps honestos: lo que el operador necesita saber, sin inventar.
  const gaps = [];
  if (servers.length === 0) {
    gaps.push('sin servers MCP configurados (PABLO_MCP_SERVERS o ~/.config/equipo-mcp.json vacío)');
  }
  for (const s of servers) {
    if (s.configured && !s.alive) {
      gaps.push(`server "${s.name}" configurado pero no vivo (sin snapshot o caído)`);
    } else if (s.configured && s.alive && s.tools.length === 0) {
      gaps.push(`server "${s.name}" vivo sin tools (listTools vacío o pendiente)`);
    } else if (!s.configured) {
      gaps.push(`server "${s.name}" en snapshot pero ya no configurado`);
    }
  }
  if (skills.length === 0) {
    gaps.push('sin skills cargadas (server/skills vacío)');
  }

  return { servers, skills, gaps };
}

// planReconnect(): documenta los pasos que main implementa en
// POST /api/mcp/reconnect. Puro: no ejecuta nada, no spawnea.
export function planReconnect() {
  return {
    method: 'POST',
    path: '/api/mcp/reconnect',
    steps: [
      '1. readMcpConfig() (manos-mcp.js) para la lista vigente de servers',
      '2. shutdown() (manos-mcp.js) para cerrar hijos viejos sin huérfanos',
      '3. getMcpTools() para re-listar (spawnea bajo demanda, un server caído se saltea)',
      '4. setMcpStatusSnapshot({ alive, tools }) con lo observado (alive=true si listó, tools=names)',
      '5. devolver getMcpStatus() fresco al cliente',
    ],
  };
}
