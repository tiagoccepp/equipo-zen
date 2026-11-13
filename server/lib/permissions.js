// F-04: permisos deny→ask→allow + modos manual/plan/auto (capa agente).
// Tiers por tool + grants (turno/proyecto/siempre) + modos de ejecución.
// Enforcement a nivel harness en runToolLoop (el prompt no decide).

export const TOOL_TIERS = {
  // Lectura / internas: siempre.
  read_file: 'allow',
  list_files: 'allow',
  now: 'allow',
  fetch_url: 'allow',
  task_add: 'allow',
  task_done: 'allow',
  task_list: 'allow',
  plan_propose: 'allow',
  plan_status: 'allow',
  agent_send: 'allow',
  // Escritura / efectos: preguntan.
  write_file: 'ask',
  apply_patch: 'ask',
  run_cmd: 'ask',
  open_url: 'ask',
  window_list: 'ask',
  screenshot: 'ask',
  browser_open: 'ask',
  browser_snapshot: 'ask',
  browser_click: 'ask',
  browser_type: 'ask',
  browser_eval: 'ask',
  browser_shot: 'ask',
  browser_close: 'ask',
  canvas_abrir: 'ask',
  canvas_tokens: 'ask',
  canvas_codigo: 'ask',
  canvas_cerrar: 'ask',
  outreach_draft: 'ask',
  outreach_send: 'ask'
};

export const MODES = ['manual', 'plan', 'auto'];

// A-06: orden de evaluación (fijo, de más a menos restrictivo):
//   1. prohibiciones (deny absoluto, E-22)
//   2. tier deny (hard-deny, policies)
//   3. grants guardados (once/project/always) — NUNCA pisan 1-2
//   4. modo global + nivel proyecto (manual/plan/auto, reversibles)
// Ver checkCall(): el orden del código ES la precedencia (testeado).
export const POLICY_PRESETS = {
  // Solo lectura + internas (todo lo demás niega).
  'read-only': { deny: ['write_file', 'apply_patch', 'run_cmd', 'open_url', 'screenshot', 'browser_open', 'browser_click', 'browser_type', 'browser_eval', 'canvas_codigo', 'outreach_draft', 'outreach_send', 'task_claim'] },
  // Sin shell (lo demás igual).
  'no-shell': { deny: ['run_cmd'] },
  // Sin salida (ni outreach ni posteo).
  'no-outreach': { deny: ['outreach_send', 'outreach_draft'] },
  // Sin red saliente de lectura web (fetch/mcp web siguen por allow? no: deny).
  'no-net': { deny: ['fetch_url', 'open_url'] }
};

let activePolicies = [];

// Aplica un preset (setea tiers a deny). Acumulativo; clearPolicies revierte.
export function applyPolicy(name) {
  const preset = POLICY_PRESETS[name];
  if (!preset) {
    return { ok: false, error: `policy inexistente: ${name}` };
  }
  for (const tool of preset.deny || []) {
    tierOverrides.set(tool, 'deny');
  }
  if (!activePolicies.includes(name)) {
    activePolicies.push(name);
  }
  return { ok: true, policy: name, denied: [...preset.deny] };
}

export function clearPolicies() {
  activePolicies = [];
  // Solo limpia tiers deny puestos por policies: re-marcar todo es caro;
  // v1 honesta: limpia TODOS los overrides (documentado).
  tierOverrides.clear();
  return true;
}

export function listPolicies() {
  return [...activePolicies];
}

export function revokeGrant(id) {
  const i = grants.findIndex((g) => g.id === id);
  if (i === -1) {
    return false;
  }
  grants.splice(i, 1);
  return true;
}

// E-22: reversibilidad — lo auto en nivel 'reversibles'. Irreversible =
// side effects desconocidos o destructivos (pide aprobación).
export const REVERSIBLE_TOOLS = new Set([
  'read_file', 'list_files', 'now', 'fetch_url', 'mcp_search',
  'task_add', 'task_done', 'task_list', 'task_release',
  'plan_propose', 'plan_status', 'agent_send',
  'taste_set', 'taste_list', 'notify_list', 'notify_read',
  'improve_propose', 'improve_status',
  'write_file', 'apply_patch' // sin delete (el delete se detecta abajo)
]);

export function isReversibleCall(tool, args = {}) {
  if (!REVERSIBLE_TOOLS.has(tool)) {
    return false;
  }
  if (tool === 'apply_patch') {
    const patch = String(args?.patch || '');
    if (/^\*\*\* Delete File:/m.test(patch)) {
      return false;
    }
  }
  return true;
}

// E-22: match de prohibiciones (deny gana sobre TODO, incluido grants).
// rows: [{kind, pattern}]. Devuelve la row que matchea o null.
export function matchProhibition(tool, args = {}, rows = []) {
  const a = args || {};
  for (const row of rows || []) {
    const kind = row?.kind;
    const pattern = String(row?.pattern || '').trim();
    if (!kind || !pattern) {
      continue;
    }
    try {
      if (kind === 'tool' && matchPattern(tool, pattern)) {
        return row;
      }
      if (kind === 'cmd' && (tool === 'run_cmd') && matchPattern(String(a.cmd || ''), pattern)) {
        return row;
      }
      if (kind === 'path' && matchPattern(String(a.path || a.patch || ''), pattern)) {
        return row;
      }
      if (kind === 'url' && matchPattern(String(a.url || JSON.stringify(a)), pattern)) {
        return row;
      }
    } catch {
      // Patrón roto: ignorar esa fila, no tumbar el gate.
    }
  }
  return null;
}

// Patrón: glob simple (*, ?) o /regex/flags.
export function matchPattern(value, pattern) {
  const v = String(value || '');
  const p = String(pattern || '').trim();
  if (!p) {
    return false;
  }
  const reMatch = p.match(/^\/(.+)\/([a-z]*)$/);
  if (reMatch) {
    try {
      return new RegExp(reMatch[1], reMatch[2]).test(v);
    } catch {
      return false;
    }
  }
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(v) || v.toLowerCase().includes(p.toLowerCase().replace(/\*/g, ''));
}

// Default 'auto' = conducta histórica (el ask-tier pasa solo). 'manual' y
// 'plan' son opt-in por proyecto (E-22) o global. 'deny' niega en todo modo.
let mode = 'auto';
const tierOverrides = new Map(); // tool -> tier (E-22 los setea por proyecto)
const grants = []; // {tool, match, scope, goalId, uses}
let grantSeq = 0;
const pending = new Map(); // id -> {id, tool, args, goalId, agentId, turnId, at}

export function getMode() {
  return mode;
}

export function setMode(next) {
  if (MODES.includes(next)) {
    mode = next;
    return true;
  }
  return false;
}

export function tierFor(tool) {
  if (tierOverrides.has(tool)) {
    return tierOverrides.get(tool);
  }
  return TOOL_TIERS[tool] || 'ask'; // Desconocida = ask (fail-closed)
}

export function setTier(tool, tier) {
  if (!['allow', 'ask', 'deny'].includes(tier)) {
    return false;
  }
  tierOverrides.set(tool, tier);
  return true;
}

export function clearTiers() {
  tierOverrides.clear();
}

function argsMatch(pattern, args) {
  if (!pattern || Object.keys(pattern).length === 0) {
    return true;
  }
  const a = args || {};
  return Object.entries(pattern).every(([k, v]) => String(a[k] ?? '') === String(v ?? ''));
}

function grantCovers(grant, tool, args, goalId) {
  if (grant.tool !== tool) {
    return false;
  }
  if (!argsMatch(grant.match, args)) {
    return false;
  }
  if (grant.scope === 'project' && grant.goalId !== goalId) {
    return false;
  }
  if (grant.scope === 'once' && !(grant.uses > 0)) {
    return false;
  }
  return true;
}

function consumeGrant(grant) {
  if (grant.scope === 'once') {
    grant.uses -= 1;
    if (grant.uses <= 0) {
      const i = grants.indexOf(grant);
      if (i !== -1) {
        grants.splice(i, 1);
      }
    }
  }
}

// ¿Pasa esta llamada? {verdict:'allow'|'ask'|'deny', grant?}
// Orden: prohibiciones (deny absoluto) > tier deny > grants > nivel+modo.
export function checkCall(tool, args = {}, { goalId = null, planApproved = false, level = null, prohibitions = [] } = {}) {
  const hit = matchProhibition(tool, args, prohibitions);
  if (hit) {
    return { verdict: 'deny', prohibition: hit };
  }
  const tier = tierFor(tool);
  if (tier === 'allow') {
    return { verdict: 'allow' };
  }
  if (tier === 'deny') {
    return { verdict: 'deny' };
  }
  // ask-tier:
  const grant = grants.find((g) => grantCovers(g, tool, args, goalId));
  if (grant) {
    consumeGrant(grant);
    return { verdict: 'allow', grant };
  }
  // E-22: nivel del proyecto (manda el más estricto entre modo global y nivel).
  const effectiveLevel = level || 'auto';
  const strictManual = mode === 'manual' || effectiveLevel === 'pedir-todo';
  if (!strictManual) {
    if (mode === 'auto' && effectiveLevel === 'auto') {
      return { verdict: 'allow', auto: true };
    }
    if (effectiveLevel === 'reversibles' && isReversibleCall(tool, args)) {
      return { verdict: 'allow', reversible: true };
    }
    if (mode === 'plan' && planApproved) {
      return { verdict: 'allow', viaPlan: true };
    }
    // pedir-todo e irreversibles en 'reversibles' caen a ask abajo.
  }
  return { verdict: 'ask' };
}

// Registra un pedido pendiente. Devuelve id (approval-...). userText permite
// re-ejecutar el turno original cuando Tito aprueba por voz.
export function requestApproval({ tool, args, goalId = null, agentId = null, turnId = null, userText = null }) {
  grantSeq += 1;
  const id = `approval-${grantSeq}`;
  pending.set(id, {
    id,
    tool,
    args: args || {},
    goalId,
    agentId,
    turnId,
    userText: userText ? String(userText).slice(0, 500) : null,
    at: new Date().toISOString()
  });
  while (pending.size > 50) {
    pending.delete(pending.keys().next().value);
  }
  return id;
}

export function listPending() {
  return [...pending.values()];
}

export function resolveApproval(id, approve, { scope = 'once', goalId = null, uses = 10 } = {}) {
  const req = pending.get(id);
  if (!req) {
    return { ok: false, error: `aprobación inexistente: ${id}` };
  }
  pending.delete(id);
  if (!approve) {
    return { ok: true, approved: false, tool: req.tool, req };
  }
  const useScope = ['once', 'project', 'always'].includes(scope) ? scope : 'once';
  grantSeq += 1;
  const grant = {
    id: `grant-${grantSeq}`,
    tool: req.tool,
    match: {},
    scope: useScope,
    uses: useScope === 'once' ? Math.max(1, Number(uses) || 1) : Infinity,
    goalId: useScope === 'project' ? (goalId || req.goalId) : null
  };
  grants.push(grant);
  return { ok: true, approved: true, tool: req.tool, grant, req };
}

// Grants directos (voz "dale" sobre pendientes, tests).
export function grantTool(tool, { scope = 'once', goalId = null, match = {}, uses = 10 } = {}) {
  grantSeq += 1;
  const grant = {
    id: `grant-${grantSeq}`, tool, match: match || {}, scope,
    uses: scope === 'once' ? Math.max(1, Number(uses) || 1) : Infinity,
    goalId: scope === 'project' ? goalId : null
  };
  grants.push(grant);
  return grant;
}

export function listGrants() {
  return grants.map((g) => ({ ...g, uses: g.uses === Infinity ? '∞' : g.uses }));
}

export function __resetPermissions() {
  activePolicies = [];
  mode = 'auto'; // default = conducta actual (ask auto-pasa); manual/plan opt-in
  tierOverrides.clear();
  grants.length = 0;
  pending.clear();
  grantSeq = 0;
}
